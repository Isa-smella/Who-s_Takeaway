const cloud = require('wx-server-sdk')
const crypto = require('crypto')
cloud.init({ env: cloud.DYNAMIC_CURRENT_ENV })
const db = cloud.database()
const _ = db.command
const ACTIVE_ORDER_STATUSES = ['PENDING', 'IN_PROGRESS', 'ONSITE', 'MANUAL_UNLOCK_COMPLETED', 'SELF_CHECK_PASSED']
const CHECK_KEYS = ['electronicLock', 'wiring', 'driver', 'power']
const OCCUPIED_CLEAR_CONFIRM_WINDOW_MS = 5 * 60 * 1000

async function requireManager() {
  const { OPENID } = cloud.getWXContext()
  const users = await db.collection('users').where({ openid: OPENID, status: 'ACTIVE' }).limit(1).get()
  const user = users.data[0]
  if (!user || !['ADMIN', 'DEVELOPER'].includes(user.role)) throw new Error('ROLE_FORBIDDEN')
  const legal = (await db.collection('systemConfig').doc('legal-current').get()).data
  const consent = await db.collection('privacyConsents').where({ userId: user._id, agreementVersion: legal.agreementVersion, privacyVersion: legal.privacyVersion }).limit(1).get()
  if (!consent.data[0]) throw new Error('PRIVACY_CONSENT_REQUIRED')
  return user
}
function normalizeCabinet(data = {}, existingId = '') {
  const id = String(data.id || existingId || '').trim().toUpperCase()
  const name = String(data.name || '').trim()
  const locationName = String(data.locationName || '').trim()
  const bleIdentifier = String(data.bleIdentifier || '').trim()
  const lockerCount = Number(data.lockerCount)
  if (!/^[A-Z0-9][A-Z0-9._:-]{1,63}$/.test(id)) throw new Error('CABINET_ID_INVALID')
  if (!name) throw new Error('CABINET_NAME_REQUIRED')
  if (!locationName) throw new Error('CABINET_LOCATION_REQUIRED')
  if (!bleIdentifier) throw new Error('BLE_IDENTIFIER_REQUIRED')
  if (!Number.isInteger(lockerCount) || lockerCount < 1 || lockerCount > 200) throw new Error('LOCKER_COUNT_INVALID')
  return { id, name, locationName, bleIdentifier, bluetoothDeviceId: bleIdentifier, lockerCount, notes: String(data.notes || '').trim().slice(0, 300) }
}
function lockerDocId(cabinetId, lockerId) { return `${cabinetId}-${String(lockerId).padStart(3, '0')}` }
function bleReservationId(value) { return crypto.createHash('sha256').update(value).digest('hex') }
async function audit(transaction, manager, action, cabinetId, lockerId, detail = {}, result = 'SUCCESS', recordId = null) {
  const id = `operation-${Date.now()}-${crypto.randomBytes(4).toString('hex')}`
  await transaction.collection('operationLogs').doc(id).set({ data: { userId: manager._id, role: manager.role, cabinetId, lockerId: lockerId || null, recordId, action, result, detail, createdAt: new Date().toISOString() } })
}
async function activeOrders(cabinetId, lockerId) {
  const query = { cabinetId, status: _.in(ACTIVE_ORDER_STATUSES) }
  const result = await db.collection('maintenanceWorkOrders').where(query).limit(100).get()
  return result.data.filter(item => lockerId === null ? item.type === 'CABINET' : item.type === 'LOCKER' && Number(item.lockerId) === Number(lockerId))
}
function readyForRestore(order, target = null) {
  if (!order || !order.selfCheckPassedAt) throw new Error('MAINTENANCE_SELF_CHECK_REQUIRED')
  if (target && !target.healthCheckPassedAt) throw new Error('MAINTENANCE_SELF_CHECK_REQUIRED')
  const requiresInspection = order.requiresInspection !== undefined ? order.requiresInspection === true : order.source !== 'MANUAL_MAINTENANCE'
  if (requiresInspection && !CHECK_KEYS.every(key => order.inspection && order.inspection[key] === 'NORMAL')) throw new Error('MAINTENANCE_INSPECTION_REQUIRED')
  if (order.recordId && order.issueId && !order.manualUnlockCompletedAt) throw new Error('EMERGENCY_PICKUP_HANDOVER_REQUIRED')
}
async function revokeAuthorizations(transaction, cabinetId, lockerId, manager, reason, now) {
  const result = await transaction.collection('unlockAuthorizations').where({ cabinetId, status: 'UNUSED' }).get()
  for (const item of result.data.filter(auth => lockerId === null || Number(auth.lockerId) === Number(lockerId))) {
    await transaction.collection('unlockAuthorizations').doc(item._id).update({ data: { status: 'REVOKED', revokedAt: now, revokedBy: manager._id, revocationReason: reason } })
  }
}
async function resolveOrders(transaction, orders, manager, now) {
  for (const order of orders) await transaction.collection('maintenanceWorkOrders').doc(order._id).update({ data: { status: 'RESOLVED', resolvedAt: now, resolvedBy: manager._id, updatedAt: now } })
}
async function createManualOrder(transaction, cabinetId, lockerId, manager, now) {
  const existing = await transaction.collection('maintenanceWorkOrders').where({ cabinetId, status: _.in(ACTIVE_ORDER_STATUSES) }).get()
  const found = existing.data.find(item => lockerId === null ? item.type === 'CABINET' : item.type === 'LOCKER' && Number(item.lockerId) === Number(lockerId))
  if (found) {
    const patch = { requiresSelfCheck: true, requiresInspection: found.requiresInspection !== undefined ? found.requiresInspection === true : found.source !== 'MANUAL_MAINTENANCE', updatedAt: now }
    await transaction.collection('maintenanceWorkOrders').doc(found._id).update({ data: patch })
    return { ...found, ...patch }
  }
  const id = `maintenance-${cabinetId}-${lockerId || 'cabinet'}-${Date.now()}`
  const order = { type: lockerId === null ? 'CABINET' : 'LOCKER', cabinetId, lockerId, recordId: null, issueId: null, source: 'MANUAL_MAINTENANCE', reason: 'MANUAL_MAINTENANCE', faultCode: null, requiresSelfCheck: true, requiresInspection: false, status: 'PENDING', createdBy: manager._id, createdAt: now, updatedAt: now }
  await transaction.collection('maintenanceWorkOrders').doc(id).set({ data: order })
  return { ...order, _id: id }
}
async function ensureCabinetFaultOrder(transaction, cabinetId, cabinet, manager, now) {
  const existing = await transaction.collection('maintenanceWorkOrders').where({ cabinetId, status: _.in(ACTIVE_ORDER_STATUSES) }).get()
  const found = existing.data.find(item => (item.type || item.targetType) === 'CABINET' || !item.lockerId)
  if (found) {
    const patch = { source: 'DEVICE_FAULT', reason: 'CABINET_HARDWARE_FAULT', faultCode: cabinet.faultCode || found.faultCode || 'CONTROLLER_FAULT', requiresSelfCheck: true, requiresInspection: true, updatedAt: now }
    await transaction.collection('maintenanceWorkOrders').doc(found._id).update({ data: patch })
    return { ...found, ...patch }
  }
  const id = `maintenance-${cabinetId}-cabinet-${Date.now()}`
  const order = {
    type: 'CABINET', cabinetId, lockerId: null, recordId: null, issueId: null,
    source: 'DEVICE_FAULT', reason: 'CABINET_HARDWARE_FAULT', faultCode: cabinet.faultCode || 'CONTROLLER_FAULT',
    requiresSelfCheck: true, requiresInspection: true, status: 'PENDING', createdBy: manager._id, createdAt: now, updatedAt: now
  }
  await transaction.collection('maintenanceWorkOrders').doc(id).set({ data: order })
  return { ...order, _id: id }
}
function hasActiveFault(target = {}) {
  const active = target.faultActive === true || target.faultActive === 1 || target.faultActive === 'true'
  if (!active) return false
  // 旧版本的现场交付逻辑可能在自检通过后再次写入 faultActive=true。
  // 只有自检之后又上报的故障才算当前故障；faultCode/faultReportedAt 本身
  // 可以继续作为历史审计信息保留。
  const passedAt = Date.parse(target.healthCheckPassedAt || '')
  const reportedAt = Date.parse(target.faultReportedAt || '')
  if (Number.isFinite(passedAt) && Number.isFinite(reportedAt) && passedAt >= reportedAt) return false
  return true
}

async function createCabinet(manager, input) {
  const data = normalizeCabinet(input)
  let existing = null
  try { existing = (await db.collection('cabinets').doc(data.id).get()).data } catch (error) {}
  if (existing) throw new Error('CABINET_ID_EXISTS')
  const duplicateBle = await db.collection('cabinets').where({ bleIdentifier: data.bleIdentifier }).limit(1).get()
  if (duplicateBle.data[0]) throw new Error('BLE_IDENTIFIER_EXISTS')
  const reservationId = bleReservationId(data.bleIdentifier)
  const now = new Date().toISOString()
  const transaction = await db.startTransaction()
  try {
    let reservation
    try { reservation = (await transaction.collection('bleIdentifiers').doc(reservationId).get()).data } catch (error) {}
    if (reservation) throw new Error('BLE_IDENTIFIER_EXISTS')
    await transaction.collection('bleIdentifiers').doc(reservationId).set({ data: { cabinetId: data.id, bleIdentifier: data.bleIdentifier, createdAt: now } })
    await transaction.collection('cabinets').doc(data.id).set({ data: { ...data, status: 'PROVISIONING', maintenanceSource: null, faultActive: false, faultCode: null, createdAt: now, updatedAt: now, deletedAt: null, createdBy: manager._id } })
    await transaction.commit()
  } catch (error) { await transaction.rollback(); throw error }
  const createdLockerIds = []
  try {
    for (let start = 1; start <= data.lockerCount; start += 20) {
      const tasks = []
      for (let id = start; id < Math.min(start + 20, data.lockerCount + 1); id += 1) {
        const docId = lockerDocId(data.id, id)
        createdLockerIds.push(docId)
        tasks.push(db.collection('lockers').doc(docId).set({ data: { cabinetId: data.id, id, controllerId: id <= 6 ? 'A' : 'B', status: 'EMPTY', doorStatus: 'CLOSED', enabled: true, currentRecordId: null, storedAt: null, maintenanceSource: null, previousStatus: null, faultActive: false, consecutiveUnlockFailures: 0, totalUnlockAttempts: 0, totalUnlockSuccesses: 0, totalUnlockFailures: 0, createdAt: now, updatedAt: now } }))
      }
      await Promise.all(tasks)
    }
    const finalize = await db.startTransaction()
    try {
      await finalize.collection('cabinets').doc(data.id).update({ data: { status: 'ACTIVE', updatedAt: new Date().toISOString() } })
      await audit(finalize, manager, 'CABINET_CREATED', data.id, null, { name: data.name, locationName: data.locationName, lockerCount: data.lockerCount, bleIdentifier: data.bleIdentifier })
      await finalize.commit()
    } catch (error) { await finalize.rollback(); throw error }
    return { ...data, status: 'ACTIVE', createdAt: now, updatedAt: now, deletedAt: null }
  } catch (error) {
    await Promise.all(createdLockerIds.map(id => db.collection('lockers').doc(id).remove().catch(() => null)))
    await db.collection('cabinets').doc(data.id).remove().catch(() => null)
    await db.collection('bleIdentifiers').doc(reservationId).remove().catch(() => null)
    throw new Error('CABINET_PROVISIONING_FAILED')
  }
}

exports.main = async event => {
  try {
    const manager = await requireManager()
    const action = String(event.action || '')
    if (action === 'CREATE_CABINET') return { ok: true, data: await createCabinet(manager, event.data) }
    const cabinetId = String(event.cabinetId || '').trim().toUpperCase()
    if (!cabinetId) throw new Error('CABINET_ID_REQUIRED')
    const cabinet = (await db.collection('cabinets').doc(cabinetId).get()).data
    if (!cabinet) throw new Error('CABINET_NOT_FOUND')
    if (action === 'UPDATE_CABINET') {
      const input = normalizeCabinet({ ...cabinet, ...event.data, id: cabinetId }, cabinetId)
      if (input.lockerCount !== Number(cabinet.lockerCount)) throw new Error('LOCKER_COUNT_IMMUTABLE')
      const duplicate = await db.collection('cabinets').where({ bleIdentifier: input.bleIdentifier }).limit(2).get()
      if (duplicate.data.some(item => item._id !== cabinetId)) throw new Error('BLE_IDENTIFIER_EXISTS')
      const transaction = await db.startTransaction()
      try {
        if (input.bleIdentifier !== cabinet.bleIdentifier) {
          const newReservationId = bleReservationId(input.bleIdentifier)
          let reservation
          try { reservation = (await transaction.collection('bleIdentifiers').doc(newReservationId).get()).data } catch (error) {}
          if (reservation && reservation.cabinetId !== cabinetId) throw new Error('BLE_IDENTIFIER_EXISTS')
          await transaction.collection('bleIdentifiers').doc(newReservationId).set({ data: { cabinetId, bleIdentifier: input.bleIdentifier, createdAt: new Date().toISOString() } })
          await transaction.collection('bleIdentifiers').doc(bleReservationId(cabinet.bleIdentifier)).remove()
        }
        await transaction.collection('cabinets').doc(cabinetId).update({ data: { name: input.name, locationName: input.locationName, bleIdentifier: input.bleIdentifier, bluetoothDeviceId: input.bleIdentifier, notes: input.notes, updatedAt: new Date().toISOString() } })
        await audit(transaction, manager, 'CABINET_UPDATED', cabinetId, null, { before: { name: cabinet.name, locationName: cabinet.locationName, bleIdentifier: cabinet.bleIdentifier }, after: input })
        await transaction.commit()
      } catch (error) { await transaction.rollback(); throw error }
      return { ...cabinet, ...input, id: cabinetId }
    }
    const lockerId = event.lockerId === undefined ? null : Number(event.lockerId)
    let locker = null
    if (lockerId !== null) {
      const lockers = await db.collection('lockers').where({ cabinetId, id: lockerId }).limit(1).get()
      locker = lockers.data[0]
      if (!locker) throw new Error('LOCKER_NOT_FOUND')
    }
    const orders = await activeOrders(cabinetId, lockerId)
    const now = new Date().toISOString()
    const transaction = await db.startTransaction()
    try {
      let output
      if (action === 'CREATE_OCCUPIED_CLEAR_AUTHORIZATION') {
        const currentCabinet = (await transaction.collection('cabinets').doc(cabinetId).get()).data
        const currentLocker = (await transaction.collection('lockers').doc(locker._id).get()).data
        if (!currentCabinet || currentCabinet.status !== 'ACTIVE') throw new Error('CABINET_NOT_ACTIVE')
        if (!currentLocker || currentLocker.enabled === false) throw new Error('LOCKER_DISABLED')
        if (currentLocker.status !== 'OCCUPIED' || !currentLocker.currentRecordId) throw new Error('LOCKER_NOT_OCCUPIED')
        const waitingRecords = await transaction.collection('depositRecords').where({ cabinetId, lockerId, status: 'WAITING_PICKUP' }).limit(2).get()
        if (waitingRecords.data.length > 1) throw new Error('LOCKER_MULTIPLE_WAITING_RECORDS')
        const record = waitingRecords.data[0]
        if (!record || record._id !== currentLocker.currentRecordId) throw new Error('LOCKER_WAITING_RECORD_MISMATCH')
        const previous = await transaction.collection('unlockAuthorizations').where({ cabinetId, status: 'UNUSED' }).get()
        for (const item of previous.data.filter(item => item.userId === manager._id && Number(item.lockerId) === lockerId && item.source === 'ADMIN_OCCUPIED_CLEAR')) {
          await transaction.collection('unlockAuthorizations').doc(item._id).update({ data: { status: 'REVOKED', revokedAt: now, revokedBy: manager._id, revocationReason: 'SUPERSEDED' } })
        }
        const authorizationId = `unlock-auth-${Date.now()}-${crypto.randomBytes(5).toString('hex')}`
        const authorization = {
          userId: manager._id, cabinetId, lockerId, recordId: record._id, source: 'ADMIN_OCCUPIED_CLEAR',
          reason: 'ADMIN_VERIFY_PHYSICALLY_EMPTY', issuedBy: manager._id, issuedByRole: manager.role,
          token: `CLOUD-UA-${crypto.randomBytes(24).toString('hex')}`, nonce: crypto.randomBytes(16).toString('hex'),
          protocolVersion: 'MOCK_V1', command: 'OPEN_LOCK', maintenanceOrderId: null,
          createdAt: now, expiresAt: new Date(Date.now() + 5 * 60 * 1000).toISOString(), status: 'UNUSED', usedAt: null
        }
        await transaction.collection('unlockAuthorizations').doc(authorizationId).set({ data: authorization })
        await audit(transaction, manager, 'ADMIN_OPEN_OCCUPIED_LOCKER', cabinetId, lockerId, { authorizationId, stage: 'AUTHORIZATION_CREATED' }, 'SUCCESS', record._id)
        output = { ...authorization, id: authorizationId }
      } else if (action === 'CLEAR_OCCUPIED_LOCKER_AS_EMPTY') {
        const currentCabinet = (await transaction.collection('cabinets').doc(cabinetId).get()).data
        const currentLocker = (await transaction.collection('lockers').doc(locker._id).get()).data
        if (!currentCabinet || currentCabinet.status !== 'ACTIVE') throw new Error('CABINET_NOT_ACTIVE')
        if (!currentLocker || currentLocker.enabled === false) throw new Error('LOCKER_DISABLED')
        const authorizationId = String(event.authorizationId || '')
        let authorization
        try { authorization = (await transaction.collection('unlockAuthorizations').doc(authorizationId).get()).data } catch (error) {}
        if (!authorization || authorization.source !== 'ADMIN_OCCUPIED_CLEAR' || authorization.status !== 'USED' || authorization.userId !== manager._id || authorization.cabinetId !== cabinetId || Number(authorization.lockerId) !== lockerId || authorization.clearConfirmedAt) throw new Error('OCCUPIED_CLEAR_AUTHORIZATION_INVALID')
        const usedAt = new Date(authorization.usedAt).getTime()
        if (!Number.isFinite(usedAt) || usedAt > Date.now() + 60 * 1000 || Date.now() - usedAt > OCCUPIED_CLEAR_CONFIRM_WINDOW_MS) throw new Error('OCCUPIED_CLEAR_AUTHORIZATION_INVALID')
        if (currentLocker.status !== 'OCCUPIED' || currentLocker.currentRecordId !== authorization.recordId) throw new Error('LOCKER_WAITING_RECORD_MISMATCH')
        let record
        try { record = (await transaction.collection('depositRecords').doc(authorization.recordId).get()).data } catch (error) {}
        if (!record || record.status !== 'WAITING_PICKUP' || record.cabinetId !== cabinetId || Number(record.lockerId) !== lockerId) throw new Error('LOCKER_WAITING_RECORD_MISMATCH')
        const recordUpdate = { status: 'ADMIN_CLEARED', adminClearedAt: now, adminClearedBy: manager._id, closureReason: 'PHYSICALLY_EMPTY', updatedAt: now }
        await transaction.collection('depositRecords').doc(authorization.recordId).update({ data: recordUpdate })
        await transaction.collection('lockers').doc(currentLocker._id).update({ data: { status: 'EMPTY', currentRecordId: null, storedAt: null, maintenanceSource: null, previousStatus: null, updatedAt: now } })
        await transaction.collection('unlockAuthorizations').doc(authorizationId).update({ data: { clearConfirmedAt: now } })
        await revokeAuthorizations(transaction, cabinetId, lockerId, manager, 'ADMIN_CONFIRMED_PHYSICALLY_EMPTY', now)
        await audit(transaction, manager, 'ADMIN_CLEAR_OCCUPIED_LOCKER', cabinetId, lockerId, { authorizationId, beforeStatus: 'OCCUPIED', afterStatus: 'EMPTY', closureReason: 'PHYSICALLY_EMPTY' }, 'SUCCESS', authorization.recordId)
        output = { locker: { ...currentLocker, id: lockerId, status: 'EMPTY', currentRecordId: null, storedAt: null, maintenanceSource: null, previousStatus: null }, record: { ...record, ...recordUpdate, id: authorization.recordId } }
      } else if (action === 'SET_CABINET_MAINTENANCE') {
        if (cabinet.status === 'PROVISIONING') throw new Error('CABINET_PROVISIONING')
        const faultActive = hasActiveFault(cabinet)
        await transaction.collection('cabinets').doc(cabinetId).update({ data: { status: 'MAINTENANCE', deletedAt: null, maintenanceSource: faultActive ? 'HARDWARE_FAULT' : 'MANUAL', healthCheckPassedAt: null, updatedAt: now } })
        if (faultActive) await ensureCabinetFaultOrder(transaction, cabinetId, cabinet, manager, now)
        else await createManualOrder(transaction, cabinetId, null, manager, now)
        await revokeAuthorizations(transaction, cabinetId, null, manager, 'CABINET_MAINTENANCE', now)
        await audit(transaction, manager, 'CABINET_SET_MAINTENANCE', cabinetId, null, { migratedFromDisabled: cabinet.status === 'DISABLED' })
        output = { ...cabinet, id: cabinetId, status: 'MAINTENANCE', deletedAt: null, maintenanceSource: faultActive ? 'HARDWARE_FAULT' : 'MANUAL' }
      } else if (action === 'RESTORE_CABINET') {
        if (cabinet.status === 'DISABLED') throw new Error('CABINET_DISABLED')
        if (cabinet.status !== 'MAINTENANCE') throw new Error('CABINET_NOT_IN_MAINTENANCE')
        const currentCabinet = (await transaction.collection('cabinets').doc(cabinetId).get()).data || cabinet
        if (hasActiveFault(currentCabinet)) throw new Error('CABINET_HARDWARE_FAULT_ACTIVE')
        readyForRestore(orders[0], currentCabinet)
        await transaction.collection('cabinets').doc(cabinetId).update({ data: { status: 'ACTIVE', maintenanceSource: null, faultActive: false, faultCode: null, faultReportedAt: null, updatedAt: now } })
        await resolveOrders(transaction, orders, manager, now)
        await audit(transaction, manager, 'CABINET_RESTORED', cabinetId, null)
        output = { ...currentCabinet, id: cabinetId, status: 'ACTIVE', maintenanceSource: null, faultActive: false, faultCode: null, faultReportedAt: null }
      } else if (action === 'REENABLE_CABINET') {
        if (cabinet.status === 'ACTIVE' && !cabinet.deletedAt) output = { ...cabinet, id: cabinetId }
        else {
          if (!['DISABLED', 'MAINTENANCE'].includes(cabinet.status)) throw new Error('CABINET_NOT_DISABLED')
          const faultActive = hasActiveFault(cabinet)
          const maintenanceSource = faultActive ? 'HARDWARE_FAULT' : 'MANUAL'
          await transaction.collection('cabinets').doc(cabinetId).update({ data: { status: 'MAINTENANCE', deletedAt: null, maintenanceSource, healthCheckPassedAt: null, updatedAt: now } })
          if (faultActive) await ensureCabinetFaultOrder(transaction, cabinetId, cabinet, manager, now)
          else await createManualOrder(transaction, cabinetId, null, manager, now)
          await audit(transaction, manager, 'CABINET_SET_MAINTENANCE', cabinetId, null, { migratedFromDisabled: cabinet.status === 'DISABLED', faultActive })
          output = { ...cabinet, id: cabinetId, status: 'MAINTENANCE', deletedAt: null, maintenanceSource }
        }
      } else if (action === 'DISABLE_CABINET') {
        const faultActive = hasActiveFault(cabinet)
        const maintenanceSource = faultActive ? 'HARDWARE_FAULT' : 'MANUAL'
        await transaction.collection('cabinets').doc(cabinetId).update({ data: { status: 'MAINTENANCE', deletedAt: null, maintenanceSource, healthCheckPassedAt: null, updatedAt: now } })
        if (faultActive) await ensureCabinetFaultOrder(transaction, cabinetId, cabinet, manager, now)
        else await createManualOrder(transaction, cabinetId, null, manager, now)
        await revokeAuthorizations(transaction, cabinetId, null, manager, 'CABINET_MAINTENANCE', now)
        await audit(transaction, manager, 'CABINET_SET_MAINTENANCE', cabinetId, null, { legacyDisableAction: true })
        output = { ...cabinet, id: cabinetId, status: 'MAINTENANCE', deletedAt: null, maintenanceSource }
      } else if (action === 'SET_LOCKER_MAINTENANCE') {
        if (!locker) throw new Error('LOCKER_NOT_FOUND')
        if (locker.status === 'OCCUPIED' || locker.currentRecordId) throw new Error('LOCKER_OCCUPIED')
        const migratedFromDisabled = locker.enabled === false || locker.status === 'DISABLED'
        await transaction.collection('lockers').doc(locker._id).update({ data: { enabled: true, status: 'MAINTENANCE', maintenanceSource: locker.faultActive ? 'HARDWARE_FAULT' : 'MANUAL', previousStatus: migratedFromDisabled ? 'EMPTY' : locker.status === 'MAINTENANCE' ? locker.previousStatus || 'EMPTY' : locker.status, healthCheckPassedAt: null, disabledAt: null, updatedAt: now } })
        const lockerOrder = await createManualOrder(transaction, cabinetId, lockerId, manager, now)
        if (locker.faultActive) await transaction.collection('maintenanceWorkOrders').doc(lockerOrder._id).update({ data: { source: 'DEVICE_FAULT', reason: 'LOCKER_HARDWARE_FAULT', faultCode: locker.faultCode || 'UNKNOWN_HARDWARE_FAULT', requiresSelfCheck: true, requiresInspection: true, updatedAt: now } })
        await revokeAuthorizations(transaction, cabinetId, lockerId, manager, 'LOCKER_MAINTENANCE', now)
        await audit(transaction, manager, 'LOCKER_SET_MAINTENANCE', cabinetId, lockerId, { migratedFromDisabled })
        output = { ...locker, id: lockerId, enabled: true, status: 'MAINTENANCE', maintenanceSource: locker.faultActive ? 'HARDWARE_FAULT' : 'MANUAL', previousStatus: migratedFromDisabled ? 'EMPTY' : locker.previousStatus || locker.status, disabledAt: null }
      } else if (action === 'RESTORE_LOCKER') {
        const currentLocker = locker ? ((await transaction.collection('lockers').doc(locker._id).get()).data || locker) : null
        if (!currentLocker || currentLocker.enabled === false) throw new Error('LOCKER_DISABLED')
        if (currentLocker.status !== 'MAINTENANCE') throw new Error('LOCKER_NOT_IN_MAINTENANCE')
        if (hasActiveFault(currentLocker)) throw new Error('HARDWARE_FAULT_ACTIVE')
        readyForRestore(orders[0], currentLocker)
        // 业务事实以 WAITING_PICKUP 记录为准，不能因维修字段缺失而把有餐柜格恢复为空闲。
        const waitingRecords = await transaction.collection('depositRecords').where({ cabinetId, lockerId, status: 'WAITING_PICKUP' }).limit(1).get()
        const waitingRecord = waitingRecords.data[0]
        const restoredStatus = waitingRecord ? 'OCCUPIED' : 'EMPTY'
        const restoredRecordId = waitingRecord ? waitingRecord._id : null
        await transaction.collection('lockers').doc(currentLocker._id).update({ data: { status: restoredStatus, currentRecordId: restoredRecordId, consecutiveUnlockFailures: 0, maintenanceSource: null, previousStatus: null, faultActive: false, faultCode: null, faultReportedAt: null, updatedAt: now } })
        await resolveOrders(transaction, orders, manager, now)
        if (restoredRecordId) { try { await transaction.collection('unlockIssues').doc(restoredRecordId).update({ data: { status: 'RESOLVED', updatedAt: now } }) } catch (error) {} }
        await audit(transaction, manager, 'LOCKER_RESTORE', cabinetId, lockerId)
        output = { ...currentLocker, id: lockerId, status: restoredStatus, currentRecordId: restoredRecordId, maintenanceSource: null, previousStatus: null, faultActive: false, faultCode: null, faultReportedAt: null }
      } else if (action === 'CORRECT_LOCKER_BUSINESS_STATUS') {
        if (!locker || locker.enabled === false) throw new Error('LOCKER_DISABLED')
        if (locker.status === 'MAINTENANCE') throw new Error('LOCKER_IN_MAINTENANCE')
        const targetStatus = String(event.targetStatus || '').toUpperCase()
        if (!['EMPTY', 'OCCUPIED'].includes(targetStatus)) throw new Error('LOCKER_STATUS_INVALID')
        // 状态校正只能修复 Locker 投影；DepositRecord 仍是业务事实来源。
        const waitingRecords = await transaction.collection('depositRecords').where({ cabinetId, lockerId, status: 'WAITING_PICKUP' }).limit(2).get()
        if (waitingRecords.data.length > 1) throw new Error('LOCKER_MULTIPLE_WAITING_RECORDS')
        const waitingRecord = waitingRecords.data[0]
        if (targetStatus === 'EMPTY' && waitingRecord) throw new Error('LOCKER_HAS_WAITING_PICKUP')
        if (targetStatus === 'OCCUPIED' && !waitingRecord) throw new Error('LOCKER_WAITING_RECORD_REQUIRED')
        const currentRecordId = waitingRecord ? waitingRecord._id : null
        const storedAt = waitingRecord ? waitingRecord.storedAt || null : null
        await transaction.collection('lockers').doc(locker._id).update({ data: { status: targetStatus, currentRecordId, storedAt, maintenanceSource: null, previousStatus: null, updatedAt: now } })
        if (targetStatus === 'EMPTY') await revokeAuthorizations(transaction, cabinetId, lockerId, manager, 'LOCKER_STATUS_CORRECTED_EMPTY', now)
        await audit(transaction, manager, 'LOCKER_BUSINESS_STATUS_CORRECTED', cabinetId, lockerId, { beforeStatus: locker.status, afterStatus: targetStatus, recordId: currentRecordId })
        output = { ...locker, id: lockerId, status: targetStatus, currentRecordId, storedAt, maintenanceSource: null, previousStatus: null }
      } else if (action === 'REENABLE_LOCKER') {
        if (!locker) throw new Error('LOCKER_NOT_FOUND')
        if (locker.status === 'OCCUPIED' || locker.currentRecordId) throw new Error('LOCKER_OCCUPIED')
        await transaction.collection('lockers').doc(locker._id).update({ data: { enabled: true, status: 'MAINTENANCE', maintenanceSource: locker.faultActive ? 'HARDWARE_FAULT' : 'MANUAL', previousStatus: 'EMPTY', disabledAt: null, updatedAt: now } })
        await createManualOrder(transaction, cabinetId, lockerId, manager, now)
        await audit(transaction, manager, 'LOCKER_SET_MAINTENANCE', cabinetId, lockerId, { migratedFromDisabled: true })
        output = { ...locker, id: lockerId, enabled: true, status: 'MAINTENANCE', maintenanceSource: locker.faultActive ? 'HARDWARE_FAULT' : 'MANUAL', previousStatus: 'EMPTY', disabledAt: null }
      } else if (action === 'DISABLE_LOCKER') {
        if (!locker) throw new Error('LOCKER_NOT_FOUND')
        if (locker.status === 'OCCUPIED' || locker.currentRecordId) throw new Error('LOCKER_HAS_WAITING_PICKUP')
        await transaction.collection('lockers').doc(locker._id).update({ data: { enabled: true, status: 'MAINTENANCE', maintenanceSource: 'MANUAL', previousStatus: 'EMPTY', disabledAt: null, updatedAt: now } })
        await createManualOrder(transaction, cabinetId, lockerId, manager, now)
        await revokeAuthorizations(transaction, cabinetId, lockerId, manager, 'LOCKER_MAINTENANCE', now)
        await audit(transaction, manager, 'LOCKER_SET_MAINTENANCE', cabinetId, lockerId, { legacyDisableAction: true })
        output = { ...locker, id: lockerId, enabled: true, status: 'MAINTENANCE', maintenanceSource: 'MANUAL', previousStatus: 'EMPTY', disabledAt: null }
      } else throw new Error('CABINET_MANAGEMENT_ACTION_UNSUPPORTED')
      await transaction.commit()
      return { ok: true, data: output }
    } catch (error) { await transaction.rollback(); throw error }
  } catch (error) {
    console.error('manageCabinet failed', error)
    return { ok: false, error: { code: error.message || 'MANAGE_CABINET_FAILED', waitingPickupCount: error.waitingPickupCount } }
  }
}

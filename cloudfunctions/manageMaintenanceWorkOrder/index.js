const cloud = require('wx-server-sdk')
const crypto = require('crypto')
cloud.init({ env: cloud.DYNAMIC_CURRENT_ENV })
const db = cloud.database()
const CHECK_KEYS = ['electronicLock', 'wiring', 'driver', 'power']

async function requireManager() {
  const { OPENID } = cloud.getWXContext()
  const result = await db.collection('users').where({ openid: OPENID, status: 'ACTIVE' }).limit(1).get()
  const user = result.data[0]
  if (!user || !['ADMIN', 'DEVELOPER'].includes(user.role)) throw new Error('ROLE_FORBIDDEN')
  const legal = (await db.collection('systemConfig').doc('legal-current').get()).data
  const consent = await db.collection('privacyConsents').where({ userId: user._id, agreementVersion: legal.agreementVersion, privacyVersion: legal.privacyVersion }).limit(1).get()
  if (!consent.data[0]) throw new Error('PRIVACY_CONSENT_REQUIRED')
  return user
}
async function audit(transaction, user, action, order, detail = {}) {
  const id = `operation-${Date.now()}-${crypto.randomBytes(4).toString('hex')}`
  await transaction.collection('operationLogs').doc(id).set({ data: { userId: user._id, role: user.role, cabinetId: order.cabinetId, lockerId: order.lockerId || null, recordId: order.recordId || null, action, result: 'SUCCESS', detail: { maintenanceOrderId: order._id, ...detail }, createdAt: new Date().toISOString() } })
}
function normalizedInspection(value = {}) {
  const result = {}
  CHECK_KEYS.forEach(key => { result[key] = ['NORMAL', 'ABNORMAL', 'NOT_CHECKED'].includes(value[key]) ? value[key] : 'NOT_CHECKED' })
  return result
}
exports.main = async event => {
  let transaction
  try {
    const manager = await requireManager()
    const action = String(event.action || '')
    const orderId = String(event.orderId || '')
    if (!orderId) throw new Error('MAINTENANCE_ORDER_ID_REQUIRED')
    transaction = await db.startTransaction()
    const order = (await transaction.collection('maintenanceWorkOrders').doc(orderId).get()).data
    if (!order) throw new Error('MAINTENANCE_ORDER_NOT_FOUND')
    order._id = orderId
    const now = new Date().toISOString()
    let patch = {}
    if (action === 'START') {
      if (order.status !== 'PENDING') throw new Error('MAINTENANCE_ORDER_ALREADY_STARTED')
      patch = { status: 'IN_PROGRESS', assignedTo: manager._id, startedAt: now, updatedAt: now }
      await audit(transaction, manager, 'MAINTENANCE_ORDER_STARTED', order, { assignedTo: manager._id })
    } else if (action === 'ARRIVE') {
      if (!['IN_PROGRESS', 'ONSITE'].includes(order.status)) throw new Error('MAINTENANCE_ORDER_NOT_IN_PROGRESS')
      patch = order.status === 'ONSITE' ? {} : { status: 'ONSITE', assignedTo: order.assignedTo || manager._id, arrivedAt: now, updatedAt: now }
      if (order.status !== 'ONSITE') await audit(transaction, manager, 'MAINTENANCE_ORDER_ARRIVED', order)
    } else if (action === 'SELF_CHECK_PASSED') {
      if (!['ONSITE', 'MANUAL_UNLOCK_COMPLETED', 'SELF_CHECK_PASSED'].includes(order.status)) throw new Error('MAINTENANCE_ORDER_NOT_ONSITE')
      const targetType = order.type || order.targetType || (order.lockerId ? 'LOCKER' : 'CABINET')
      if (targetType === 'LOCKER') {
        if (!order.lockerId) throw new Error('LOCKER_ID_REQUIRED')
        const lockers = await transaction.collection('lockers').where({ cabinetId: order.cabinetId, id: Number(order.lockerId) }).limit(1).get()
        const locker = lockers.data[0]
        if (!locker) throw new Error('LOCKER_NOT_FOUND')
        if (locker.enabled === false) throw new Error('LOCKER_DISABLED')
        if (locker.status !== 'MAINTENANCE') throw new Error('LOCKER_NOT_IN_MAINTENANCE')
        await transaction.collection('lockers').doc(locker._id).update({ data: { faultActive: false, healthCheckPassedAt: now, updatedAt: now } })
      } else {
        const cabinet = (await transaction.collection('cabinets').doc(order.cabinetId).get()).data
        if (!cabinet) throw new Error('CABINET_NOT_FOUND')
        if (cabinet.status !== 'MAINTENANCE') throw new Error('CABINET_NOT_IN_MAINTENANCE')
        await transaction.collection('cabinets').doc(order.cabinetId).update({ data: { faultActive: false, healthCheckPassedAt: now, updatedAt: now } })
      }
      patch = { status: 'SELF_CHECK_PASSED', requiresSelfCheck: true, selfCheckPassedAt: now, updatedAt: now }
      await audit(transaction, manager, targetType === 'LOCKER' ? 'LOCKER_HEALTH_CHECK_PASSED' : 'CABINET_HEALTH_CHECK_PASSED', order, { diagnosticChannel: 'MANAGEMENT_BLE' })
    } else if (action === 'SAVE_INSPECTION') {
      if (!['ONSITE', 'MANUAL_UNLOCK_COMPLETED', 'SELF_CHECK_PASSED'].includes(order.status)) throw new Error('MAINTENANCE_ORDER_NOT_ONSITE')
      const inspection = {
        ...normalizedInspection(event.inspection),
        ...(Object.prototype.hasOwnProperty.call(order.inspection || {}, 'doorSensor') ? { doorSensor: order.inspection.doorSensor } : {})
      }
      patch = { inspection, inspectionNotes: String(event.notes || '').trim().slice(0, 500), inspectedAt: now, updatedAt: now }
      await audit(transaction, manager, 'MAINTENANCE_ORDER_INSPECTION_SAVED', order, { inspection })
    } else if (action === 'MANUAL_EMERGENCY_UNLOCK') {
      if (!['ONSITE', 'SELF_CHECK_PASSED'].includes(order.status)) throw new Error('MAINTENANCE_ORDER_NOT_ONSITE')
      if (order.manualUnlockCompletedAt) throw new Error('MANUAL_EMERGENCY_UNLOCK_ALREADY_COMPLETED')
      if (!order.recordId || !order.issueId || !order.lockerId) throw new Error('MAINTENANCE_ORDER_HAS_NO_EMERGENCY_PICKUP')
      const record = (await transaction.collection('depositRecords').doc(order.recordId).get()).data
      const issue = (await transaction.collection('unlockIssues').doc(order.issueId).get()).data
      if (!record || record.status !== 'WAITING_PICKUP') throw new Error('NO_WAITING_PICKUP_RECORD')
      if (!issue || issue.status !== 'REQUIRES_ONSITE_MAINTENANCE') throw new Error('ONSITE_MAINTENANCE_NOT_REQUIRED')
      const lockers = await transaction.collection('lockers').where({ cabinetId: order.cabinetId, id: Number(order.lockerId) }).limit(1).get()
      const locker = lockers.data[0]
      if (!locker) throw new Error('LOCKER_NOT_FOUND')
      await transaction.collection('depositRecords').doc(order.recordId).update({ data: { status: 'PICKED_UP', pickedAt: now, pickedByUserId: issue.userId, completedByStaffId: manager._id, pickupMethod: 'MANUAL_EMERGENCY', updatedAt: now } })
      // 如果自检已经通过，现场交付只是完成业务交接，不能再次把已解除的
      // 硬件故障写回 active。faultCode 保留为历史审计信息，但 faultActive
      // 必须继续保持 false，避免恢复使用被错误拒绝。
      const faultStillActive = !order.selfCheckPassedAt
      const lockerPatch = {
        status: 'MAINTENANCE',
        doorStatus: 'OPEN',
        currentRecordId: null,
        storedAt: null,
        maintenanceSource: 'HARDWARE_FAULT',
        previousStatus: 'EMPTY',
        faultActive: faultStillActive,
        updatedAt: now
      }
      if (faultStillActive) lockerPatch.faultCode = 'LOCK_HARDWARE_FAILURE'
      await transaction.collection('lockers').doc(locker._id).update({ data: lockerPatch })
      await transaction.collection('unlockIssues').doc(order.issueId).update({ data: { manualUnlockCompletedAt: now, updatedAt: now } })
      const requests = await transaction.collection('emergencySupportRequests').where({ recordId: order.recordId }).get()
      for (const request of requests.data.filter(item => !['RESOLVED', 'CANCELLED', 'EXPIRED'].includes(item.status))) await transaction.collection('emergencySupportRequests').doc(request._id).update({ data: { status: 'RESOLVED', resolution: 'MANUAL_EMERGENCY_UNLOCK_COMPLETED', resolvedAt: now, updatedAt: now } })
      patch = { status: order.selfCheckPassedAt ? 'SELF_CHECK_PASSED' : 'MANUAL_UNLOCK_COMPLETED', manualUnlockCompletedAt: now, updatedAt: now }
      await audit(transaction, manager, 'MANUAL_EMERGENCY_UNLOCK', order, { remainsInMaintenance: true })
      await audit(transaction, manager, 'MAINTENANCE_ORDER_MANUAL_UNLOCK', order)
    } else throw new Error('MAINTENANCE_ACTION_INVALID')
    if (Object.keys(patch).length) await transaction.collection('maintenanceWorkOrders').doc(orderId).update({ data: patch })
    await transaction.commit()
    return { ok: true, data: { ...order, ...patch, id: orderId, type: order.type || order.targetType || (order.lockerId ? 'LOCKER' : 'CABINET') } }
  } catch (error) {
    if (transaction) await transaction.rollback().catch(() => null)
    return { ok: false, error: { code: error.message || 'MANAGE_MAINTENANCE_ORDER_FAILED' } }
  }
}

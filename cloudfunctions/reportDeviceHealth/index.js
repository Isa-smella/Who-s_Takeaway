const cloud = require('wx-server-sdk')
const crypto = require('crypto')
cloud.init({ env: cloud.DYNAMIC_CURRENT_ENV })
const db = cloud.database()
const _ = db.command
const ACTIVE = ['PENDING', 'IN_PROGRESS', 'ONSITE', 'MANUAL_UNLOCK_COMPLETED', 'SELF_CHECK_PASSED']

async function requireDeveloperRelay() {
  const { OPENID } = cloud.getWXContext()
  const result = await db.collection('users').where({ openid: OPENID, status: 'ACTIVE' }).limit(1).get()
  const user = result.data[0]
  if (!user || user.role !== 'DEVELOPER') throw new Error('TRUSTED_DEVICE_REPORT_REQUIRED')
  const legal = (await db.collection('systemConfig').doc('legal-current').get()).data
  const consent = await db.collection('privacyConsents').where({ userId: user._id, agreementVersion: legal.agreementVersion, privacyVersion: legal.privacyVersion }).limit(1).get()
  if (!consent.data[0]) throw new Error('PRIVACY_CONSENT_REQUIRED')
  return user
}
async function audit(transaction, user, action, cabinetId, lockerId, detail) {
  const id = `operation-${Date.now()}-${crypto.randomBytes(4).toString('hex')}`
  await transaction.collection('operationLogs').doc(id).set({ data: { userId: user._id, role: user.role, cabinetId, lockerId: lockerId || null, recordId: null, action, result: 'SUCCESS', detail: { ...detail, reportChannel: 'MOCK_DEVELOPER_RELAY' }, createdAt: new Date().toISOString() } })
}
async function revoke(transaction, cabinetId, lockerId, now, userId) {
  const result = await transaction.collection('unlockAuthorizations').where({ cabinetId, status: 'UNUSED' }).get()
  for (const item of result.data.filter(auth => lockerId === null || Number(auth.lockerId) === Number(lockerId))) await transaction.collection('unlockAuthorizations').doc(item._id).update({ data: { status: 'REVOKED', revokedAt: now, revokedBy: userId, revocationReason: lockerId === null ? 'CABINET_HARDWARE_FAULT' : 'LOCKER_HARDWARE_FAULT' } })
}
async function activeOrder(transaction, cabinetId, lockerId) {
  const result = await transaction.collection('maintenanceWorkOrders').where({ cabinetId, status: _.in(ACTIVE) }).get()
  return result.data.find(item => lockerId === null ? (item.type || item.targetType) === 'CABINET' : (item.type || item.targetType) === 'LOCKER' && Number(item.lockerId) === Number(lockerId))
}
exports.main = async event => {
  let transaction
  try {
    const reporter = await requireDeveloperRelay()
    const action = String(event.action || '')
    const cabinetId = String(event.cabinetId || '').trim().toUpperCase()
    if (!cabinetId) throw new Error('CABINET_ID_REQUIRED')
    const cabinet = (await db.collection('cabinets').doc(cabinetId).get()).data
    if (!cabinet) throw new Error('CABINET_NOT_FOUND')
    if (cabinet.status === 'DISABLED') throw new Error('CABINET_DISABLED')
    const now = new Date().toISOString()
    if (action === 'TELEMETRY') {
      const batteryPercent = Math.max(0, Math.min(100, Number(event.batteryPercent)))
      const voltage = Number(event.voltage)
      if (!Number.isFinite(batteryPercent) || !Number.isFinite(voltage)) throw new Error('TELEMETRY_INVALID')
      const data = { cabinetId, batteryPercent, voltage, onlineStatus: ['ONLINE', 'OFFLINE'].includes(event.onlineStatus) ? event.onlineStatus : 'ONLINE', firmwareVersion: String(event.firmwareVersion || '').slice(0, 80), reportedAt: now, reportChannel: 'MOCK_DEVELOPER_RELAY' }
      await db.collection('deviceTelemetry').doc(cabinetId).set({ data })
      return { ok: true, data }
    }
    const lockerId = event.lockerId === undefined ? null : Number(event.lockerId)
    transaction = await db.startTransaction()
    let target
    if (lockerId !== null) {
      const result = await transaction.collection('lockers').where({ cabinetId, id: lockerId }).limit(1).get()
      target = result.data[0]
      if (!target) throw new Error('LOCKER_NOT_FOUND')
      if (target.enabled === false) throw new Error('LOCKER_DISABLED')
    }
    if (action === 'LOCKER_FAULT' || action === 'CABINET_FAULT') {
      const isCabinet = action === 'CABINET_FAULT'
      if (!isCabinet && lockerId === null) throw new Error('LOCKER_ID_REQUIRED')
      const faultCode = String(event.faultCode || (isCabinet ? 'CONTROLLER_FAULT' : 'LOCK_HARDWARE_FAILURE')).slice(0, 80)
      const order = await activeOrder(transaction, cabinetId, isCabinet ? null : lockerId)
      if (isCabinet) await transaction.collection('cabinets').doc(cabinetId).update({ data: { status: 'MAINTENANCE', maintenanceSource: 'HARDWARE_FAULT', faultActive: true, faultCode, faultReportedAt: now, healthCheckPassedAt: null, updatedAt: now } })
      else await transaction.collection('lockers').doc(target._id).update({ data: { status: 'MAINTENANCE', maintenanceSource: 'HARDWARE_FAULT', previousStatus: target.status === 'MAINTENANCE' ? target.previousStatus || 'EMPTY' : target.status, faultActive: true, faultCode, faultReportedAt: now, healthCheckPassedAt: null, updatedAt: now } })
      if (order) await transaction.collection('maintenanceWorkOrders').doc(order._id).update({ data: { source: 'DEVICE_FAULT', reason: isCabinet ? 'CABINET_HARDWARE_FAULT' : 'LOCKER_HARDWARE_FAULT', faultCode, requiresSelfCheck: true, requiresInspection: true, updatedAt: now } })
      else {
        const id = `maintenance-${cabinetId}-${isCabinet ? 'cabinet' : lockerId}-${Date.now()}`
        await transaction.collection('maintenanceWorkOrders').doc(id).set({ data: { type: isCabinet ? 'CABINET' : 'LOCKER', cabinetId, lockerId: isCabinet ? null : lockerId, recordId: isCabinet ? null : target.currentRecordId || null, issueId: null, source: 'DEVICE_FAULT', reason: isCabinet ? 'CABINET_HARDWARE_FAULT' : 'LOCKER_HARDWARE_FAULT', faultCode, requiresSelfCheck: true, requiresInspection: true, status: 'PENDING', createdBy: 'DEVICE', createdAt: now, updatedAt: now } })
      }
      await revoke(transaction, cabinetId, isCabinet ? null : lockerId, now, reporter._id)
      await audit(transaction, reporter, isCabinet ? 'CABINET_FAULT_DETECTED' : 'LOCKER_FAULT_DETECTED', cabinetId, isCabinet ? null : lockerId, { faultCode, automaticMaintenance: true })
    } else if (action === 'LOCKER_SELF_CHECK' || action === 'CABINET_SELF_CHECK') {
      const isCabinet = action === 'CABINET_SELF_CHECK'
      if (!isCabinet && lockerId === null) throw new Error('LOCKER_ID_REQUIRED')
      if (event.passed !== true) throw new Error('SELF_CHECK_NOT_PASSED')
      const order = await activeOrder(transaction, cabinetId, isCabinet ? null : lockerId)
      if (!order) throw new Error('MAINTENANCE_ORDER_NOT_FOUND')
      if (isCabinet) await transaction.collection('cabinets').doc(cabinetId).update({ data: { faultActive: false, healthCheckPassedAt: now, updatedAt: now } })
      else await transaction.collection('lockers').doc(target._id).update({ data: { faultActive: false, healthCheckPassedAt: now, updatedAt: now } })
      const status = ['ONSITE', 'MANUAL_UNLOCK_COMPLETED', 'SELF_CHECK_PASSED'].includes(order.status) ? 'SELF_CHECK_PASSED' : order.status
      await transaction.collection('maintenanceWorkOrders').doc(order._id).update({ data: { status, requiresSelfCheck: true, selfCheckPassedAt: now, updatedAt: now } })
      await audit(transaction, reporter, isCabinet ? 'CABINET_HEALTH_CHECK_PASSED' : 'LOCKER_HEALTH_CHECK_PASSED', cabinetId, isCabinet ? null : lockerId, { requiresManagerRestore: true })
    } else throw new Error('DEVICE_HEALTH_ACTION_INVALID')
    await transaction.commit()
    return { ok: true, data: { cabinetId, lockerId, action, reportedAt: now } }
  } catch (error) {
    if (transaction) await transaction.rollback().catch(() => null)
    return { ok: false, error: { code: error.message || 'REPORT_DEVICE_HEALTH_FAILED' } }
  }
}

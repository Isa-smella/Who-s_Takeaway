const cloud = require('wx-server-sdk')
cloud.init({ env: cloud.DYNAMIC_CURRENT_ENV })
const db = cloud.database()
const _ = db.command
const ISSUE_LABELS = {
  EMPTY_WITH_WAITING_RECORD: '显示空闲，但存在未取餐记录',
  EMPTY_WITH_STALE_BINDING: '显示空闲，但仍绑定业务记录',
  OCCUPIED_WITHOUT_WAITING_RECORD: '显示占用，但没有未取餐记录',
  RECORD_BINDING_MISMATCH: '柜格绑定记录与未取餐记录不一致',
  MULTIPLE_WAITING_RECORDS: '同一柜格存在多条未取餐记录'
}
function inspectConsistency(lockers, records) {
  const issues = []
  lockers.forEach(locker => {
    const lockerId = Number(locker.id)
    const matched = records.filter(record => Number(record.lockerId) === lockerId)
    const recordIds = matched.map(record => String(record._id || '')).filter(Boolean)
    const add = (type, detail = {}) => issues.push({ type, label: ISSUE_LABELS[type], lockerId, lockerNumber: String(lockerId).padStart(2, '0'), recordIds, ...detail })
    if (matched.length > 1) add('MULTIPLE_WAITING_RECORDS', { waitingRecordCount: matched.length })
    if (locker.status === 'EMPTY') {
      if (matched.length) add('EMPTY_WITH_WAITING_RECORD')
      else if (locker.currentRecordId) add('EMPTY_WITH_STALE_BINDING', { currentRecordId: locker.currentRecordId })
    }
    if (locker.status === 'OCCUPIED') {
      if (!matched.length) add('OCCUPIED_WITHOUT_WAITING_RECORD', { currentRecordId: locker.currentRecordId || null })
      else if (!locker.currentRecordId || !recordIds.includes(String(locker.currentRecordId))) add('RECORD_BINDING_MISMATCH', { currentRecordId: locker.currentRecordId || null })
    }
  })
  return issues.sort((left, right) => left.lockerId - right.lockerId || left.type.localeCompare(right.type))
}
exports.main = async event => {
  try {
    const { OPENID } = cloud.getWXContext()
    const users = await db.collection('users').where({ openid: OPENID, status: 'ACTIVE' }).limit(1).get()
    const manager = users.data[0]
    if (!manager || !['ADMIN', 'DEVELOPER'].includes(manager.role)) throw new Error('ROLE_FORBIDDEN')
    const legal = (await db.collection('systemConfig').doc('legal-current').get()).data
    const consent = await db.collection('privacyConsents').where({ userId: manager._id, agreementVersion: legal.agreementVersion, privacyVersion: legal.privacyVersion }).limit(1).get()
    if (!consent.data[0]) throw new Error('PRIVACY_CONSENT_REQUIRED')
    const cabinetId = String(event.cabinetId || '').trim().toUpperCase()
    const cabinet = (await db.collection('cabinets').doc(cabinetId).get()).data
    if (!cabinet) throw new Error('CABINET_NOT_FOUND')
    const first = await db.collection('lockers').where({ cabinetId }).limit(100).get()
    const second = first.data.length === 100 ? await db.collection('lockers').where({ cabinetId }).skip(100).limit(100).get() : { data: [] }
    const orderResult = await db.collection('maintenanceWorkOrders').where({ cabinetId, status: _.in(['PENDING', 'IN_PROGRESS', 'ONSITE', 'MANUAL_UNLOCK_COMPLETED', 'SELF_CHECK_PASSED']) }).limit(100).get()
    const orders = orderResult.data.map(item => ({ ...item, id: item._id }))
    const lockers = await Promise.all(first.data.concat(second.data).map(async locker => {
      let issue = null
      if (locker.currentRecordId) try { issue = (await db.collection('unlockIssues').doc(locker.currentRecordId).get()).data } catch (error) {}
      return { ...locker, id: Number(locker.id), issue: issue && issue.status === 'REQUIRES_ONSITE_MAINTENANCE' ? { ...issue, id: locker.currentRecordId } : null, maintenanceOrder: orders.find(order => order.type === 'LOCKER' && Number(order.lockerId) === Number(locker.id)) || null }
    }))
    lockers.sort((a, b) => a.id - b.id)
    let telemetry = { batteryPercent: 100, onlineStatus: 'UNKNOWN', voltage: '--', firmwareVersion: '--', reportedAt: '' }
    try { telemetry = { ...telemetry, ...(await db.collection('deviceTelemetry').doc(cabinetId).get()).data } } catch (error) {}
    const waitingFirst = await db.collection('depositRecords').where({ cabinetId, status: 'WAITING_PICKUP' }).limit(100).get()
    const waitingSecond = waitingFirst.data.length === 100 ? await db.collection('depositRecords').where({ cabinetId, status: 'WAITING_PICKUP' }).skip(100).limit(100).get() : { data: [] }
    const dataConsistencyIssues = inspectConsistency(lockers, waitingFirst.data.concat(waitingSecond.data))
    const waiting = await db.collection('depositRecords').where({ cabinetId, status: 'WAITING_PICKUP' }).count()
    return { ok: true, data: { cabinet: { ...cabinet, id: cabinetId }, telemetry, lockers, cabinetOrder: orders.find(order => order.type === 'CABINET') || null, waitingPickupCount: waiting.total, dataConsistencyIssues } }
  } catch (error) { return { ok: false, error: { code: error.message || 'GET_CABINET_DETAIL_FAILED' } } }
}

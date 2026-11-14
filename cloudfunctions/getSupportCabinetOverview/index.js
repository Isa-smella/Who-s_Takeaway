const cloud = require('wx-server-sdk')
cloud.init({ env: cloud.DYNAMIC_CURRENT_ENV })
const db = cloud.database()
async function requireStaff() {
  const { OPENID } = cloud.getWXContext()
  const users = await db.collection('users').where({ openid: OPENID, status: 'ACTIVE' }).limit(1).get()
  const user = users.data[0]
  if (!user || !['CUSTOMER_SERVICE', 'ADMIN', 'DEVELOPER'].includes(user.role)) throw new Error('ROLE_FORBIDDEN')
  const legal = (await db.collection('systemConfig').doc('legal-current').get()).data
  const consent = await db.collection('privacyConsents').where({ userId: user._id, agreementVersion: legal.agreementVersion, privacyVersion: legal.privacyVersion }).limit(1).get()
  if (!consent.data[0]) throw new Error('PRIVACY_CONSENT_REQUIRED')
  return user
}
exports.main = async event => {
  try {
    const staff = await requireStaff()
    const cabinetId = String(event.cabinetId || '').trim().toUpperCase()
    if (!cabinetId) throw new Error('CABINET_ID_REQUIRED')
    const cabinet = (await db.collection('cabinets').doc(cabinetId).get()).data
    if (!cabinet) throw new Error('CABINET_NOT_FOUND')
    const first = await db.collection('lockers').where({ cabinetId }).limit(100).get()
    const second = first.data.length === 100 ? await db.collection('lockers').where({ cabinetId }).skip(100).limit(100).get() : { data: [] }
    const lockers = await Promise.all(first.data.concat(second.data).map(async locker => {
      let record = null
      let issue = null
      if (locker.currentRecordId) {
        try { record = (await db.collection('depositRecords').doc(locker.currentRecordId).get()).data } catch (error) {}
        try { issue = (await db.collection('unlockIssues').doc(locker.currentRecordId).get()).data } catch (error) {}
      }
      const active = record && record.status === 'WAITING_PICKUP'
      return { ...locker, id: Number(locker.id), pickupCode: active ? record.pickupCode : '', recordId: active ? locker.currentRecordId : '', recordStatus: active ? record.status : '', handlingStatus: issue ? issue.status : '', canIssueAuthorization: cabinet.status === 'ACTIVE' && locker.enabled !== false && locker.status === 'OCCUPIED' && Boolean(active) && (!issue || issue.status !== 'REQUIRES_ONSITE_MAINTENANCE') }
    }))
    lockers.sort((a, b) => a.id - b.id)
    if (event.audit !== false) await db.collection('operationLogs').add({ data: { userId: staff._id, role: staff.role, cabinetId, lockerId: null, recordId: null, action: 'EMERGENCY_PICKUP_CODES_VIEWED', result: 'SUCCESS', detail: { waitingPickupCount: lockers.filter(item => item.recordId).length }, createdAt: new Date().toISOString() } })
    return { ok: true, data: { cabinet: { ...cabinet, id: cabinet._id }, lockers } }
  } catch (error) { return { ok: false, error: { code: error.message || 'GET_SUPPORT_CABINET_FAILED' } } }
}

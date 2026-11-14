const cloud = require('wx-server-sdk')
cloud.init({ env: cloud.DYNAMIC_CURRENT_ENV })
const db = cloud.database()
exports.main = async event => {
  let staff
  let cabinetId = ''
  let lockerId = 0
  let recordId = null
  try {
    const { OPENID } = cloud.getWXContext()
    const users = await db.collection('users').where({ openid: OPENID, status: 'ACTIVE' }).limit(1).get()
    staff = users.data[0]
    if (!staff || !['CUSTOMER_SERVICE', 'ADMIN', 'DEVELOPER'].includes(staff.role)) throw new Error('ROLE_FORBIDDEN')
    const legal = (await db.collection('systemConfig').doc('legal-current').get()).data
    const consent = await db.collection('privacyConsents').where({ userId: staff._id, agreementVersion: legal.agreementVersion, privacyVersion: legal.privacyVersion }).limit(1).get()
    if (!consent.data[0]) throw new Error('PRIVACY_CONSENT_REQUIRED')
    cabinetId = String(event.cabinetId || '').trim().toUpperCase()
    lockerId = Number(event.lockerId)
    const pickupCode = String(event.pickupCode || '')
    const lockers = await db.collection('lockers').where({ cabinetId, id: lockerId }).limit(1).get()
    const locker = lockers.data[0]
    if (!locker || !locker.currentRecordId) throw new Error('NO_WAITING_PICKUP_RECORD')
    recordId = locker.currentRecordId
    const record = (await db.collection('depositRecords').doc(recordId).get()).data
    if (!record || record.status !== 'WAITING_PICKUP') throw new Error('NO_WAITING_PICKUP_RECORD')
    if (!/^\d{4}$/.test(pickupCode) || record.pickupCode !== pickupCode) throw new Error('PICKUP_CODE_MISMATCH')
    await db.collection('operationLogs').add({ data: { userId: staff._id, role: staff.role, cabinetId, lockerId, recordId, action: 'EMERGENCY_PICKUP_CODE_VERIFIED', result: 'SUCCESS', detail: { providedCodeLength: pickupCode.length }, createdAt: new Date().toISOString() } })
    return { ok: true, data: { recordId, verified: true } }
  } catch (error) {
    if (staff) try { await db.collection('operationLogs').add({ data: { userId: staff._id, role: staff.role, cabinetId: cabinetId || null, lockerId: lockerId || null, recordId, action: 'EMERGENCY_PICKUP_CODE_FAILED', result: 'FAILED', detail: { reason: error.message }, createdAt: new Date().toISOString() } }) } catch (ignore) {}
    return { ok: false, error: { code: error.message || 'VERIFY_EMERGENCY_PICKUP_CODE_FAILED' } }
  }
}

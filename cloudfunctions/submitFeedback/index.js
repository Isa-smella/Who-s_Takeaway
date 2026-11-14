const cloud = require('wx-server-sdk')
const crypto = require('crypto')
cloud.init({ env: cloud.DYNAMIC_CURRENT_ENV })
const db = cloud.database()
const PROBLEM_TYPES = ['LOCK_FAILED', 'CODE_ERROR', 'FOOD_MISSING', 'LOCKER_DAMAGED', 'DEVICE_OFFLINE', 'OTHER']

async function requireUser() {
  const { OPENID } = cloud.getWXContext()
  const result = await db.collection('users').where({ openid: OPENID, status: 'ACTIVE' }).limit(1).get()
  const user = result.data[0]
  if (!user) throw new Error('AUTH_REQUIRED')
  const legal = (await db.collection('systemConfig').doc('legal-current').get()).data
  const consent = await db.collection('privacyConsents').where({ userId: user._id, agreementVersion: legal.agreementVersion, privacyVersion: legal.privacyVersion }).limit(1).get()
  if (!consent.data[0]) throw new Error('PRIVACY_CONSENT_REQUIRED')
  return user
}

exports.main = async event => {
  let audit = null
  try {
    const user = await requireUser()
    const cabinetId = String(event.cabinetId || '').trim().toUpperCase()
    const lockerId = event.lockerId === null || event.lockerId === undefined || event.lockerId === '' ? null : Number(event.lockerId)
    const problemType = String(event.problemType || '')
    const description = String(event.description || '').trim().slice(0, 500)
    audit = { userId: user._id, role: user.role, cabinetId: cabinetId || null, lockerId }
    if (!cabinetId) throw new Error('CABINET_ID_REQUIRED')
    if (!PROBLEM_TYPES.includes(problemType)) throw new Error('FEEDBACK_PROBLEM_TYPE_INVALID')
    const cabinet = (await db.collection('cabinets').doc(cabinetId).get()).data
    if (!cabinet) throw new Error('CABINET_NOT_FOUND')
    if (lockerId !== null) {
      if (!Number.isInteger(lockerId) || lockerId < 1) throw new Error('LOCKER_ID_INVALID')
      const lockers = await db.collection('lockers').where({ cabinetId, id: lockerId }).limit(1).get()
      if (!lockers.data[0]) throw new Error('LOCKER_NOT_FOUND')
    }
    const now = new Date().toISOString()
    const feedbackId = `feedback-${Date.now()}-${crypto.randomBytes(4).toString('hex')}`
    const feedback = { userId: user._id, role: user.role, cabinetId, lockerId, problemType, description, status: 'PENDING', createdAt: now, updatedAt: now }
    const transaction = await db.startTransaction()
    try {
      await transaction.collection('feedback').doc(feedbackId).set({ data: feedback })
      const logId = `operation-${Date.now()}-${crypto.randomBytes(4).toString('hex')}`
      await transaction.collection('operationLogs').doc(logId).set({ data: { ...audit, recordId: null, action: 'FEEDBACK_CREATED', result: 'SUCCESS', detail: { feedbackId, problemType }, createdAt: now } })
      await transaction.commit()
    } catch (error) { await transaction.rollback(); throw error }
    return { ok: true, data: { ...feedback, id: feedbackId } }
  } catch (error) {
    if (audit) {
      try { await db.collection('operationLogs').add({ data: { ...audit, recordId: null, action: 'FEEDBACK_CREATED', result: 'FAILED', detail: { reason: error.message || 'SUBMIT_FEEDBACK_FAILED' }, createdAt: new Date().toISOString() } }) } catch (logError) {}
    }
    return { ok: false, error: { code: error.message || 'SUBMIT_FEEDBACK_FAILED' } }
  }
}

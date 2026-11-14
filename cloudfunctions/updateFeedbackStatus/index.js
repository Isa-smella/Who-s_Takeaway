const cloud = require('wx-server-sdk')
const crypto = require('crypto')
cloud.init({ env: cloud.DYNAMIC_CURRENT_ENV })
const db = cloud.database()
exports.main = async event => {
  try {
    const { OPENID } = cloud.getWXContext()
    const users = await db.collection('users').where({ openid: OPENID, status: 'ACTIVE' }).limit(1).get()
    const staff = users.data[0]
    if (!staff || !['CUSTOMER_SERVICE', 'ADMIN', 'DEVELOPER'].includes(staff.role)) throw new Error('ROLE_FORBIDDEN')
    const legal = (await db.collection('systemConfig').doc('legal-current').get()).data
    const consent = await db.collection('privacyConsents').where({ userId: staff._id, agreementVersion: legal.agreementVersion, privacyVersion: legal.privacyVersion }).limit(1).get()
    if (!consent.data[0]) throw new Error('PRIVACY_CONSENT_REQUIRED')
    const feedbackId = String(event.feedbackId || '')
    const status = String(event.status || '')
    if (!['PENDING', 'PROCESSING', 'RESOLVED'].includes(status)) throw new Error('FEEDBACK_STATUS_INVALID')
    const transaction = await db.startTransaction()
    try {
      const feedback = (await transaction.collection('feedback').doc(feedbackId).get()).data
      if (!feedback) throw new Error('FEEDBACK_NOT_FOUND')
      const now = new Date().toISOString()
      await transaction.collection('feedback').doc(feedbackId).update({ data: { status, updatedAt: now, handledBy: staff._id } })
      const logId = `operation-${Date.now()}-${crypto.randomBytes(4).toString('hex')}`
      await transaction.collection('operationLogs').doc(logId).set({ data: { userId: staff._id, role: staff.role, cabinetId: feedback.cabinetId, lockerId: feedback.lockerId || null, recordId: null, action: 'FEEDBACK_UPDATED', result: 'SUCCESS', detail: { feedbackId, previousStatus: feedback.status, status }, createdAt: now } })
      await transaction.commit()
      return { ok: true, data: { ...feedback, id: feedbackId, status, updatedAt: now, handledBy: staff._id } }
    } catch (error) { await transaction.rollback(); throw error }
  } catch (error) { return { ok: false, error: { code: error.message || 'UPDATE_FEEDBACK_FAILED' } } }
}

const cloud = require('wx-server-sdk')
cloud.init({ env: cloud.DYNAMIC_CURRENT_ENV })
const db = cloud.database()
exports.main = async event => {
  try {
    const { OPENID } = cloud.getWXContext()
    const users = await db.collection('users').where({ openid: OPENID, status: 'ACTIVE' }).limit(1).get()
    const user = users.data[0]
    if (!user || !['CUSTOMER_SERVICE', 'ADMIN', 'DEVELOPER'].includes(user.role)) throw new Error('ROLE_FORBIDDEN')
    const legal = (await db.collection('systemConfig').doc('legal-current').get()).data
    const consent = await db.collection('privacyConsents').where({ userId: user._id, agreementVersion: legal.agreementVersion, privacyVersion: legal.privacyVersion }).limit(1).get()
    if (!consent.data[0]) throw new Error('PRIVACY_CONSENT_REQUIRED')
    const offset = Math.max(0, Number(event.offset) || 0)
    const result = await db.collection('feedback').orderBy('createdAt', 'desc').skip(offset).limit(50).get()
    return { ok: true, data: { items: result.data.map(item => ({ ...item, id: item._id })), nextOffset: result.data.length === 50 ? offset + 50 : null } }
  } catch (error) { return { ok: false, error: { code: error.message || 'LIST_FEEDBACK_FAILED' } } }
}

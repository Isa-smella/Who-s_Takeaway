const cloud = require('wx-server-sdk')
cloud.init({ env: cloud.DYNAMIC_CURRENT_ENV })
const db = cloud.database()

exports.main = async event => {
  try {
    const { OPENID } = cloud.getWXContext()
    const users = await db.collection('users').where({ openid: OPENID, status: 'ACTIVE' }).limit(1).get()
    const user = users.data[0]
    if (!user) throw new Error('AUTH_REQUIRED')
    const legal = (await db.collection('systemConfig').doc('legal-current').get()).data
    const consent = await db.collection('privacyConsents').where({ userId: user._id, agreementVersion: legal.agreementVersion, privacyVersion: legal.privacyVersion }).limit(1).get()
    if (!consent.data[0]) throw new Error('PRIVACY_CONSENT_REQUIRED')
    const offset = Math.max(0, Number(event.offset) || 0)
    const result = await db.collection('feedback').where({ userId: user._id }).orderBy('createdAt', 'desc').skip(offset).limit(50).get()
    const items = result.data.map(item => ({ ...item, id: item._id })).sort((a, b) => new Date(b.createdAt) - new Date(a.createdAt))
    return { ok: true, data: { items, nextOffset: result.data.length === 50 ? offset + 50 : null } }
  } catch (error) {
    return { ok: false, error: { code: error.message || 'LIST_MY_FEEDBACK_FAILED' } }
  }
}

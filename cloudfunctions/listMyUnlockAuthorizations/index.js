const cloud = require('wx-server-sdk')
cloud.init({ env: cloud.DYNAMIC_CURRENT_ENV })
const db = cloud.database()
exports.main = async () => {
  try {
    const { OPENID } = cloud.getWXContext()
    const users = await db.collection('users').where({ openid: OPENID, status: 'ACTIVE' }).limit(1).get()
    const user = users.data[0]
    if (!user) throw new Error('AUTH_REQUIRED')
    const legal = (await db.collection('systemConfig').doc('legal-current').get()).data
    const consent = await db.collection('privacyConsents').where({ userId: user._id, agreementVersion: legal.agreementVersion, privacyVersion: legal.privacyVersion }).limit(1).get()
    if (!consent.data[0]) throw new Error('PRIVACY_CONSENT_REQUIRED')
    const result = await db.collection('unlockAuthorizations').where({ userId: user._id, source: 'CUSTOMER_SERVICE', status: 'UNUSED' }).limit(100).get()
    const now = Date.now()
    const active = []
    for (const item of result.data) {
      if (new Date(item.expiresAt).getTime() <= now) {
        await db.collection('unlockAuthorizations').doc(item._id).update({ data: { status: 'EXPIRED' } })
      } else active.push({ ...item, id: item._id })
    }
    return { ok: true, data: active }
  } catch (error) { return { ok: false, error: { code: error.message || 'LIST_UNLOCK_AUTHORIZATIONS_FAILED' } } }
}

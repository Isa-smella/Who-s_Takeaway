const cloud = require('wx-server-sdk')
cloud.init({ env: cloud.DYNAMIC_CURRENT_ENV })
const db = cloud.database()

exports.main = async () => {
  try {
    const { OPENID } = cloud.getWXContext()
    if (!OPENID) return { ok: false, error: { code: 'AUTH_REQUIRED' } }
    const userResult = await db.collection('users').where({ openid: OPENID, status: 'ACTIVE' }).limit(1).get()
    const user = userResult.data[0]
    if (!user) return { ok: false, error: { code: 'AUTH_REQUIRED' } }
    let legal
    try { legal = (await db.collection('systemConfig').doc('legal-current').get()).data } catch (error) {}
    if (!legal || !legal.agreementVersion || !legal.privacyVersion) return { ok: false, error: { code: 'LEGAL_VERSION_NOT_CONFIGURED' } }
    const collection = db.collection('privacyConsents')
    const existing = await collection.where({ userId: user._id }).limit(1).get()
    const data = { userId: user._id, agreementVersion: legal.agreementVersion, privacyVersion: legal.privacyVersion, agreedAt: db.serverDate() }
    let id
    if (existing.data[0]) {
      id = existing.data[0]._id
      await collection.doc(id).update({ data })
    } else {
      id = (await collection.add({ data }))._id
    }
    return { ok: true, data: { id, ...data, agreedAt: new Date().toISOString() } }
  } catch (error) {
    console.error('agreePrivacy failed', error)
    return { ok: false, error: { code: 'PRIVACY_CONSENT_INTERNAL_ERROR' } }
  }
}

const cloud = require('wx-server-sdk')
cloud.init({ env: cloud.DYNAMIC_CURRENT_ENV })
const db = cloud.database()

async function requireCoreAccess() {
  const { OPENID } = cloud.getWXContext()
  const users = await db.collection('users').where({ openid: OPENID, status: 'ACTIVE' }).limit(1).get()
  const user = users.data[0]
  if (!user) throw new Error('AUTH_REQUIRED')
  const legal = (await db.collection('systemConfig').doc('legal-current').get()).data
  const consents = await db.collection('privacyConsents').where({ userId: user._id, agreementVersion: legal.agreementVersion, privacyVersion: legal.privacyVersion }).limit(1).get()
  if (!consents.data[0]) throw new Error('PRIVACY_CONSENT_REQUIRED')
  return user
}

exports.main = async event => {
  try {
    await requireCoreAccess()
    const cabinetId = String(event.cabinetId || '').trim().toUpperCase()
    if (!cabinetId) return { ok: false, error: { code: 'CABINET_ID_REQUIRED' } }
    let cabinet
    try { cabinet = (await db.collection('cabinets').doc(cabinetId).get()).data } catch (error) {}
    if (!cabinet) return { ok: false, error: { code: 'CABINET_NOT_FOUND' } }
    return { ok: true, data: { ...cabinet, id: cabinet._id } }
  } catch (error) {
    return { ok: false, error: { code: error.message || 'GET_CABINET_FAILED' } }
  }
}

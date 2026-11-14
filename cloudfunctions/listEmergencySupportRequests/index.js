const cloud = require('wx-server-sdk')
cloud.init({ env: cloud.DYNAMIC_CURRENT_ENV })
const db = cloud.database()
const ACTIVE = ['OPEN', 'VERIFYING', 'AUTHORIZED', 'REQUIRES_ONSITE_MAINTENANCE']
const HISTORY = ['RESOLVED', 'CANCELLED', 'EXPIRED']
const STAFF_ROLES = ['CUSTOMER_SERVICE', 'ADMIN', 'DEVELOPER']

async function actor() {
  const { OPENID } = cloud.getWXContext()
  const users = await db.collection('users').where({ openid: OPENID, status: 'ACTIVE' }).limit(1).get()
  const user = users.data[0]
  if (!user) throw new Error('AUTH_REQUIRED')
  const legal = (await db.collection('systemConfig').doc('legal-current').get()).data
  const consent = await db.collection('privacyConsents').where({ userId: user._id, agreementVersion: legal.agreementVersion, privacyVersion: legal.privacyVersion }).limit(1).get()
  if (!consent.data[0]) throw new Error('PRIVACY_CONSENT_REQUIRED')
  return user
}
async function synchronize(item) {
  const now = Date.now()
  let patch = null
  if (['DRAFT', 'OPEN', 'VERIFYING'].includes(item.status) && new Date(item.expiresAt).getTime() <= now) patch = { status: 'EXPIRED', statusReason: 'REQUEST_EXPIRED', updatedAt: new Date(now).toISOString() }
  if (item.status === 'AUTHORIZED' && item.authorizationId) {
    let authorization
    try { authorization = (await db.collection('unlockAuthorizations').doc(item.authorizationId).get()).data } catch (error) {}
    if (!authorization) patch = { status: 'OPEN', authorizationId: null, statusReason: 'AUTHORIZATION_NOT_FOUND', updatedAt: new Date(now).toISOString() }
    else if (['EXPIRED', 'REVOKED'].includes(authorization.status) || new Date(authorization.expiresAt).getTime() <= now) patch = { status: 'OPEN', authorizationId: null, statusReason: `AUTHORIZATION_${authorization.status === 'UNUSED' ? 'EXPIRED' : authorization.status}`, updatedAt: new Date(now).toISOString() }
    else if (authorization.status === 'USED') {
      let record
      try { record = (await db.collection('depositRecords').doc(item.recordId).get()).data } catch (error) {}
      if (record && record.status === 'PICKED_UP') patch = { status: 'RESOLVED', resolvedAt: record.pickedAt, statusReason: 'PICKUP_SUCCESS', updatedAt: new Date(now).toISOString() }
    }
  }
  if (patch) {
    await db.collection('emergencySupportRequests').doc(item._id).update({ data: patch })
    return { ...item, ...patch }
  }
  return item
}
exports.main = async event => {
  try {
    const user = await actor()
    const audience = event.audience === 'STAFF' ? 'STAFF' : 'USER'
    if (audience === 'STAFF' && !STAFF_ROLES.includes(user.role)) throw new Error('ROLE_FORBIDDEN')
    const offset = Math.max(0, Number(event.offset) || 0)
    const collection = db.collection('emergencySupportRequests')
    const query = audience === 'USER' ? collection.where({ userId: user._id }) : collection
    const result = await query.orderBy('updatedAt', 'desc').skip(offset).limit(50).get()
    const synchronized = await Promise.all(result.data.map(synchronize))
    const scope = String(event.scope || 'ACTIVE')
    const items = synchronized.filter(item => audience === 'USER' || (scope === 'HISTORY' ? HISTORY.includes(item.status) : scope === 'ALL' ? item.status !== 'DRAFT' : ACTIVE.includes(item.status))).map(item => ({ ...item, id: item._id }))
    return { ok: true, data: { items, nextOffset: result.data.length === 50 ? offset + 50 : null } }
  } catch (error) { return { ok: false, error: { code: error.message || 'LIST_SUPPORT_REQUESTS_FAILED' } } }
}

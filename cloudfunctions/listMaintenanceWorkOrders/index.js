const cloud = require('wx-server-sdk')
cloud.init({ env: cloud.DYNAMIC_CURRENT_ENV })
const db = cloud.database()
const _ = db.command
const ACTIVE = ['PENDING', 'IN_PROGRESS', 'ONSITE', 'MANUAL_UNLOCK_COMPLETED', 'SELF_CHECK_PASSED']

async function requireManager() {
  const { OPENID } = cloud.getWXContext()
  const result = await db.collection('users').where({ openid: OPENID, status: 'ACTIVE' }).limit(1).get()
  const user = result.data[0]
  if (!user || !['ADMIN', 'DEVELOPER'].includes(user.role)) throw new Error('ROLE_FORBIDDEN')
  const legal = (await db.collection('systemConfig').doc('legal-current').get()).data
  const consent = await db.collection('privacyConsents').where({ userId: user._id, agreementVersion: legal.agreementVersion, privacyVersion: legal.privacyVersion }).limit(1).get()
  if (!consent.data[0]) throw new Error('PRIVACY_CONSENT_REQUIRED')
  return user
}
exports.main = async event => {
  try {
    await requireManager()
    const scope = String(event.scope || 'ACTIVE')
    const where = scope === 'HISTORY' ? { status: 'RESOLVED' } : scope === 'ALL' ? {} : { status: _.in(ACTIVE) }
    const first = await db.collection('maintenanceWorkOrders').where(where).orderBy('updatedAt', 'desc').limit(100).get()
    const second = first.data.length === 100 ? await db.collection('maintenanceWorkOrders').where(where).orderBy('updatedAt', 'desc').skip(100).limit(100).get() : { data: [] }
    return { ok: true, data: first.data.concat(second.data).map(item => ({ ...item, id: item._id, type: item.type || item.targetType || (item.lockerId ? 'LOCKER' : 'CABINET') })) }
  } catch (error) { return { ok: false, error: { code: error.message || 'LIST_MAINTENANCE_ORDERS_FAILED' } } }
}

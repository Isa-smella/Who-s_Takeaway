const cloud = require('wx-server-sdk')
cloud.init({ env: cloud.DYNAMIC_CURRENT_ENV })
const db = cloud.database()
async function requireManager() {
  const { OPENID } = cloud.getWXContext()
  const result = await db.collection('users').where({ openid: OPENID, status: 'ACTIVE' }).limit(1).get()
  const user = result.data[0]
  if (!user || !['ADMIN', 'DEVELOPER'].includes(user.role)) throw new Error('ROLE_FORBIDDEN')
  const legal = (await db.collection('systemConfig').doc('legal-current').get()).data
  const consent = await db.collection('privacyConsents').where({ userId: user._id, agreementVersion: legal.agreementVersion, privacyVersion: legal.privacyVersion }).limit(1).get()
  if (!consent.data[0]) throw new Error('PRIVACY_CONSENT_REQUIRED')
}
exports.main = async event => {
  try {
    await requireManager()
    const orderId = String(event.orderId || '')
    if (!orderId) throw new Error('MAINTENANCE_ORDER_ID_REQUIRED')
    const order = (await db.collection('maintenanceWorkOrders').doc(orderId).get()).data
    if (!order) throw new Error('MAINTENANCE_ORDER_NOT_FOUND')
    return { ok: true, data: { ...order, id: orderId, type: order.type || order.targetType || (order.lockerId ? 'LOCKER' : 'CABINET') } }
  } catch (error) { return { ok: false, error: { code: error.message || 'GET_MAINTENANCE_ORDER_FAILED' } } }
}

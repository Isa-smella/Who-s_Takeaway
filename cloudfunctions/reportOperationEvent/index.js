const cloud = require('wx-server-sdk')
cloud.init({ env: cloud.DYNAMIC_CURRENT_ENV })
const db = cloud.database()

const ALLOWED = new Set(['QR_SCAN', 'BLE_CONNECT_ATTEMPT', 'BLE_CONNECT_SUCCESS', 'BLE_CONNECT_FAILED', 'IDENTIFY_SUCCESS', 'IDENTIFY_FAILED', 'UNLOCK_ATTEMPT', 'UNLOCK_SUCCESS', 'UNLOCK_FAILED', 'DEPOSIT_CREATED', 'PICKUP_COMPLETED', 'MAINTENANCE_CREATED', 'MAINTENANCE_RESOLVED', 'CUSTOMER_SERVICE_UNLOCK'])
const SENSITIVE = /token|pickupcode|nonce|blemac|macaddress|appsecret|accesstoken|openid|unionid|phone|mobile|password|authorizationid/i

function safeValue(value, depth = 0) {
  if (depth > 2 || value === null || value === undefined) return undefined
  if (Array.isArray(value)) return value.slice(0, 20).map(item => safeValue(item, depth + 1)).filter(item => item !== undefined)
  if (typeof value !== 'object') return typeof value === 'string' ? value.slice(0, 300) : typeof value === 'number' || typeof value === 'boolean' ? value : undefined
  return Object.keys(value).slice(0, 30).reduce((out, key) => {
    if (!SENSITIVE.test(key)) { const item = safeValue(value[key], depth + 1); if (item !== undefined) out[key] = item }
    return out
  }, {})
}

async function currentUser() {
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
  try {
    const user = await currentUser()
    const type = String(event.type || '')
    if (!ALLOWED.has(type)) throw new Error('OPERATION_EVENT_TYPE_INVALID')
    if (['MAINTENANCE_CREATED', 'MAINTENANCE_RESOLVED'].includes(type) && !['ADMIN', 'DEVELOPER'].includes(user.role)) throw new Error('ROLE_FORBIDDEN')
    if (type === 'CUSTOMER_SERVICE_UNLOCK' && !['CUSTOMER_SERVICE', 'ADMIN', 'DEVELOPER'].includes(user.role)) throw new Error('ROLE_FORBIDDEN')
    const data = { type, userId: user._id, role: user.role, source: 'MINIPROGRAM', createdAt: db.serverDate() }
    if (event.cabinetId) data.cabinetId = String(event.cabinetId).trim().toUpperCase().slice(0, 64)
    if (event.lockerId !== undefined && event.lockerId !== null && event.lockerId !== '') {
      const lockerId = Number(event.lockerId)
      if (!Number.isInteger(lockerId) || lockerId < 1 || lockerId > 200) throw new Error('LOCKER_ID_INVALID')
      data.lockerId = String(lockerId)
    }
    if (event.recordId) data.recordId = String(event.recordId).slice(0, 160)
    if (event.connectionAttemptId) data.connectionAttemptId = String(event.connectionAttemptId).slice(0, 120)
    if (Number.isFinite(Number(event.durationMs))) data.durationMs = Math.max(0, Math.min(86400000, Math.round(Number(event.durationMs))))
    if (typeof event.success === 'boolean') data.success = event.success
    const metadata = safeValue(event.metadata || {})
    if (metadata && Object.keys(metadata).length) data.metadata = metadata
    const result = await db.collection('operationEvents').add({ data })
    return { ok: true, data: { id: result._id, type } }
  } catch (error) { return { ok: false, error: { code: error.message || 'REPORT_OPERATION_EVENT_FAILED' } } }
}

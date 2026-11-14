const cloud = require('wx-server-sdk')
cloud.init({ env: cloud.DYNAMIC_CURRENT_ENV })
const db = cloud.database()
const _ = db.command
const STAFF_ROLES = ['CUSTOMER_SERVICE', 'ADMIN', 'DEVELOPER']
const CUSTOMER_SERVICE_ACTIONS = [
  'SCAN_CABINET', 'SWITCH_CABINET', 'BLE_CONNECT_START', 'BLE_CONNECT_SUCCESS', 'BLE_CONNECT_FAILED', 'BLE_DISCONNECTED',
  'UNLOCK_AUTHORIZATION_CREATED', 'USER_SELECT_STORE_LOCKER', 'USER_OPEN_STORE_LOCK', 'USER_REOPEN_STORE_LOCK', 'USER_COPY_PICKUP_INFO',
  'USER_CONFIRM_DEPOSIT', 'STORE_CONFIRM_RETRY_REQUIRED', 'STORE_CONFIRM_REQUIRES_MAINTENANCE', 'USER_ENTER_PICKUP_CODE', 'USER_PICKUP_VERIFY_SUCCESS', 'USER_PICKUP_VERIFY_FAILED', 'USER_OPEN_PICKUP_LOCK', 'USER_PICKUP_SUCCESS',
  'RIDER_SELECT_LOCKER', 'RIDER_OPEN_LOCK', 'RIDER_REOPEN_LOCK', 'RIDER_CONFIRM_DEPOSIT', 'RIDER_COPY_PICKUP_INFO',
  'CUSTOMER_ENTER_PICKUP_CODE', 'CUSTOMER_PICKUP_VERIFY_SUCCESS', 'CUSTOMER_PICKUP_VERIFY_FAILED', 'CUSTOMER_OPEN_LOCK', 'CUSTOMER_PICKUP_SUCCESS',
  'LOCK_OPEN_SUCCESS', 'LOCK_OPEN_FAILED', 'DOOR_OPEN', 'DOOR_CLOSED', 'FEEDBACK_CREATED', 'FEEDBACK_UPDATED',
  'EMERGENCY_PICKUP_CODES_VIEWED', 'EMERGENCY_PICKUP_CODE_VERIFIED', 'EMERGENCY_PICKUP_CODE_FAILED',
  'CUSTOMER_SERVICE_UNLOCK_AUTH_CREATED', 'CUSTOMER_SERVICE_UNLOCK_ATTEMPT', 'CUSTOMER_SERVICE_UNLOCK_SUCCESS', 'CUSTOMER_SERVICE_UNLOCK_FAILED',
  'EMERGENCY_SUPPORT_REQUEST_OPENED', 'EMERGENCY_SUPPORT_REQUEST_AUTHORIZED', 'EMERGENCY_SUPPORT_REQUEST_PROCESSING', 'EMERGENCY_SUPPORT_REQUEST_CANCELLED', 'EMERGENCY_SUPPORT_REQUEST_RESOLVED', 'EMERGENCY_SUPPORT_REQUEST_ONSITE', 'EMERGENCY_SUPPORT_REQUEST_CONTEXT_UPDATED',
  'UNLOCK_AUTHORIZATION_REVOKED_BY_USER', 'UNLOCK_AUTHORIZATION_REVOKED_BY_STAFF', 'UNLOCK_AUTHORIZATION_AUTO_REVOKED', 'UNLOCK_REQUIRES_ONSITE_MAINTENANCE', 'MANUAL_EMERGENCY_UNLOCK'
]
const SENSITIVE_KEYS = ['token', 'pickupCode', 'openid', 'unionid', 'secret', 'signature', 'password']

function sanitize(value) {
  if (Array.isArray(value)) return value.map(sanitize)
  if (!value || typeof value !== 'object') return value
  return Object.keys(value).reduce((result, key) => {
    if (!SENSITIVE_KEYS.includes(key)) result[key] = sanitize(value[key])
    return result
  }, {})
}
exports.main = async event => {
  try {
    const { OPENID } = cloud.getWXContext()
    const users = await db.collection('users').where({ openid: OPENID, status: 'ACTIVE' }).limit(1).get()
    const staff = users.data[0]
    if (!staff || !STAFF_ROLES.includes(staff.role)) throw new Error('ROLE_FORBIDDEN')
    const legal = (await db.collection('systemConfig').doc('legal-current').get()).data
    const consent = await db.collection('privacyConsents').where({ userId: staff._id, agreementVersion: legal.agreementVersion, privacyVersion: legal.privacyVersion }).limit(1).get()
    if (!consent.data[0]) throw new Error('PRIVACY_CONSENT_REQUIRED')
    const input = event.filters && typeof event.filters === 'object' ? event.filters : {}
    const filters = {}
    if (input.userId) filters.userId = String(input.userId).slice(0, 128)
    const registrationNumber = input.registrationNumber ? String(input.registrationNumber).trim().slice(0, 32) : ''
    if (registrationNumber) {
      if (!/^\d{5,}$/.test(registrationNumber)) throw new Error('REGISTRATION_NUMBER_INVALID')
      const targetUsers = await db.collection('users').where({ registrationNumber }).limit(2).get()
      if (targetUsers.data.length !== 1) throw new Error('USER_NOT_FOUND')
      if (filters.userId && filters.userId !== targetUsers.data[0]._id) throw new Error('USER_SCOPE_MISMATCH')
      filters.userId = targetUsers.data[0]._id
    }
    if (input.cabinetId) filters.cabinetId = String(input.cabinetId).trim().toUpperCase().slice(0, 64)
    if (input.lockerId !== undefined && input.lockerId !== null && input.lockerId !== '') filters.lockerId = Number(input.lockerId)
    if (input.recordId) filters.recordId = String(input.recordId).slice(0, 160)
    if (input.result && ['SUCCESS', 'FAILED'].includes(input.result)) filters.result = input.result
    if (input.startAt || input.endAt) {
      const start = input.startAt && !Number.isNaN(new Date(input.startAt).getTime()) ? new Date(input.startAt).toISOString() : ''
      const end = input.endAt && !Number.isNaN(new Date(input.endAt).getTime()) ? new Date(input.endAt).toISOString() : ''
      if (start && end) filters.createdAt = _.and([_.gte(start), _.lte(end)])
      else if (start) filters.createdAt = _.gte(start)
      else if (end) filters.createdAt = _.lte(end)
    }
    const requestedAction = input.action ? String(input.action).slice(0, 100) : ''
    if (staff.role === 'CUSTOMER_SERVICE') {
      if (!filters.userId && !filters.cabinetId) throw new Error('LOG_QUERY_SCOPE_REQUIRED')
      if (requestedAction && !CUSTOMER_SERVICE_ACTIONS.includes(requestedAction)) throw new Error('LOG_ACTION_FORBIDDEN')
      filters.action = requestedAction || _.in(CUSTOMER_SERVICE_ACTIONS)
    } else if (requestedAction) filters.action = requestedAction
    const offset = Math.min(10000, Math.max(0, Number(event.offset) || 0))
    const result = await db.collection('operationLogs').where(filters).orderBy('createdAt', 'desc').skip(offset).limit(50).get()
    const userIds = [...new Set(result.data.map(item => item.userId).filter(id => id && id !== 'SYSTEM' && id !== 'DEVICE'))]
    const userMap = new Map()
    if (userIds.length) {
      const userResult = await db.collection('users').where({ _id: _.in(userIds.slice(0, 100)) }).limit(100).get()
      userResult.data.forEach(user => userMap.set(user._id, user.registrationNumber || ''))
    }
    const items = result.data.map(item => ({ ...item, id: item._id, registrationNumber: item.registrationNumber || userMap.get(item.userId) || '', detail: sanitize(item.detail || {}), clientInfo: sanitize(item.clientInfo || {}) }))
    return { ok: true, data: { items, nextOffset: result.data.length === 50 && offset < 10000 ? offset + 50 : null } }
  } catch (error) { return { ok: false, error: { code: error.message || 'GET_OPERATION_LOGS_FAILED' } } }
}

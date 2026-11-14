const cloudService = require('./cloudService')
const { USE_CLOUD, IS_DEVELOPMENT } = require('../config/env')
const { normalizeCabinetId, normalizeLockerId } = require('../utils/idNormalizer')
const EVENT_TYPES = require('../constants/operationEventTypes')

const LOCAL_KEY = 'LAKES_TAKEAWAY_MOCK_OPERATION_EVENTS_V1'
const ALLOWED = new Set(Object.keys(EVENT_TYPES).map(key => EVENT_TYPES[key]))
const SENSITIVE = /token|pickupcode|nonce|blemac|macaddress|appsecret|accesstoken|openid|unionid|phone|mobile|password|authorizationid/i

function safeMetadata(value, depth = 0) {
  if (depth > 2 || value === null || value === undefined) return undefined
  if (Array.isArray(value)) return value.slice(0, 20).map(item => safeMetadata(item, depth + 1)).filter(item => item !== undefined)
  if (typeof value !== 'object') {
    if (typeof value === 'string') return value.slice(0, 300)
    if (typeof value === 'number' || typeof value === 'boolean') return value
    return undefined
  }
  return Object.keys(value).slice(0, 30).reduce((out, key) => {
    if (!SENSITIVE.test(key)) {
      const item = safeMetadata(value[key], depth + 1)
      if (item !== undefined) out[key] = item
    }
    return out
  }, {})
}

function buildEvent(type, context = {}) {
  if (!ALLOWED.has(type)) throw new Error('OPERATION_EVENT_TYPE_INVALID')
  const event = { type }
  if (context.cabinetId) event.cabinetId = normalizeCabinetId(context.cabinetId)
  if (context.lockerId !== undefined && context.lockerId !== null && context.lockerId !== '') event.lockerId = normalizeLockerId(context.lockerId)
  if (context.recordId) event.recordId = String(context.recordId).slice(0, 160)
  if (context.connectionAttemptId) event.connectionAttemptId = String(context.connectionAttemptId).slice(0, 120)
  if (Number.isFinite(Number(context.durationMs))) event.durationMs = Math.max(0, Math.min(86400000, Math.round(Number(context.durationMs))))
  if (typeof context.success === 'boolean') event.success = context.success
  const metadata = safeMetadata(context.metadata || {})
  if (metadata && Object.keys(metadata).length) event.metadata = metadata
  return event
}

function appendMock(event) {
  try {
    const current = wx.getStorageSync(LOCAL_KEY)
    const list = Array.isArray(current) ? current : []
    list.push({ ...event, createdAt: new Date().toISOString(), userId: 'mock' })
    wx.setStorageSync(LOCAL_KEY, list.slice(-1000))
  } catch (error) { console.warn('[operationEvent] local append failed', error) }
}

// 事件记录是旁路能力，调用方不应等待它，也不能让它影响主业务。
function recordEvent(type, context = {}) {
  let event
  try { event = buildEvent(type, context) } catch (error) { console.warn('[operationEvent] invalid event', error.message); return Promise.resolve(null) }
  if (IS_DEVELOPMENT && (type === EVENT_TYPES.BLE_CONNECT_SUCCESS || type === EVENT_TYPES.BLE_CONNECT_FAILED)) console.info('[BLE_CONNECT_EVENT_DEBUG]', event)
  if (!USE_CLOUD) { appendMock(event); return Promise.resolve(event) }
  return cloudService.callFunction('reportOperationEvent', event).then(result => {
    if (IS_DEVELOPMENT && (type === EVENT_TYPES.BLE_CONNECT_SUCCESS || type === EVENT_TYPES.BLE_CONNECT_FAILED)) console.info('[BLE_CONNECT_EVENT_RESULT]', { event, result })
    return result
  }).catch(error => {
    console.warn('[operationEvent] report failed', type, error && error.message ? error.message : error)
    if (IS_DEVELOPMENT && (type === EVENT_TYPES.BLE_CONNECT_SUCCESS || type === EVENT_TYPES.BLE_CONNECT_FAILED)) console.info('[BLE_CONNECT_EVENT_RESULT]', { event, error: error && error.message ? error.message : error })
    return null
  })
}

module.exports = { recordEvent, buildEvent, EVENT_TYPES }

const operationLogRepository = require('../repositories/operationLogRepository')
const authService = require('./authService')
const permissionGuard = require('./permissionGuard')
const { USE_CLOUD } = require('../config/env')
const cloudOperationLogRepository = require('../repositories/cloudOperationLogRepository')
const operationEventService = require('./operationEventService')
const EVENT_TYPES = require('../constants/operationEventTypes')

const EVENT_BY_ACTION = Object.freeze({
  SCAN_CABINET: EVENT_TYPES.QR_SCAN,
  BLE_CONNECT_START: EVENT_TYPES.BLE_CONNECT_ATTEMPT,
  BLE_CONNECT_SUCCESS: EVENT_TYPES.BLE_CONNECT_SUCCESS,
  BLE_CONNECT_FAILED: EVENT_TYPES.BLE_CONNECT_FAILED,
  USER_OPEN_STORE_LOCK: EVENT_TYPES.UNLOCK_ATTEMPT,
  USER_REOPEN_STORE_LOCK: EVENT_TYPES.UNLOCK_ATTEMPT,
  USER_OPEN_PICKUP_LOCK: EVENT_TYPES.UNLOCK_ATTEMPT,
  CUSTOMER_SERVICE_UNLOCK_ATTEMPT: EVENT_TYPES.UNLOCK_ATTEMPT,
  ADMIN_OPEN_OCCUPIED_LOCKER: EVENT_TYPES.UNLOCK_ATTEMPT,
  LOCK_OPEN_SUCCESS: EVENT_TYPES.UNLOCK_SUCCESS,
  LOCK_OPEN_FAILED: EVENT_TYPES.UNLOCK_FAILED,
  UNLOCK_REQUIRES_ONSITE_MAINTENANCE: EVENT_TYPES.UNLOCK_FAILED,
  USER_CONFIRM_DEPOSIT: EVENT_TYPES.DEPOSIT_CREATED,
  USER_PICKUP_SUCCESS: EVENT_TYPES.PICKUP_COMPLETED,
  CUSTOMER_SERVICE_UNLOCK_AUTH_CREATED: EVENT_TYPES.CUSTOMER_SERVICE_UNLOCK,
  MAINTENANCE_ORDER_CREATED: EVENT_TYPES.MAINTENANCE_CREATED,
  MAINTENANCE_ORDER_RESOLVED: EVENT_TYPES.MAINTENANCE_RESOLVED
})

function getClientInfo() {
  try {
    const deviceInfo = typeof wx.getDeviceInfo === 'function' ? wx.getDeviceInfo() : {}
    const appBaseInfo = typeof wx.getAppBaseInfo === 'function' ? wx.getAppBaseInfo() : {}
    return {
      platform: deviceInfo.platform || '',
      appVersion: appBaseInfo.version || '',
      model: deviceInfo.model || ''
    }
  } catch (error) { return {} }
}
function log(action, context = {}) {
  const user = authService.getCurrentUser()
  const result = operationLogRepository.append({
    id: `operation-${Date.now()}-${Math.floor(Math.random() * 100000)}`,
    userId: user ? user.id : '',
    registrationNumber: user ? (user.registrationNumber || '') : '',
    role: user ? user.role : '',
    cabinetId: context.cabinetId || null,
    lockerId: context.lockerId || null,
    recordId: context.recordId || null,
    action,
    result: context.result || 'SUCCESS',
    detail: context.detail || {},
    createdAt: new Date().toISOString(),
    clientInfo: getClientInfo()
  })
  const eventType = EVENT_BY_ACTION[action]
  if (eventType && (action !== 'USER_CONFIRM_DEPOSIT' || context.result !== 'FAILED')) {
    // 不等待、不阻塞既有操作日志和业务调用。
    operationEventService.recordEvent(eventType, {
      cabinetId: context.cabinetId,
      lockerId: context.lockerId,
      recordId: context.recordId,
      connectionAttemptId: context.connectionAttemptId,
      durationMs: context.durationMs,
      success: context.result !== 'FAILED',
      metadata: { action, source: context.detail && context.detail.source }
    })
  }
  return result
}
function queryForAuthorizedStaff(filters = {}) {
  return permissionGuard.requireAccess({ roles: permissionGuard.CUSTOMER_SERVICE_ROLES })
    .then(() => USE_CLOUD ? cloudOperationLogRepository.query(filters) : operationLogRepository.query(filters))
}

module.exports = { log, queryForAuthorizedStaff }

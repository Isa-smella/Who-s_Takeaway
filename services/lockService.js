const bluetoothService = require('./bluetoothService')
const doorSensorService = require('./doorSensorService')
const permissionGuard = require('./permissionGuard')
const operationLogService = require('./operationLogService')
const unlockAuthorizationService = require('./unlockAuthorizationService')
const ACTIONS = require('../constants/operationActions')
const bleProtocol = require('./bleEspProtocolService')
const bleCommandTransportService = require('./bleCommandTransportService')
const nextMockFailures = {}
const acceptedAuthorizationIds = {}
const MOCK_FAILURE_STORAGE_KEY = 'lake_takeaway_next_unlock_failures'

function readPersistedMockFailures() {
  try { return wx.getStorageSync(MOCK_FAILURE_STORAGE_KEY) || {} } catch (error) { return {} }
}

function persistMockFailures(failures) {
  try { wx.setStorageSync(MOCK_FAILURE_STORAGE_KEY, failures) } catch (error) {}
}

function takeNextMockFailure(cabinetId, lockerId) {
  const failureKey = `${cabinetId}:${Number(lockerId)}`
  const persisted = readPersistedMockFailures()
  const mockFailure = nextMockFailures[failureKey] || persisted[failureKey]
  delete nextMockFailures[failureKey]
  if (persisted[failureKey]) {
    delete persisted[failureKey]
    persistMockFailures(persisted)
  }
  return mockFailure
}

function getPendingMockFailure(cabinetId, lockerId) {
  const failureKey = `${cabinetId}:${Number(lockerId)}`
  return nextMockFailures[failureKey] || readPersistedMockFailures()[failureKey] || ''
}

function openLock(cabinetId, lockerId, options = {}) {
  try { permissionGuard.assertRole(permissionGuard.CABINET_ACCESS_ROLES) } catch (error) {
    operationLogService.log(ACTIONS.LOCK_OPEN_FAILED, { cabinetId, lockerId, result: 'FAILED', detail: { reason: error.message } })
    return Promise.reject(error)
  }
  if (!bluetoothService.isConnectedTo(cabinetId)) {
    const error = new Error('BLUETOOTH_NOT_CONNECTED_TO_CABINET')
    operationLogService.log(ACTIONS.LOCK_OPEN_FAILED, { cabinetId, lockerId, result: 'FAILED', detail: { reason: error.message } })
    return Promise.reject(error)
  }
  if (!options.hardwareEnvelope) {
    const error = new Error('LOCK_AUTHORIZATION_REQUIRED')
    operationLogService.log(ACTIONS.LOCK_OPEN_FAILED, { cabinetId, lockerId, result: 'FAILED', detail: { reason: error.message } })
    return Promise.reject(error)
  }
  if (!unlockAuthorizationService.verifyMockHardwareEnvelope(options.hardwareEnvelope, cabinetId, lockerId)) {
    const error = new Error('ESP32_AUTHORIZATION_REJECTED')
    operationLogService.log(ACTIONS.LOCK_OPEN_FAILED, { cabinetId, lockerId, result: 'FAILED', detail: { reason: error.message } })
    return Promise.reject(error)
  }
  let request
  try { request = bleProtocol.createOpenLockRequest(cabinetId, lockerId, options.hardwareEnvelope) } catch (error) { return Promise.reject(error) }
  return bleCommandTransportService.send(cabinetId, request, deviceRequest => {
    const envelope = deviceRequest.authorization
    if (!unlockAuthorizationService.verifyMockHardwareEnvelope(envelope, deviceRequest.cabinetId, deviceRequest.lockerId)) return bleProtocol.createResponse(deviceRequest, bleProtocol.RESPONSE_CODES.AUTH_INVALID)
    const authorizationId = envelope.authorizationId
    if (acceptedAuthorizationIds[authorizationId]) return bleProtocol.createResponse(deviceRequest, bleProtocol.RESPONSE_CODES.REPLAYED)
    // Mock ESP32在接受命令时立即持久化 nonce/authorizationId；驱动失败也不能重放。
    acceptedAuthorizationIds[authorizationId] = cabinetId
    const mockFailure = takeNextMockFailure(cabinetId, lockerId)
    if (mockFailure === 'DOOR_NOT_OPEN') {
      // 故障模拟必须覆盖可能残留的 OPEN，避免把上一次柜门状态误判成本次成功。
      doorSensorService.mockSetDoorStatus(cabinetId, lockerId, 'CLOSED')
      return bleProtocol.createResponse(deviceRequest, bleProtocol.RESPONSE_CODES.DOOR_NOT_OPEN, { commandAccepted: true, driverExecuted: true, doorOpened: false })
    }
    if (mockFailure) return bleProtocol.createResponse(deviceRequest, bleProtocol.RESPONSE_CODES.DRIVER_FAILED, { commandAccepted: true })
    doorSensorService.mockSetDoorStatus(cabinetId, lockerId, 'OPEN')
    return bleProtocol.createResponse(deviceRequest, bleProtocol.RESPONSE_CODES.OK, { commandAccepted: true, driverExecuted: true, doorOpened: true })
  }).catch(error => {
    // HM10_TEXT 收到 @OPEN:xx:FAIL 时，bleLockerService 会以 reject 结束。
    // 这里补记一次真实传输失败事件，保持实体失败链完整；不改变原错误和业务判定。
    const transportFailureCodes = new Set(['BLE_LOCKER_OPEN_FAILED', 'BLE_COMMAND_TIMEOUT', 'BLE_WRITE_FAILED', 'BLE_DISCONNECTED'])
    if (transportFailureCodes.has(error && error.message)) {
      operationLogService.log(ACTIONS.LOCK_OPEN_FAILED, { cabinetId, lockerId, result: 'FAILED', detail: { reason: error.message } })
    }
    throw error
  }).then(response => {
    if (response.code === bleProtocol.RESPONSE_CODES.OK) {
      operationLogService.log(ACTIONS.LOCK_OPEN_SUCCESS, { cabinetId, lockerId, detail: { requestId: response.requestId, protocolVersion: response.protocolVersion } })
      return { success: true, commandAccepted: response.commandAccepted, driverExecuted: response.driverExecuted, doorOpened: response.doorOpened, cabinetId, lockerId, requestId: response.requestId }
    }
    if (response.code === bleProtocol.RESPONSE_CODES.DOOR_NOT_OPEN) {
      operationLogService.log(ACTIONS.LOCK_OPEN_FAILED, { cabinetId, lockerId, result: 'FAILED', detail: { reason: 'DOOR_NOT_OPEN', requestId: response.requestId, commandAccepted: true, driverExecuted: true } })
      return { success: false, commandAccepted: true, driverExecuted: true, doorOpened: false, cabinetId, lockerId, requestId: response.requestId }
    }
    const errorCodes = { AUTH_INVALID: 'ESP32_AUTHORIZATION_REJECTED', REPLAYED: 'ESP32_AUTHORIZATION_REPLAYED', DRIVER_FAILED: 'LOCK_DRIVER_FAILED' }
    const error = new Error(errorCodes[response.code] || `ESP32_${response.code}`)
    operationLogService.log(ACTIONS.LOCK_OPEN_FAILED, { cabinetId, lockerId, result: 'FAILED', detail: { reason: error.message, requestId: response.requestId, responseCode: response.code } })
    throw error
  })
}
function mockFailNextOpen(cabinetId, lockerId, failureCode = 'DOOR_NOT_OPEN') {
  const failureKey = `${cabinetId}:${Number(lockerId)}`
  nextMockFailures[failureKey] = failureCode
  const persisted = readPersistedMockFailures()
  persisted[failureKey] = failureCode
  persistMockFailures(persisted)
  // 布置“门未开”前先清掉旧的 OPEN 状态，调试页可立即核对目标柜格。
  if (failureCode === 'DOOR_NOT_OPEN') doorSensorService.mockSetDoorStatus(cabinetId, lockerId, 'CLOSED')
}
function clearMockFailuresForCabinet(cabinetId) {
  Object.keys(nextMockFailures).filter(key => key.startsWith(`${cabinetId}:`)).forEach(key => delete nextMockFailures[key])
  Object.keys(acceptedAuthorizationIds).filter(key => acceptedAuthorizationIds[key] === cabinetId).forEach(key => delete acceptedAuthorizationIds[key])
  const persisted = readPersistedMockFailures()
  Object.keys(persisted).filter(key => key.startsWith(`${cabinetId}:`)).forEach(key => delete persisted[key])
  persistMockFailures(persisted)
}
module.exports = { openLock, mockFailNextOpen, getPendingMockFailure, clearMockFailuresForCabinet }

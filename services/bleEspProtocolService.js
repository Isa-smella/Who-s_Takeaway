const PROTOCOL_VERSION = 'LT_BLE_V1'
const MESSAGE_TYPES = { REQUEST: 'REQUEST', RESPONSE: 'RESPONSE' }
const COMMANDS = { OPEN_LOCK: 'OPEN_LOCK', GET_STATUS: 'GET_STATUS', SELF_CHECK: 'SELF_CHECK' }
const RESPONSE_CODES = {
  OK: 'OK', AUTH_INVALID: 'AUTH_INVALID', AUTH_EXPIRED: 'AUTH_EXPIRED', REPLAYED: 'REPLAYED',
  CABINET_MISMATCH: 'CABINET_MISMATCH', LOCKER_INVALID: 'LOCKER_INVALID', DRIVER_FAILED: 'DRIVER_FAILED', DOOR_NOT_OPEN: 'DOOR_NOT_OPEN', INTERNAL_ERROR: 'INTERNAL_ERROR'
}

function newRequestId() { return `ble-${Date.now()}-${Math.floor(Math.random() * 100000000)}` }
function assertCabinetAndLocker(cabinetId, lockerId) {
  if (!cabinetId) throw new Error('CABINET_ID_REQUIRED')
  if (!Number.isInteger(Number(lockerId)) || Number(lockerId) < 1) throw new Error('LOCKER_ID_INVALID')
}
function createOpenLockRequest(cabinetId, lockerId, authorization) {
  assertCabinetAndLocker(cabinetId, lockerId)
  if (!authorization) throw new Error('LOCK_AUTHORIZATION_REQUIRED')
  return {
    protocolVersion: PROTOCOL_VERSION,
    messageType: MESSAGE_TYPES.REQUEST,
    requestId: newRequestId(),
    command: COMMANDS.OPEN_LOCK,
    cabinetId,
    lockerId: Number(lockerId),
    sentAt: new Date().toISOString(),
    authorization
  }
}
function createResponse(request, code, detail = {}) {
  return {
    protocolVersion: PROTOCOL_VERSION,
    messageType: MESSAGE_TYPES.RESPONSE,
    requestId: request.requestId,
    command: request.command,
    cabinetId: request.cabinetId,
    lockerId: request.lockerId,
    code,
    commandAccepted: Boolean(detail.commandAccepted),
    driverExecuted: Boolean(detail.driverExecuted),
    doorOpened: Boolean(detail.doorOpened),
    deviceTime: new Date().toISOString()
  }
}
function validateRequest(request) {
  if (!request || request.protocolVersion !== PROTOCOL_VERSION || request.messageType !== MESSAGE_TYPES.REQUEST) throw new Error('BLE_PROTOCOL_REQUEST_INVALID')
  if (!request.requestId || !Object.values(COMMANDS).includes(request.command)) throw new Error('BLE_PROTOCOL_REQUEST_INVALID')
  assertCabinetAndLocker(request.cabinetId, request.lockerId)
  return request
}
function validateResponse(response, request) {
  if (!response || response.protocolVersion !== PROTOCOL_VERSION || response.messageType !== MESSAGE_TYPES.RESPONSE) throw new Error('BLE_PROTOCOL_RESPONSE_INVALID')
  if (response.requestId !== request.requestId || response.command !== request.command) throw new Error('BLE_PROTOCOL_CORRELATION_MISMATCH')
  if (response.cabinetId !== request.cabinetId || Number(response.lockerId) !== Number(request.lockerId)) throw new Error('BLE_PROTOCOL_TARGET_MISMATCH')
  if (!Object.values(RESPONSE_CODES).includes(response.code)) throw new Error('BLE_PROTOCOL_RESPONSE_CODE_INVALID')
  return response
}
function encode(frame) { return JSON.stringify(frame) }
function decode(text) {
  try { return JSON.parse(String(text || '')) } catch (error) { throw new Error('BLE_PROTOCOL_JSON_INVALID') }
}
function splitFrame(frame, maxCharacters = 180) {
  const payload = encode(frame)
  const total = Math.ceil(payload.length / maxCharacters)
  return Array.from({ length: total }, (_, index) => ({ requestId: frame.requestId, sequence: index + 1, total, payload: payload.slice(index * maxCharacters, (index + 1) * maxCharacters) }))
}
function joinChunks(chunks) {
  if (!Array.isArray(chunks) || !chunks.length) throw new Error('BLE_PROTOCOL_CHUNKS_INVALID')
  const sorted = chunks.slice().sort((a, b) => a.sequence - b.sequence)
  if (sorted.length !== sorted[0].total || sorted.some((item, index) => item.sequence !== index + 1 || item.total !== sorted.length || item.requestId !== sorted[0].requestId)) throw new Error('BLE_PROTOCOL_CHUNKS_INCOMPLETE')
  return decode(sorted.map(item => item.payload).join(''))
}

module.exports = { PROTOCOL_VERSION, MESSAGE_TYPES, COMMANDS, RESPONSE_CODES, createOpenLockRequest, createResponse, validateRequest, validateResponse, encode, decode, splitFrame, joinChunks }

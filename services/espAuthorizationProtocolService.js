const PROTOCOL_VERSION = 'MOCK_V1'
const COMMAND = 'OPEN_LOCK'
const ALLOWED_SOURCES = ['STORE', 'STORE_REOPEN', 'NORMAL_PICKUP', 'CUSTOMER_SERVICE', 'ADMIN_MAINTENANCE', 'ADMIN_OCCUPIED_CLEAR']

function createMockEnvelope(authorization) {
  if (!authorization || authorization.status !== 'USED') throw new Error('UNLOCK_AUTHORIZATION_NOT_CONSUMED')
  return {
    protocolVersion: authorization.protocolVersion,
    command: authorization.command,
    authorizationId: authorization.id,
    userId: authorization.userId,
    cabinetId: authorization.cabinetId,
    lockerId: Number(authorization.lockerId),
    recordId: authorization.recordId || null,
    maintenanceOrderId: authorization.maintenanceOrderId || null,
    source: authorization.source,
    nonce: authorization.nonce,
    token: authorization.token,
    issuedAt: authorization.createdAt,
    expiresAt: authorization.expiresAt
  }
}

function validateMockEnvelopeShape(envelope, cabinetId, lockerId) {
  if (!envelope || typeof envelope !== 'object') return false
  if (envelope.protocolVersion !== PROTOCOL_VERSION || envelope.command !== COMMAND) return false
  if (!ALLOWED_SOURCES.includes(envelope.source)) return false
  if (!envelope.authorizationId || !envelope.userId || !envelope.nonce || !envelope.token) return false
  if (envelope.cabinetId !== cabinetId || Number(envelope.lockerId) !== Number(lockerId)) return false
  if (new Date(envelope.expiresAt).getTime() <= Date.now()) return false
  return true
}

module.exports = { PROTOCOL_VERSION, COMMAND, ALLOWED_SOURCES, createMockEnvelope, validateMockEnvelopeShape }

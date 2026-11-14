const authorizationRepository = require('../repositories/unlockAuthorizationRepository')
const depositRepository = require('../repositories/depositRepository')
const cabinetRepository = require('../repositories/cabinetRepository')
const lockerRepository = require('../repositories/lockerRepository')
const maintenanceWorkOrderRepository = require('../repositories/maintenanceWorkOrderRepository')
const permissionGuard = require('./permissionGuard')
const operationLogService = require('./operationLogService')
const espAuthorizationProtocolService = require('./espAuthorizationProtocolService')
const ACTIONS = require('../constants/operationActions')
const { MOCK_UNLOCK_AUTH_TTL_MS, STORE_REOPEN_WINDOW_MS } = require('../config/env')
const { USE_CLOUD } = require('../config/env')
const cloudUnlockAuthorizationRepository = require('../repositories/cloudUnlockAuthorizationRepository')
const cloudCustomerServiceRepository = require('../repositories/cloudCustomerServiceRepository')
const cloudCabinetManagementRepository = require('../repositories/cloudCabinetManagementRepository')

function createMockSecret(prefix) { return `${prefix}-${Date.now()}-${Math.floor(Math.random() * 1000000000)}` }
function revokeSuperseded(data) {
  if (data.recordId) return authorizationRepository.revokeUnusedForRecord(data.recordId, data.userId)
  return authorizationRepository.revokeWhere(item => item.userId === data.userId && item.cabinetId === data.cabinetId && Number(item.lockerId) === Number(data.lockerId) && item.source === data.source, { revokedBy: 'SYSTEM', reason: 'SUPERSEDED' })
}
function createAuthorizationInternal(data) {
  const now = Date.now()
  revokeSuperseded(data)
  const authorization = authorizationRepository.create({
    ...data,
    id: `unlock-auth-${now}-${Math.floor(Math.random() * 100000)}`,
    token: createMockSecret(`MOCK-UA-${data.source}`),
    nonce: createMockSecret('MOCK-NONCE'),
    protocolVersion: espAuthorizationProtocolService.PROTOCOL_VERSION,
    command: espAuthorizationProtocolService.COMMAND,
    createdAt: new Date(now).toISOString(),
    expiresAt: new Date(now + MOCK_UNLOCK_AUTH_TTL_MS).toISOString(),
    status: 'UNUSED'
  })
  operationLogService.log(ACTIONS.UNLOCK_AUTHORIZATION_CREATED, {
    cabinetId: authorization.cabinetId, lockerId: authorization.lockerId, recordId: authorization.recordId,
    detail: { authorizationId: authorization.id, source: authorization.source, expiresAt: authorization.expiresAt, maintenanceOrderId: authorization.maintenanceOrderId }
  })
  return authorization
}
function assertActiveCabinetAndLocker(cabinetId, lockerId) {
  const cabinet = cabinetRepository.getCabinet(cabinetId)
  if (cabinet.status !== 'ACTIVE') throw new Error('CABINET_NOT_ACTIVE')
  const locker = lockerRepository.getLocker(cabinetId, lockerId)
  if (!locker || locker.enabled === false) throw new Error('LOCKER_NOT_AVAILABLE_FOR_AUTHORIZATION')
  return { cabinet, locker }
}
function requestUnlockAuthorization(options) {
  const source = options.source || 'NORMAL_PICKUP'
  if (source === 'STORE') {
    if (USE_CLOUD) return cloudUnlockAuthorizationRepository.createStore(options)
    const user = permissionGuard.assertRole(permissionGuard.STORE_ROLES)
    const { locker } = assertActiveCabinetAndLocker(options.cabinetId, options.lockerId)
    if (locker.status !== 'EMPTY' || locker.currentRecordId) throw new Error('LOCKER_NOT_AVAILABLE_FOR_STORE')
    return createAuthorizationInternal({ userId: user.id, cabinetId: options.cabinetId, lockerId: Number(options.lockerId), recordId: null, source, reason: 'STORE_OPEN', issuedBy: 'SYSTEM', issuedByRole: 'SYSTEM' })
  }
  if (source === 'STORE_REOPEN') {
    if (USE_CLOUD) return cloudUnlockAuthorizationRepository.createStore(options)
    const user = permissionGuard.assertRole(permissionGuard.STORE_ROLES)
    const { locker } = assertActiveCabinetAndLocker(options.cabinetId, options.lockerId)
    const record = depositRepository.getActiveRecord(options.cabinetId, options.lockerId)
    if (!record || record.id !== options.recordId || record.depositorUserId !== user.id) throw new Error('STORE_REOPEN_NOT_ALLOWED')
    const storedAt = new Date(record.storedAt).getTime()
    if (!Number.isFinite(storedAt) || storedAt > Date.now() + 60 * 1000 || Date.now() - storedAt > STORE_REOPEN_WINDOW_MS) throw new Error('STORE_REOPEN_EXPIRED')
    if (locker.status !== 'OCCUPIED' || locker.currentRecordId !== record.id) throw new Error('STORE_REOPEN_RECORD_MISMATCH')
    return createAuthorizationInternal({ userId: user.id, cabinetId: record.cabinetId, lockerId: Number(record.lockerId), recordId: record.id, source, reason: 'STORE_REOPEN_AFTER_DEPOSIT', issuedBy: 'SYSTEM', issuedByRole: 'SYSTEM' })
  }
  if (source === 'ADMIN_OCCUPIED_CLEAR') {
    const manager = permissionGuard.assertRole(permissionGuard.MANAGEMENT_ROLES)
    if (USE_CLOUD) {
      return cloudCabinetManagementRepository.manage('CREATE_OCCUPIED_CLEAR_AUTHORIZATION', {
        cabinetId: options.cabinetId,
        lockerId: Number(options.lockerId)
      }).then(authorization => authorizationRepository.create(authorization))
    }
    const { locker } = assertActiveCabinetAndLocker(options.cabinetId, options.lockerId)
    const record = depositRepository.getActiveRecord(options.cabinetId, options.lockerId)
    if (!record || locker.status !== 'OCCUPIED' || locker.currentRecordId !== record.id) throw new Error('LOCKER_WAITING_RECORD_MISMATCH')
    return createAuthorizationInternal({ userId: manager.id, cabinetId: options.cabinetId, lockerId: Number(options.lockerId), recordId: record.id, source, reason: 'ADMIN_VERIFY_PHYSICALLY_EMPTY', issuedBy: manager.id, issuedByRole: manager.role })
  }
  if (source === 'NORMAL_PICKUP') {
    if (USE_CLOUD) return cloudUnlockAuthorizationRepository.verifyPickup(options)
    const user = permissionGuard.assertRole(permissionGuard.PICKUP_ROLES)
    assertActiveCabinetAndLocker(options.cabinetId, options.lockerId)
    const record = depositRepository.verifyPickupCode(options.cabinetId, options.lockerId, options.pickupCode)
    if (!record || (options.recordId && record.id !== options.recordId)) throw new Error('PICKUP_AUTHORIZATION_DENIED')
    return createAuthorizationInternal({ userId: user.id, cabinetId: record.cabinetId, lockerId: record.lockerId, recordId: record.id, source, issuedBy: 'SYSTEM', issuedByRole: 'SYSTEM' })
  }
  if (source === 'CUSTOMER_SERVICE') {
    const user = permissionGuard.assertRole(permissionGuard.PICKUP_ROLES)
    const authorization = authorizationRepository.getById(options.authorizationId)
    if (!authorization || authorization.source !== 'CUSTOMER_SERVICE') throw new Error('UNLOCK_AUTHORIZATION_NOT_FOUND')
    if (authorization.userId !== user.id) throw new Error('UNLOCK_AUTHORIZATION_USER_MISMATCH')
    return authorization
  }
  if (source === 'ADMIN_MAINTENANCE') {
    const manager = permissionGuard.assertRole(permissionGuard.MANAGEMENT_ROLES)
    const reason = String(options.reason || '').trim()
    if (reason.length < 5) throw new Error('AUTHORIZATION_REASON_REQUIRED')
    const cabinet = cabinetRepository.getCabinet(options.cabinetId)
    if (cabinet.status === 'DISABLED') throw new Error('CABINET_DISABLED')
    const locker = lockerRepository.getLocker(options.cabinetId, options.lockerId)
    if (!locker || locker.enabled === false || locker.status !== 'MAINTENANCE') throw new Error('LOCKER_NOT_IN_MAINTENANCE')
    const order = maintenanceWorkOrderRepository.getById(options.maintenanceOrderId)
    if (!order || order.cabinetId !== options.cabinetId || Number(order.lockerId) !== Number(options.lockerId) || !['ONSITE', 'SELF_CHECK_PASSED'].includes(order.status)) throw new Error('MAINTENANCE_ORDER_NOT_AUTHORIZED_FOR_UNLOCK')
    if (locker.currentRecordId || order.recordId) throw new Error('MAINTENANCE_UNLOCK_HAS_ACTIVE_RECORD')
    return createAuthorizationInternal({ userId: manager.id, cabinetId: options.cabinetId, lockerId: Number(options.lockerId), recordId: order.recordId || null, maintenanceOrderId: order.id, source, reason, issuedBy: manager.id, issuedByRole: manager.role })
  }
  throw new Error('UNLOCK_AUTHORIZATION_SOURCE_UNSUPPORTED')
}
function issueCustomerServiceAuthorization(data) {
  const staff = permissionGuard.assertRole(permissionGuard.CUSTOMER_SERVICE_ROLES)
  if (data.issuedBy !== staff.id || data.issuedByRole !== staff.role || data.source !== 'CUSTOMER_SERVICE') throw new Error('CUSTOMER_SERVICE_AUTHORIZATION_CONTEXT_INVALID')
  return createAuthorizationInternal(data)
}
function autoRevoke(authorization, reason) {
  const revoked = authorizationRepository.revoke(authorization.id, { revokedBy: 'SYSTEM', reason })
  operationLogService.log(ACTIONS.UNLOCK_AUTHORIZATION_AUTO_REVOKED, { cabinetId: revoked.cabinetId, lockerId: revoked.lockerId, recordId: revoked.recordId, detail: { authorizationId: revoked.id, reason } })
  return revoked
}
function synchronizeAuthorization(authorization) {
  if (!authorization || authorization.status !== 'UNUSED') return authorization
  let cabinet
  try { cabinet = cabinetRepository.getCabinet(authorization.cabinetId) } catch (error) { return autoRevoke(authorization, 'CABINET_NOT_FOUND') }
  if (authorization.source !== 'ADMIN_MAINTENANCE' && cabinet.status !== 'ACTIVE') return autoRevoke(authorization, `CABINET_${cabinet.status}`)
  const locker = lockerRepository.getLocker(authorization.cabinetId, authorization.lockerId)
  if (!locker || locker.enabled === false) return autoRevoke(authorization, 'LOCKER_INACTIVE')
  if (authorization.source === 'STORE') {
    if (locker.status !== 'EMPTY' || locker.currentRecordId) return autoRevoke(authorization, 'STORE_TARGET_INACTIVE')
    return authorization
  }
  if (authorization.source === 'ADMIN_MAINTENANCE') {
    const order = maintenanceWorkOrderRepository.getById(authorization.maintenanceOrderId)
    if (!order || !['ONSITE', 'SELF_CHECK_PASSED'].includes(order.status) || locker.status !== 'MAINTENANCE') return autoRevoke(authorization, 'MAINTENANCE_CONTEXT_INACTIVE')
    return authorization
  }
  if (USE_CLOUD) {
    if (locker.status !== 'OCCUPIED' || locker.currentRecordId !== authorization.recordId) return autoRevoke(authorization, 'RECORD_INACTIVE')
    return authorization
  }
  const record = depositRepository.getActiveRecord(authorization.cabinetId, authorization.lockerId)
  if (!record || record.id !== authorization.recordId) return autoRevoke(authorization, 'RECORD_INACTIVE')
  return authorization
}
function getActiveForCurrentUser() {
  const user = permissionGuard.assertCoreAccess()
  if (USE_CLOUD) return cloudCustomerServiceRepository.listActiveForCurrentUser()
  return authorizationRepository.list().filter(item => item.userId === user.id && item.source === 'CUSTOMER_SERVICE').map(synchronizeAuthorization).filter(item => item.status === 'UNUSED')
}
function validateForExecution(authorizationId, currentCabinetId) {
  const user = permissionGuard.assertRole(permissionGuard.CABINET_ACCESS_ROLES)
  let authorization = authorizationRepository.getById(authorizationId)
  if (!authorization) throw new Error('UNLOCK_AUTHORIZATION_NOT_FOUND')
  authorization = synchronizeAuthorization(authorization)
  if (authorization.status !== 'UNUSED') throw new Error(`UNLOCK_AUTHORIZATION_${authorization.status}`)
  if (authorization.userId !== user.id) throw new Error('UNLOCK_AUTHORIZATION_USER_MISMATCH')
  if (authorization.cabinetId !== currentCabinetId) throw new Error('UNLOCK_AUTHORIZATION_CABINET_MISMATCH')
  if (['ADMIN_MAINTENANCE', 'ADMIN_OCCUPIED_CLEAR'].includes(authorization.source) && !permissionGuard.MANAGEMENT_ROLES.includes(user.role)) throw new Error('ROLE_FORBIDDEN')
  if (!USE_CLOUD && !['STORE', 'ADMIN_MAINTENANCE'].includes(authorization.source)) {
    const record = depositRepository.getActiveRecord(authorization.cabinetId, authorization.lockerId)
    if (!record || record.id !== authorization.recordId) throw new Error('UNLOCK_AUTHORIZATION_RECORD_MISMATCH')
  }
  return authorization
}
function revokeByCurrentUser(authorizationId) {
  const user = permissionGuard.assertRole(permissionGuard.PICKUP_ROLES)
  if (USE_CLOUD) return cloudCustomerServiceRepository.revokeByCurrentUser(authorizationId)
  const authorization = authorizationRepository.getById(authorizationId)
  if (!authorization || authorization.userId !== user.id) throw new Error('UNLOCK_AUTHORIZATION_USER_MISMATCH')
  const revoked = authorizationRepository.revoke(authorizationId, { revokedBy: user.id, reason: 'USER_GAVE_UP' })
  operationLogService.log(ACTIONS.UNLOCK_AUTHORIZATION_REVOKED_BY_USER, { cabinetId: revoked.cabinetId, lockerId: revoked.lockerId, recordId: revoked.recordId, detail: { authorizationId: revoked.id } })
  return revoked
}
function revokeByStaff(authorizationId, reason = 'STAFF_REVOKED') {
  const staff = permissionGuard.assertRole(permissionGuard.CUSTOMER_SERVICE_ROLES)
  const authorization = authorizationRepository.getById(authorizationId)
  if (!authorization || authorization.source !== 'CUSTOMER_SERVICE') throw new Error('UNLOCK_AUTHORIZATION_NOT_FOUND')
  const revoked = authorizationRepository.revoke(authorizationId, { revokedBy: staff.id, reason })
  operationLogService.log(ACTIONS.UNLOCK_AUTHORIZATION_REVOKED_BY_STAFF, { cabinetId: revoked.cabinetId, lockerId: revoked.lockerId, recordId: revoked.recordId, detail: { authorizationId: revoked.id, reason } })
  return revoked
}
function autoRevokeForCabinet(cabinetId, reason) {
  const before = authorizationRepository.list().filter(item => item.cabinetId === cabinetId && item.status === 'UNUSED')
  authorizationRepository.revokeUnusedForCabinet(cabinetId, { revokedBy: 'SYSTEM', reason })
  before.forEach(item => operationLogService.log(ACTIONS.UNLOCK_AUTHORIZATION_AUTO_REVOKED, { cabinetId, lockerId: item.lockerId, recordId: item.recordId, detail: { authorizationId: item.id, reason } }))
  return before.length
}
function autoRevokeForLocker(cabinetId, lockerId, reason) {
  const before = authorizationRepository.list().filter(item => item.cabinetId === cabinetId && Number(item.lockerId) === Number(lockerId) && item.status === 'UNUSED')
  authorizationRepository.revokeUnusedForLocker(cabinetId, lockerId, { revokedBy: 'SYSTEM', reason })
  before.forEach(item => operationLogService.log(ACTIONS.UNLOCK_AUTHORIZATION_AUTO_REVOKED, { cabinetId, lockerId: Number(lockerId), recordId: item.recordId, detail: { authorizationId: item.id, reason } }))
  return before.length
}
function consume(authorizationId, cabinetId) {
  return USE_CLOUD ? cloudUnlockAuthorizationRepository.consume(authorizationId, cabinetId) : authorizationRepository.markUsed(authorizationId)
}
function createHardwareEnvelope(authorization) { return espAuthorizationProtocolService.createMockEnvelope(authorization) }
function verifyMockHardwareEnvelope(envelope, cabinetId, lockerId) {
  if (!espAuthorizationProtocolService.validateMockEnvelopeShape(envelope, cabinetId, lockerId)) return false
  const stored = authorizationRepository.getById(envelope.authorizationId)
  return Boolean(stored && stored.status === 'USED' && stored.token === envelope.token && stored.nonce === envelope.nonce && stored.userId === envelope.userId && stored.source === envelope.source && stored.protocolVersion === envelope.protocolVersion && stored.command === envelope.command && stored.cabinetId === cabinetId && Number(stored.lockerId) === Number(lockerId) && (stored.recordId || null) === (envelope.recordId || null) && (stored.maintenanceOrderId || null) === (envelope.maintenanceOrderId || null) && stored.usedAt && new Date(stored.usedAt).getTime() <= new Date(stored.expiresAt).getTime())
}

module.exports = { requestUnlockAuthorization, issueCustomerServiceAuthorization, getActiveForCurrentUser, validateForExecution, synchronizeAuthorization, revokeByCurrentUser, revokeByStaff, autoRevokeForCabinet, autoRevokeForLocker, consume, createHardwareEnvelope, verifyMockHardwareEnvelope }

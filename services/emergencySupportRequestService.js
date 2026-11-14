const repository = require('../repositories/emergencySupportRequestRepository')
const authorizationRepository = require('../repositories/unlockAuthorizationRepository')
const depositRepository = require('../repositories/depositRepository')
const authService = require('./authService')
const permissionGuard = require('./permissionGuard')
const operationLogService = require('./operationLogService')
const ACTIONS = require('../constants/operationActions')
const { MOCK_SUPPORT_REQUEST_TTL_MS } = require('../config/env')
const cabinetRepository = require('../repositories/cabinetRepository')
const lockerRepository = require('../repositories/lockerRepository')
const { USE_CLOUD } = require('../config/env')
const cloudRepository = require('../repositories/cloudEmergencySupportRequestRepository')

const ACTIVE_STATUSES = ['OPEN', 'VERIFYING', 'AUTHORIZED', 'REQUIRES_ONSITE_MAINTENANCE']
const HISTORY_STATUSES = ['RESOLVED', 'CANCELLED', 'EXPIRED']

function sameContext(request, context) {
  if (context.recordId || request.recordId) return Boolean(context.recordId) && request.recordId === context.recordId
  return request.cabinetId === (context.cabinetId || null) && Number(request.lockerId || 0) === Number(context.lockerId || 0)
}
function prepare(context = {}) {
  if (USE_CLOUD) return cloudRepository.manage('PREPARE', { context })
  const user = authService.getCurrentUser()
  if (!user) throw new Error('AUTH_REQUIRED')
  const existing = repository.list().find(item => item.userId === user.id && ['DRAFT', ...ACTIVE_STATUSES].includes(item.status) && sameContext(item, context))
  if (existing) {
    if (['DRAFT', 'OPEN', 'VERIFYING'].includes(existing.status)) {
      return repository.update(existing.id, {
        cabinetId: context.cabinetId || existing.cabinetId,
        lockerId: context.lockerId || existing.lockerId,
        recordId: context.recordId || existing.recordId,
        expiresAt: new Date(Date.now() + MOCK_SUPPORT_REQUEST_TTL_MS).toISOString()
      })
    }
    return existing
  }
  const now = Date.now()
  return repository.create({
    id: `support-request-${now}-${Math.floor(Math.random() * 100000)}`,
    userId: user.id,
    cabinetId: context.cabinetId || null,
    lockerId: context.lockerId || null,
    recordId: context.recordId || null,
    status: 'DRAFT',
    createdAt: new Date(now).toISOString(),
    expiresAt: new Date(now + MOCK_SUPPORT_REQUEST_TTL_MS).toISOString(),
    updatedAt: new Date(now).toISOString()
  })
}
function updateContext(requestId, context = {}) {
  if (USE_CLOUD) return cloudRepository.manage('UPDATE_CONTEXT', { requestId, context })
  const user = authService.getCurrentUser()
  const request = repository.getById(requestId)
  if (!user || !request || request.userId !== user.id || !['DRAFT', 'OPEN'].includes(request.status)) throw new Error('SUPPORT_REQUEST_NOT_EDITABLE')
  const updated = repository.update(requestId, { cabinetId: context.cabinetId || null, lockerId: context.lockerId || null, recordId: context.recordId || null })
  operationLogService.log(ACTIONS.EMERGENCY_SUPPORT_REQUEST_CONTEXT_UPDATED, { cabinetId: updated.cabinetId, lockerId: updated.lockerId, recordId: updated.recordId, detail: { supportRequestId: updated.id, updatedBy: 'USER' } })
  return updated
}
function bindContextByStaff(requestId, context = {}) {
  if (USE_CLOUD) return cloudRepository.manage('BIND_CONTEXT', { requestId, context })
  const staff = permissionGuard.assertRole(permissionGuard.CUSTOMER_SERVICE_ROLES)
  const request = repository.getById(requestId)
  if (!request || !['OPEN', 'VERIFYING'].includes(request.status)) throw new Error('SUPPORT_REQUEST_NOT_EDITABLE')
  const cabinetId = String(context.cabinetId || '').trim()
  const lockerId = Number(context.lockerId)
  if (!cabinetId) throw new Error('CABINET_ID_REQUIRED')
  if (!Number.isInteger(lockerId) || lockerId < 1) throw new Error('LOCKER_ID_REQUIRED')
  const cabinet = cabinetRepository.getCabinet(cabinetId)
  if (cabinet.status === 'DISABLED') throw new Error('CABINET_DISABLED')
  const locker = lockerRepository.getLocker(cabinetId, lockerId)
  if (!locker || locker.enabled === false) throw new Error('LOCKER_NOT_AVAILABLE')
  const record = depositRepository.getActiveRecord(cabinetId, lockerId)
  const updated = repository.update(requestId, { cabinetId, lockerId, recordId: record ? record.id : null, statusReason: record ? null : 'WAITING_FOR_VALID_RECORD' })
  operationLogService.log(ACTIONS.EMERGENCY_SUPPORT_REQUEST_CONTEXT_UPDATED, { cabinetId, lockerId, recordId: updated.recordId, detail: { supportRequestId: updated.id, updatedBy: staff.id, activeRecordFound: Boolean(record) } })
  return updated
}
function activate(requestId) {
  if (USE_CLOUD) return cloudRepository.manage('ACTIVATE', { requestId })
  const user = authService.getCurrentUser()
  const request = repository.getById(requestId)
  if (!user || !request || request.userId !== user.id || !['DRAFT', 'OPEN'].includes(request.status)) throw new Error('SUPPORT_REQUEST_NOT_ACTIVATABLE')
  if (request.status === 'OPEN') return request
  const opened = repository.update(requestId, { status: 'OPEN', activatedAt: new Date().toISOString(), statusReason: null })
  operationLogService.log(ACTIONS.EMERGENCY_SUPPORT_REQUEST_OPENED, { cabinetId: opened.cabinetId, lockerId: opened.lockerId, recordId: opened.recordId, detail: { supportRequestId: opened.id } })
  return opened
}
function synchronizeRequest(request) {
  if (request.status !== 'AUTHORIZED' || !request.authorizationId) return request
  const authorization = authorizationRepository.getById(request.authorizationId)
  if (!authorization) return repository.update(request.id, { status: 'OPEN', authorizationId: null, statusReason: 'AUTHORIZATION_NOT_FOUND' })
  if (['EXPIRED', 'REVOKED'].includes(authorization.status)) {
    return repository.update(request.id, { status: 'OPEN', authorizationId: null, statusReason: `AUTHORIZATION_${authorization.status}` })
  }
  if (authorization.status === 'USED') {
    const record = depositRepository.getRecords().find(item => item.id === request.recordId)
    if (record && record.status === 'PICKED_UP') return repository.update(request.id, { status: 'RESOLVED', resolvedAt: record.pickedAt, statusReason: 'PICKUP_SUCCESS' })
  }
  return request
}
function listForStaff(scope = 'ACTIVE') {
  if (USE_CLOUD) return cloudRepository.listForStaff(scope)
  permissionGuard.assertRole(permissionGuard.CUSTOMER_SERVICE_ROLES)
  const requests = repository.list().map(synchronizeRequest)
  if (scope === 'HISTORY') return requests.filter(item => HISTORY_STATUSES.includes(item.status))
  if (scope === 'ALL') return requests.filter(item => item.status !== 'DRAFT')
  return requests.filter(item => ACTIVE_STATUSES.includes(item.status))
}
function listForCurrentUser() {
  if (USE_CLOUD) return cloudRepository.listForCurrentUser()
  const user = authService.getCurrentUser()
  if (!user) throw new Error('AUTH_REQUIRED')
  return repository.list().filter(item => item.userId === user.id).map(synchronizeRequest)
}
function startHandling(requestId) {
  if (USE_CLOUD) return cloudRepository.manage('START_HANDLING', { requestId })
  const staff = permissionGuard.assertRole(permissionGuard.CUSTOMER_SERVICE_ROLES)
  const request = repository.getById(requestId)
  if (!request || !['OPEN', 'VERIFYING'].includes(request.status)) throw new Error('SUPPORT_REQUEST_NOT_OPEN')
  if (request.status === 'VERIFYING') return request
  const updated = repository.update(requestId, { status: 'VERIFYING', handlingStartedAt: new Date().toISOString(), handledBy: staff.id, statusReason: null })
  operationLogService.log(ACTIONS.EMERGENCY_SUPPORT_REQUEST_PROCESSING, { cabinetId: updated.cabinetId, lockerId: updated.lockerId, recordId: updated.recordId, detail: { supportRequestId: updated.id } })
  return updated
}
function validateForAuthorization(requestId, context) {
  permissionGuard.assertRole(permissionGuard.CUSTOMER_SERVICE_ROLES)
  const request = repository.getById(requestId)
  if (!request || !['OPEN', 'VERIFYING'].includes(request.status)) throw new Error('SUPPORT_REQUEST_NOT_OPEN')
  if (request.userId !== context.userId || request.cabinetId !== context.cabinetId) throw new Error('SUPPORT_REQUEST_CONTEXT_MISMATCH')
  if (request.lockerId && Number(request.lockerId) !== Number(context.lockerId)) throw new Error('SUPPORT_REQUEST_CONTEXT_MISMATCH')
  if (request.recordId && request.recordId !== context.recordId) throw new Error('SUPPORT_REQUEST_CONTEXT_MISMATCH')
  return request
}
function markAuthorized(requestId, authorizationId) {
  const request = repository.update(requestId, { status: 'AUTHORIZED', authorizationId, statusReason: null })
  operationLogService.log(ACTIONS.EMERGENCY_SUPPORT_REQUEST_AUTHORIZED, { cabinetId: request.cabinetId, lockerId: request.lockerId, recordId: request.recordId, detail: { supportRequestId: request.id, authorizationId } })
  return request
}
function cancelByUser(requestId) {
  if (USE_CLOUD) return cloudRepository.manage('CANCEL', { requestId })
  const user = authService.getCurrentUser()
  const request = repository.getById(requestId)
  if (!user || !request || request.userId !== user.id) throw new Error('SUPPORT_REQUEST_USER_MISMATCH')
  if (!['DRAFT', ...ACTIVE_STATUSES].includes(request.status)) throw new Error('SUPPORT_REQUEST_NOT_CANCELLABLE')
  if (request.authorizationId) {
    const authorization = authorizationRepository.getById(request.authorizationId)
    if (authorization && authorization.status === 'UNUSED') authorizationRepository.revoke(authorization.id, { revokedBy: user.id, reason: 'USER_CANCELLED_SUPPORT_REQUEST' })
  }
  const cancelled = repository.update(requestId, { status: 'CANCELLED', cancelledAt: new Date().toISOString(), statusReason: 'USER_CANCELLED' })
  operationLogService.log(ACTIONS.EMERGENCY_SUPPORT_REQUEST_CANCELLED, { cabinetId: cancelled.cabinetId, lockerId: cancelled.lockerId, recordId: cancelled.recordId, detail: { supportRequestId: cancelled.id } })
  return cancelled
}
function closeByStaff(requestId, reason = 'STAFF_RESOLVED') {
  if (USE_CLOUD) return cloudRepository.manage('CLOSE', { requestId, reason })
  const staff = permissionGuard.assertRole(permissionGuard.CUSTOMER_SERVICE_ROLES)
  const request = repository.getById(requestId)
  if (!request || !ACTIVE_STATUSES.includes(request.status)) throw new Error('SUPPORT_REQUEST_NOT_CLOSABLE')
  if (request.authorizationId) {
    const authorization = authorizationRepository.getById(request.authorizationId)
    if (authorization && authorization.status === 'UNUSED') authorizationRepository.revoke(authorization.id, { revokedBy: staff.id, reason: 'STAFF_CLOSED_SUPPORT_REQUEST' })
  }
  const resolved = repository.update(requestId, { status: 'RESOLVED', resolvedAt: new Date().toISOString(), closedBy: staff.id, statusReason: reason })
  operationLogService.log(ACTIONS.EMERGENCY_SUPPORT_REQUEST_RESOLVED, { cabinetId: resolved.cabinetId, lockerId: resolved.lockerId, recordId: resolved.recordId, detail: { supportRequestId: resolved.id, reason } })
  return resolved
}
function reopenAfterStaffRevocation(requestId) {
  if (USE_CLOUD) return cloudRepository.manage('REOPEN', { requestId })
  permissionGuard.assertRole(permissionGuard.CUSTOMER_SERVICE_ROLES)
  const request = repository.getById(requestId)
  if (!request || request.status !== 'AUTHORIZED') throw new Error('SUPPORT_REQUEST_NOT_AUTHORIZED')
  return repository.update(requestId, { status: 'OPEN', authorizationId: null, statusReason: 'AUTHORIZATION_REVOKED_BY_STAFF' })
}
function markOnsiteByRecord(recordId, issueId) {
  const requests = repository.list().filter(item => item.recordId === recordId && ACTIVE_STATUSES.includes(item.status))
  return requests.map(request => {
    const updated = repository.update(request.id, { status: 'REQUIRES_ONSITE_MAINTENANCE', issueId, statusReason: 'LOCK_HARDWARE_FAILURE' })
    operationLogService.log(ACTIONS.EMERGENCY_SUPPORT_REQUEST_ONSITE, { cabinetId: updated.cabinetId, lockerId: updated.lockerId, recordId, detail: { supportRequestId: updated.id, issueId } })
    return updated
  })
}
function resolveByAuthorization(authorizationId, reason = 'PICKUP_SUCCESS') {
  const request = repository.list().find(item => item.authorizationId === authorizationId && ACTIVE_STATUSES.includes(item.status))
  if (!request) return null
  return repository.update(request.id, { status: 'RESOLVED', resolvedAt: new Date().toISOString(), statusReason: reason })
}
function resolveByRecord(recordId, reason = 'RESOLVED') {
  const requests = repository.list().filter(item => item.recordId === recordId && ACTIVE_STATUSES.includes(item.status))
  return requests.map(request => repository.update(request.id, { status: 'RESOLVED', resolvedAt: new Date().toISOString(), statusReason: reason }))
}
function markAttemptFailed(authorizationId, issue) {
  const request = repository.list().find(item => item.authorizationId === authorizationId && ACTIVE_STATUSES.includes(item.status))
  if (!request) return null
  if (issue && issue.status === 'REQUIRES_ONSITE_MAINTENANCE') return repository.update(request.id, { status: 'REQUIRES_ONSITE_MAINTENANCE', issueId: issue.id, statusReason: issue.reason })
  return repository.update(request.id, { status: 'OPEN', authorizationId: null, statusReason: 'ELECTRONIC_UNLOCK_FAILED' })
}

module.exports = { ACTIVE_STATUSES, HISTORY_STATUSES, prepare, updateContext, bindContextByStaff, activate, listForStaff, listForCurrentUser, startHandling, validateForAuthorization, markAuthorized, cancelByUser, closeByStaff, reopenAfterStaffRevocation, markOnsiteByRecord, resolveByAuthorization, resolveByRecord, markAttemptFailed }

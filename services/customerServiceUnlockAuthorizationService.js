const permissionGuard = require('./permissionGuard')
const authService = require('./authService')
const depositRepository = require('../repositories/depositRepository')
const unlockAuthorizationService = require('./unlockAuthorizationService')
const unlockIssueRepository = require('../repositories/unlockIssueRepository')
const operationLogService = require('./operationLogService')
const ACTIONS = require('../constants/operationActions')
const cabinetRepository = require('../repositories/cabinetRepository')
const lockerRepository = require('../repositories/lockerRepository')
const emergencySupportRequestService = require('./emergencySupportRequestService')
const { USE_CLOUD } = require('../config/env')
const cloudCustomerServiceRepository = require('../repositories/cloudCustomerServiceRepository')

function issueAuthorization({ customerUserId, cabinetId, lockerId, recordId, pickupCode, reason, supportRequestId }) {
  const staff = permissionGuard.assertRole(permissionGuard.CUSTOMER_SERVICE_ROLES)
  const normalizedCustomerUserId = String(customerUserId || '').trim()
  if (!normalizedCustomerUserId) throw new Error('CUSTOMER_USER_ID_REQUIRED')
  const normalizedReason = String(reason || '').trim()
  if (normalizedReason.length < 5) throw new Error('AUTHORIZATION_REASON_REQUIRED')
  if (USE_CLOUD) return cloudCustomerServiceRepository.issueAuthorization({ customerUserId: normalizedCustomerUserId, cabinetId, lockerId, recordId, pickupCode, reason: normalizedReason, supportRequestId })
  const cabinet = cabinetRepository.getCabinet(cabinetId)
  const locker = lockerRepository.getLocker(cabinetId, lockerId)
  if (cabinet.status !== 'ACTIVE') throw new Error('CABINET_NOT_ACTIVE')
  const record = depositRepository.verifyPickupCode(cabinetId, lockerId, pickupCode)
  if (!record || record.id !== recordId) throw new Error('BUSINESS_RECORD_VERIFICATION_FAILED')
  if (supportRequestId) emergencySupportRequestService.validateForAuthorization(supportRequestId, { userId: normalizedCustomerUserId, cabinetId, lockerId, recordId: record.id })
  const existingIssue = unlockIssueRepository.getByRecordId(record.id)
  if (existingIssue && existingIssue.status === 'REQUIRES_ONSITE_MAINTENANCE') throw new Error('REQUIRES_ONSITE_MAINTENANCE')
  if (!locker || locker.enabled === false || locker.status !== 'OCCUPIED') throw new Error('LOCKER_NOT_AVAILABLE_FOR_AUTHORIZATION')
  const authorization = unlockAuthorizationService.issueCustomerServiceAuthorization({
    userId: normalizedCustomerUserId,
    cabinetId: record.cabinetId,
    lockerId: record.lockerId,
    recordId: record.id,
    source: 'CUSTOMER_SERVICE',
    reason: normalizedReason,
    issuedBy: staff.id,
    issuedByRole: staff.role
  })
  unlockIssueRepository.save({
    userId: normalizedCustomerUserId,
    cabinetId: record.cabinetId,
    lockerId: record.lockerId,
    recordId: record.id,
    status: 'CUSTOMER_SERVICE_AUTHORIZED',
    authorizationId: authorization.id,
    reason: 'CUSTOMER_SERVICE_RETRY'
  })
  operationLogService.log(ACTIONS.CUSTOMER_SERVICE_UNLOCK_AUTH_CREATED, {
    cabinetId: record.cabinetId,
    lockerId: record.lockerId,
    recordId: record.id,
    detail: { operatorUserId: staff.id, customerUserId: normalizedCustomerUserId, authorizationId: authorization.id, expiresAt: authorization.expiresAt, reason: normalizedReason }
  })
  if (supportRequestId) emergencySupportRequestService.markAuthorized(supportRequestId, authorization.id)
  return authorization
}

module.exports = { issueAuthorization }

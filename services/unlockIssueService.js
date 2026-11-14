const unlockIssueRepository = require('../repositories/unlockIssueRepository')
const lockerRepository = require('../repositories/lockerRepository')
const depositRepository = require('../repositories/depositRepository')
const doorSensorService = require('./doorSensorService')
const permissionGuard = require('./permissionGuard')
const authService = require('./authService')
const operationLogService = require('./operationLogService')
const ACTIONS = require('../constants/operationActions')
const { MAX_ELECTRONIC_UNLOCK_FAILURES, BLE_TRANSPORT } = require('../config/env')
const maintenanceWorkOrderService = require('./maintenanceWorkOrderService')
const emergencySupportRequestService = require('./emergencySupportRequestService')
const COUNTED_SOURCES = new Set(['STORE', 'STORE_REOPEN', 'NORMAL_PICKUP', 'CUSTOMER_SERVICE'])

function recordFailure(authorization, failureCode) {
  if (!authorization || !COUNTED_SOURCES.has(authorization.source)) throw new Error('UNLOCK_FAILURE_SOURCE_UNSUPPORTED')
  const issueRecordId = authorization.recordId || `store-${authorization.cabinetId}-${Number(authorization.lockerId)}`
  const previous = unlockIssueRepository.getByRecordId(issueRecordId)
  const locker = lockerRepository.getLocker(authorization.cabinetId, authorization.lockerId)
  if (!locker) throw new Error('LOCKER_NOT_FOUND')
  const currentFailures = Math.max(0, Number(locker.consecutiveUnlockFailures) || 0)
  const failedAttempts = Math.min(MAX_ELECTRONIC_UNLOCK_FAILURES, currentFailures + 1)
  const requiresOnsite = failedAttempts >= MAX_ELECTRONIC_UNLOCK_FAILURES
  const hasWaitingPickup = locker.status === 'OCCUPIED' || Boolean(locker.currentRecordId)
  const issue = unlockIssueRepository.save({
    ...(previous || {}),
    userId: authorization.userId,
    cabinetId: authorization.cabinetId,
    lockerId: authorization.lockerId,
    recordId: issueRecordId,
    authorizationId: authorization.id,
    failedAttempts,
    consecutiveUnlockFailures: failedAttempts,
    remainingAttempts: Math.max(0, MAX_ELECTRONIC_UNLOCK_FAILURES - failedAttempts),
    hasWaitingPickup,
    lastFailureCode: failureCode,
    reason: requiresOnsite ? 'LOCK_HARDWARE_FAILURE' : 'ELECTRONIC_UNLOCK_FAILED',
    status: requiresOnsite ? 'REQUIRES_ONSITE_MAINTENANCE' : (authorization.source === 'CUSTOMER_SERVICE' ? 'CUSTOMER_SERVICE_AUTHORIZED' : 'NORMAL_RETRY')
  })
  if (!requiresOnsite) {
    lockerRepository.updateLocker(authorization.cabinetId, authorization.lockerId, {
      consecutiveUnlockFailures: failedAttempts,
      totalUnlockAttempts: Math.max(0, Number(locker.totalUnlockAttempts) || 0) + 1,
      totalUnlockFailures: Math.max(0, Number(locker.totalUnlockFailures) || 0) + 1
    })
  }
  if (requiresOnsite) {
    lockerRepository.reportLockerFault(authorization.cabinetId, authorization.lockerId, 'LOCK_HARDWARE_FAILURE')
    lockerRepository.updateLocker(authorization.cabinetId, authorization.lockerId, {
      consecutiveUnlockFailures: failedAttempts,
      totalUnlockAttempts: Math.max(0, Number(locker.totalUnlockAttempts) || 0) + 1,
      totalUnlockFailures: Math.max(0, Number(locker.totalUnlockFailures) || 0) + 1
    })
    maintenanceWorkOrderService.createForLocker({ cabinetId: authorization.cabinetId, lockerId: authorization.lockerId, recordId: authorization.recordId || null, issueId: issue.id, source: authorization.source === 'STORE' ? 'STORE_UNLOCK_FAILURE' : authorization.source === 'STORE_REOPEN' ? 'STORE_REOPEN_FAILURE' : 'UNLOCK_FAILURE', reason: 'LOCK_HARDWARE_FAILURE', faultCode: 'LOCK_HARDWARE_FAILURE', requiresSelfCheck: true })
    operationLogService.log(ACTIONS.UNLOCK_REQUIRES_ONSITE_MAINTENANCE, {
      cabinetId: authorization.cabinetId,
      lockerId: authorization.lockerId,
      recordId: authorization.recordId,
      detail: { issueId: issue.id, failedAttempts, reason: issue.reason }
    })
  }
  return issue
}
function recordSuccess(cabinetId, lockerId) {
  const locker = lockerRepository.getLocker(cabinetId, lockerId)
  if (!locker) return Promise.resolve(locker)
  return Promise.resolve(lockerRepository.updateLocker(cabinetId, lockerId, {
    consecutiveUnlockFailures: 0,
    totalUnlockAttempts: Math.max(0, Number(locker.totalUnlockAttempts) || 0) + 1,
    totalUnlockSuccesses: Math.max(0, Number(locker.totalUnlockSuccesses) || 0) + 1
  }))
}
function resolve(recordId) {
  const issue = unlockIssueRepository.getByRecordId(recordId)
  if (!issue) return null
  return unlockIssueRepository.save({ ...issue, status: 'RESOLVED' })
}
function getIssuesForCabinet(cabinetId) {
  permissionGuard.assertRole(permissionGuard.CUSTOMER_SERVICE_ROLES)
  return unlockIssueRepository.getByCabinet(cabinetId)
}
function recordManualEmergencyUnlock(cabinetId, lockerId) {
  const manager = permissionGuard.assertRole(permissionGuard.MANAGEMENT_ROLES)
  const record = depositRepository.getActiveRecord(cabinetId, lockerId)
  if (!record) throw new Error('NO_WAITING_PICKUP_RECORD')
  const issue = unlockIssueRepository.getByRecordId(record.id)
  if (!issue || issue.status !== 'REQUIRES_ONSITE_MAINTENANCE') throw new Error('ONSITE_MAINTENANCE_NOT_REQUIRED')
  const activeOrder = maintenanceWorkOrderService.listForManager('ACTIVE').find(item => item.cabinetId === cabinetId && Number(item.lockerId) === Number(lockerId))
  const faultStillActive = !(activeOrder && activeOrder.selfCheckPassedAt)
  if (BLE_TRANSPORT === 'MOCK') doorSensorService.mockSetDoorStatus(cabinetId, lockerId, 'OPEN')
  const completedRecord = depositRepository.completePickup({
    cabinetId,
    lockerId,
    recordId: record.id,
    pickedByUserId: issue.userId,
    completedByStaffId: manager.id,
    pickupMethod: 'MANUAL_EMERGENCY',
    allowMaintenance: true
  })
  lockerRepository.updateLocker(cabinetId, lockerId, {
    status: 'MAINTENANCE',
    maintenanceSource: 'HARDWARE_FAULT',
    previousStatus: 'EMPTY',
    faultActive: faultStillActive,
    ...(faultStillActive ? { faultCode: 'LOCK_HARDWARE_FAILURE' } : {})
  })
  const updatedIssue = unlockIssueRepository.save({ ...issue, manualUnlockCompletedAt: new Date().toISOString() })
  emergencySupportRequestService.resolveByRecord(record.id, 'MANUAL_EMERGENCY_UNLOCK_COMPLETED')
  operationLogService.log(ACTIONS.MANUAL_EMERGENCY_UNLOCK, {
    cabinetId,
    lockerId: Number(lockerId),
    recordId: record.id,
    detail: { issueId: updatedIssue.id, operatorUserId: authService.getCurrentUser().id, remainsInMaintenance: true }
  })
  return { issue: updatedIssue, record: completedRecord, locker: lockerRepository.getLocker(cabinetId, lockerId) }
}

module.exports = { recordFailure, recordSuccess, resolve, getIssuesForCabinet, recordManualEmergencyUnlock }

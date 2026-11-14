const unlockAuthorizationService = require('./unlockAuthorizationService')
const unlockIssueService = require('./unlockIssueService')
const bluetoothService = require('./bluetoothService')
const lockService = require('./lockService')
const doorSensorService = require('./doorSensorService')
const depositRepository = require('../repositories/depositRepository')
const operationLogService = require('./operationLogService')
const ACTIONS = require('../constants/operationActions')
const emergencySupportRequestService = require('./emergencySupportRequestService')
const unlockHealthService = require('./unlockHealthService')
const { USE_CLOUD } = require('../config/env')
const cloudUnlockAuthorizationRepository = require('../repositories/cloudUnlockAuthorizationRepository')
const operationEventService = require('./operationEventService')
const EVENT_TYPES = require('../constants/operationEventTypes')

const COUNTED_ENTITY_FAILURE_CODES = new Set(['BLE_LOCKER_OPEN_FAILED', 'LOCK_DRIVER_FAILED', 'DOOR_NOT_OPEN'])

function confirmTimedOutOpenWasNotSuccessful(authorization) {
  return doorSensorService.refreshDoorStatus(authorization.cabinetId, authorization.lockerId)
    .then(status => status !== 'OPEN')
    .catch(() => false)
}

function shouldCountEntityFailure(error, authorization) {
  if (!error) return Promise.resolve(false)
  if (error.entityUnlockFailure === true || COUNTED_ENTITY_FAILURE_CODES.has(error.message)) return Promise.resolve(true)
  // 超时只有在补查确认门仍未打开时才计入；连接、权限和写入前错误不计数。
  if (error.message === 'BLE_COMMAND_TIMEOUT') return confirmTimedOutOpenWasNotSuccessful(authorization)
  return Promise.resolve(false)
}

function executeAuthorization({ authorizationId, currentCabinetId }) {
  let authorization
  try { authorization = unlockAuthorizationService.validateForExecution(authorizationId, currentCabinetId) }
  catch (error) { return Promise.reject(error) }
  if (!bluetoothService.isConnectedTo(authorization.cabinetId)) return Promise.reject(new Error('BLUETOOTH_NOT_CONNECTED_TO_CABINET'))

  let hardwareOpened = false
  return Promise.resolve(unlockAuthorizationService.consume(authorization.id, currentCabinetId)).then(consumedAuthorization => {
    authorization = consumedAuthorization
    const hardwareEnvelope = unlockAuthorizationService.createHardwareEnvelope(authorization)
    const isCustomerService = authorization.source === 'CUSTOMER_SERVICE'
    const isPickup = authorization.source === 'NORMAL_PICKUP' || isCustomerService
    const isStoreOpen = authorization.source === 'STORE' || authorization.source === 'STORE_REOPEN'
    const context = {
      cabinetId: authorization.cabinetId,
      lockerId: authorization.lockerId,
      recordId: authorization.recordId,
      detail: { operatorUserId: authorization.issuedBy, operatorRole: authorization.issuedByRole, customerUserId: authorization.userId, authorizationId: authorization.id, source: authorization.source }
    }
    const attemptAction = isCustomerService
      ? ACTIONS.CUSTOMER_SERVICE_UNLOCK_ATTEMPT
      : authorization.source === 'ADMIN_OCCUPIED_CLEAR'
        ? ACTIONS.ADMIN_OPEN_OCCUPIED_LOCKER
        : authorization.source === 'STORE_REOPEN'
          ? ACTIONS.USER_REOPEN_STORE_LOCK
          : authorization.source === 'STORE'
            ? ACTIONS.USER_OPEN_STORE_LOCK
            : ACTIONS.USER_OPEN_PICKUP_LOCK
    operationLogService.log(attemptAction, context)
    return lockService.openLock(authorization.cabinetId, authorization.lockerId, { hardwareEnvelope }).then(result => {
      if (!result.doorOpened || doorSensorService.getDoorStatus(authorization.cabinetId, authorization.lockerId) !== 'OPEN') {
        const error = new Error('DOOR_NOT_OPEN')
        error.entityUnlockFailure = true
        throw error
      }
      hardwareOpened = true
      // @OPEN 成功后立即清零同一柜格的连续失败次数；同步失败不能反向否定已经打开的柜门。
      return Promise.resolve(unlockHealthService.recordSuccess(authorization)).catch(() => null).then(() => {
        if (!isPickup) return { authorization, hardwareResult: result, record: null }
        const record = depositRepository.completePickup({
          cabinetId: authorization.cabinetId,
          lockerId: authorization.lockerId,
          recordId: authorization.recordId,
          pickedByUserId: authorization.userId,
          pickupMethod: isCustomerService ? 'CUSTOMER_SERVICE_AUTHORIZED' : 'USER_SELF_SERVICE',
          authorizationId: authorization.id,
          doorOpened: true
        })
        return Promise.resolve(record).then(completedRecord => {
          operationEventService.recordEvent(EVENT_TYPES.PICKUP_COMPLETED, { cabinetId: authorization.cabinetId, lockerId: authorization.lockerId, recordId: completedRecord && completedRecord.id, success: true, metadata: { source: authorization.source } })
          if (!USE_CLOUD) {
            unlockIssueService.resolve(completedRecord.id)
            emergencySupportRequestService.resolveByAuthorization(authorization.id)
            operationLogService.log(isCustomerService ? ACTIONS.CUSTOMER_SERVICE_UNLOCK_SUCCESS : ACTIONS.USER_PICKUP_SUCCESS, context)
          }
          return { authorization, hardwareResult: result, record: completedRecord }
        })
      })
    }).catch(error => {
      // 门已经确认打开后，后续业务落库失败不能倒算成一次实体开锁失败。
      if (hardwareOpened) throw error
      if (!isPickup && !isStoreOpen) {
        operationLogService.log(ACTIONS.LOCK_OPEN_FAILED, { ...context, result: 'FAILED', detail: { ...context.detail, reason: error.message } })
        throw error
      }
      return shouldCountEntityFailure(error, authorization).then(shouldCount => {
        if (!shouldCount) throw error
        if (USE_CLOUD) {
          return cloudUnlockAuthorizationRepository.reportFailure(authorization.id, error.message).then(issue => {
            error.issue = issue
            throw error
          }).catch(reportError => {
            if (reportError === error) throw error
            error.reportError = reportError
            throw error
          })
        }
        const issue = unlockIssueService.recordFailure(authorization, error.message)
        if (isPickup) emergencySupportRequestService.markAttemptFailed(authorization.id, issue)
        if (isCustomerService) {
          operationLogService.log(ACTIONS.CUSTOMER_SERVICE_UNLOCK_FAILED, {
            ...context,
            result: 'FAILED',
            detail: { ...context.detail, reason: error.message, issueStatus: issue.status, failedAttempts: issue.failedAttempts, consecutiveUnlockFailures: issue.consecutiveUnlockFailures, remainingAttempts: issue.remainingAttempts }
          })
        }
        error.issue = issue
        throw error
      })
    })
  })
}

module.exports = { executeAuthorization }

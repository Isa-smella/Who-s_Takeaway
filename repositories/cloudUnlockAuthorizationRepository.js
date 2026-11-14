const cloudService = require('../services/cloudService')
const authorizationRepository = require('./unlockAuthorizationRepository')
const cabinetRepository = require('./cabinetRepository')
const { IS_DEVELOPMENT } = require('../config/env')

const STORE_REOPEN_FUNCTION_VERSION = '2026-09-02-store-auth-v4'

function createStore(options) {
  const requestedRecordId = options.recordId ? String(options.recordId) : ''
  return cloudService.callFunction('createStoreUnlockAuthorization', {
    cabinetId: options.cabinetId,
    lockerId: Number(options.lockerId),
    recordId: requestedRecordId || null
  }).then(authorization => {
    if (requestedRecordId && (!authorization || authorization.source !== 'STORE_REOPEN' || String(authorization.recordId || '') !== requestedRecordId)) {
      const error = new Error('STORE_REOPEN_CLOUD_FUNCTION_OUTDATED')
      error.cloudDetail = {
        functionVersion: authorization && authorization.functionVersion || '',
        expectedFunctionVersion: STORE_REOPEN_FUNCTION_VERSION
      }
      throw error
    }
    return authorizationRepository.create(authorization)
  })
}

function verifyPickup(options) {
  return cloudService.callFunction('verifyPickup', {
    cabinetId: options.cabinetId,
    lockerId: Number(options.lockerId),
    pickupCode: String(options.pickupCode || '')
  }).then(result => {
    if (!result || !result.authorization) throw new Error('VERIFY_PICKUP_RESPONSE_INVALID')
    return authorizationRepository.create(result.authorization)
  })
}

function consume(authorizationId, cabinetId) {
  return cloudService.callFunction('consumeUnlockAuthorization', { authorizationId, cabinetId }).then(authorization => {
    const local = authorizationRepository.getById(authorization.id)
    if (!local) return authorizationRepository.create(authorization)
    return authorizationRepository.update(authorization.id, authorization)
  })
}
function reportFailure(authorizationId, failureCode) {
  return cloudService.callFunction('reportUnlockFailure', { authorizationId, failureCode: String(failureCode || 'DOOR_NOT_OPEN') }).then(result => {
    if (result && result.locker) cabinetRepository.applyCloudLockerSnapshot(result.locker.cabinetId, result.locker)
    return result.issue
  })
}

function reportSuccess(authorizationId) {
  if (IS_DEVELOPMENT) console.info('[UNLOCK_STATS_V2]', { stage: 'CLIENT_SUCCESS_REQUEST', functionName: 'reportUnlockFailure', success: true })
  return cloudService.callFunction('reportUnlockFailure', { authorizationId, success: true }).then(result => {
    if (IS_DEVELOPMENT) console.info('[UNLOCK_STATS_V2]', {
      stage: 'CLIENT_SUCCESS_RESPONSE', statsVersion: result && result.statsVersion || null,
      cabinetId: result && result.locker && result.locker.cabinetId,
      lockerId: result && result.locker && result.locker.id,
      totalUnlockAttempts: result && result.totalUnlockAttempts,
      totalUnlockSuccesses: result && result.totalUnlockSuccesses,
      totalUnlockFailures: result && result.totalUnlockFailures,
      consecutiveUnlockFailures: result && result.consecutiveUnlockFailures
    })
    if (!result || result.statsVersion !== 2) console.warn('[UNLOCK_STATS_V2] reportUnlockFailure returned an older stats version', { expected: 2, received: result && result.statsVersion || null })
    if (result && result.locker) {
      cabinetRepository.applyCloudLockerSnapshot(result.locker.cabinetId, result.locker)
    }
    return result
  }).catch(error => {
    console.warn('[UNLOCK_STATS_V2] success stats report failed', error)
    throw error
  })
}

module.exports = { createStore, verifyPickup, consume, reportFailure, reportSuccess }

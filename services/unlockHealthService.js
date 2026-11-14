const { USE_CLOUD } = require('../config/env')
const lockerRepository = require('../repositories/lockerRepository')
const unlockIssueService = require('./unlockIssueService')
const cloudUnlockAuthorizationRepository = require('../repositories/cloudUnlockAuthorizationRepository')
const COUNTED_SOURCES = new Set(['STORE', 'STORE_REOPEN', 'NORMAL_PICKUP', 'CUSTOMER_SERVICE'])

function recordSuccess(authorization) {
  if (!authorization || !COUNTED_SOURCES.has(authorization.source)) return Promise.resolve(null)
  if (USE_CLOUD) return cloudUnlockAuthorizationRepository.reportSuccess(authorization.id)
  return unlockIssueService.recordSuccess(authorization.cabinetId, authorization.lockerId)
}

function getFailureSnapshot(cabinetId, lockerId) {
  let locker = null
  try { locker = lockerRepository.getLocker(cabinetId, lockerId) } catch (error) {}
  if (!locker) return null
  const consecutiveUnlockFailures = Math.max(0, Number(locker.consecutiveUnlockFailures) || 0)
  return {
    consecutiveUnlockFailures,
    remainingAttempts: Math.max(0, 3 - consecutiveUnlockFailures),
    hasWaitingPickup: locker.status === 'OCCUPIED' || Boolean(locker.currentRecordId),
    status: locker.status
  }
}

module.exports = { recordSuccess, getFailureSnapshot }

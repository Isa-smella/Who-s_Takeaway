const cloudService = require('../services/cloudService')
const cabinetRepository = require('./cabinetRepository')
const { createDepositRecord } = require('../models/index')

function confirmDeposit({ cabinetId, lockerId, doorClosed, pickupCode, recordId }) {
  return cloudService.callFunction('createDeposit', { cabinetId, lockerId: Number(lockerId), doorClosed: doorClosed === true, pickupCode: String(pickupCode || ''), recordId: recordId || null }).then(result => {
    if (!result || !result.record || !result.locker) throw new Error('CREATE_DEPOSIT_RESPONSE_INVALID')
    if (recordId && result.record.id !== recordId) throw new Error('REDEPOSIT_RESPONSE_INVALID')
    cabinetRepository.applyCloudLockerSnapshot(cabinetId, result.locker)
    return createDepositRecord(result.record)
  })
}
function completePickup(options) {
  return cloudService.callFunction('completePickup', {
    authorizationId: options.authorizationId,
    cabinetId: options.cabinetId,
    lockerId: Number(options.lockerId),
    recordId: options.recordId,
    doorOpened: options.doorOpened === true
  }).then(result => {
    if (!result || !result.record || !result.locker) throw new Error('COMPLETE_PICKUP_RESPONSE_INVALID')
    cabinetRepository.applyCloudLockerSnapshot(options.cabinetId, result.locker)
    return createDepositRecord(result.record)
  })
}
function listMyRecords() {
  const collected = { deposits: [], pickups: [] }
  function load(depositOffset = 0, pickupOffset = 0) {
    return cloudService.callFunction('listMyRecords', { depositOffset, pickupOffset }).then(result => {
      collected.deposits.push(...(result.deposits || []).map(createDepositRecord))
      collected.pickups.push(...(result.pickups || []).map(createDepositRecord))
      if (result.nextDepositOffset !== null || result.nextPickupOffset !== null) {
        return load(result.nextDepositOffset === null ? -1 : result.nextDepositOffset, result.nextPickupOffset === null ? -1 : result.nextPickupOffset)
      }
      return collected
    })
  }
  return load()
}

module.exports = { confirmDeposit, completePickup, listMyRecords }

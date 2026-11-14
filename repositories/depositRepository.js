const cabinetRepository = require('./cabinetRepository')
const unlockAuthorizationRepository = require('./unlockAuthorizationRepository')
const cloudDepositRepository = require('./cloudDepositRepository')
const { USE_CLOUD } = require('../config/env')

function getRecordsAccessibleByUser(user) {
  if (!user) return []
  if (['ADMIN', 'CUSTOMER_SERVICE', 'DEVELOPER'].includes(user.role)) return cabinetRepository.getRecords()
  return cabinetRepository.getRecordsForUser(user.id)
}
function getDepositRecordsForUser(userId) {
  if (!userId) return []
  if (USE_CLOUD) return cloudDepositRepository.listMyRecords().then(result => result.deposits)
  return cabinetRepository.getRecords().filter(item => (item.depositorUserId || item.riderId) === userId)
}
function getPickupRecordsForUser(userId) {
  if (!userId) return []
  if (USE_CLOUD) return cloudDepositRepository.listMyRecords().then(result => result.pickups)
  return cabinetRepository.getSuccessfulPickupRecords().filter(item => item.pickedByUserId === userId)
}
function completePickup(options) {
  if (USE_CLOUD) return cloudDepositRepository.completePickup(options)
  const record = cabinetRepository.completePickup(options)
  unlockAuthorizationRepository.revokeWhere(item => item.recordId === record.id, { revokedBy: 'SYSTEM', reason: 'RECORD_COMPLETED' })
  return record
}

module.exports = {
  getRecords: cabinetRepository.getRecords,
  getSuccessfulPickupRecords: cabinetRepository.getSuccessfulPickupRecords,
  getRecordsForUser: cabinetRepository.getRecordsForUser,
  getRecordsAccessibleByUser,
  getDepositRecordsForUser,
  getPickupRecordsForUser,
  getActiveRecord: cabinetRepository.getActiveRecord,
  verifyPickupCode: cabinetRepository.verifyPickupCode,
  confirmDeposit: options => USE_CLOUD ? cloudDepositRepository.confirmDeposit(options) : cabinetRepository.confirmDeposit(options),
  completePickup
}

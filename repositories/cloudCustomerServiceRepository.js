const cloudService = require('../services/cloudService')
const authorizationRepository = require('./unlockAuthorizationRepository')
const { createEmergencyUnlockAuthorization } = require('../models/index')

function getCabinetOverview(cabinetId, audit = false) {
  return cloudService.callFunction('getSupportCabinetOverview', { cabinetId, audit })
}
function listSupportCabinets() { return cloudService.callFunction('listSupportCabinets') }
function verifyPickupCode(data) {
  return cloudService.callFunction('verifyEmergencyPickupCode', data)
}
function issueAuthorization(data) {
  return cloudService.callFunction('createCustomerServiceUnlockAuthorization', data).then(createEmergencyUnlockAuthorization)
}
function listActiveForCurrentUser() {
  return cloudService.callFunction('listMyUnlockAuthorizations').then(items => items.map(item => {
    const existing = authorizationRepository.getById(item.id)
    return existing ? authorizationRepository.update(item.id, item) : authorizationRepository.create(item)
  }))
}
function revokeByCurrentUser(authorizationId) {
  return cloudService.callFunction('revokeUnlockAuthorization', { authorizationId }).then(item => {
    const existing = authorizationRepository.getById(item.id)
    return existing ? authorizationRepository.update(item.id, item) : authorizationRepository.create(item)
  })
}

module.exports = { getCabinetOverview, listSupportCabinets, verifyPickupCode, issueAuthorization, listActiveForCurrentUser, revokeByCurrentUser }

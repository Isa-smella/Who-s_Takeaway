const cloudService = require('../services/cloudService')
const { createEmergencySupportRequest } = require('../models/index')

function manage(action, data = {}) {
  return cloudService.callFunction('manageEmergencySupportRequest', { action, ...data }).then(createEmergencySupportRequest)
}
function listForCurrentUser() {
  return loadAll({ audience: 'USER' })
}
function listForStaff(scope = 'ACTIVE') {
  return loadAll({ audience: 'STAFF', scope })
}
function loadAll(filters, offset = 0, items = []) {
  return cloudService.callFunction('listEmergencySupportRequests', { ...filters, offset }).then(result => {
    items.push(...(result.items || []).map(createEmergencySupportRequest))
    return result.nextOffset === null ? items : loadAll(filters, result.nextOffset, items)
  })
}

module.exports = { manage, listForCurrentUser, listForStaff }

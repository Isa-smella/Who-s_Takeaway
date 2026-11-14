const cloudService = require('../services/cloudService')

function getAnalytics(params = {}) {
  return cloudService.callFunction('getOperationsAnalytics', params)
}

module.exports = { getAnalytics }

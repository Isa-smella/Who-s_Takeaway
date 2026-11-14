const cloudService = require('../services/cloudService')
const { createOperationLog } = require('../models/index')

function query(filters = {}, offset = 0, items = []) {
  return cloudService.callFunction('getOperationLogs', { filters, offset }).then(result => {
    items.push(...(result.items || []).map(createOperationLog))
    return result.nextOffset === null ? items : query(filters, result.nextOffset, items)
  })
}

module.exports = { query }

const cloudService = require('../services/cloudService')
const { createFeedback } = require('../models/index')

function createFeedbackRecord(data) {
  return cloudService.callFunction('submitFeedback', {
    cabinetId: data.cabinetId,
    lockerId: data.lockerId,
    problemType: data.problemType,
    description: data.description
  }).then(createFeedback)
}
function getMyFeedback() {
  const items = []
  function load(offset = 0) {
    return cloudService.callFunction('listMyFeedback', { offset }).then(result => {
      items.push(...(result.items || []).map(createFeedback))
      return result.nextOffset === null ? items : load(result.nextOffset)
    })
  }
  return load()
}
function getFeedbackForStaff(offset = 0, items = []) {
  return cloudService.callFunction('listFeedbackForStaff', { offset }).then(result => {
    items.push(...(result.items || []).map(createFeedback))
    return result.nextOffset === null ? items : getFeedbackForStaff(result.nextOffset, items)
  })
}
function updateFeedbackStatus(feedbackId, status) {
  return cloudService.callFunction('updateFeedbackStatus', { feedbackId, status }).then(createFeedback)
}

module.exports = { createFeedbackRecord, getMyFeedback, getFeedbackForStaff, updateFeedbackStatus }

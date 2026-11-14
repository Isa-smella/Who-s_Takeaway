const cabinetRepository = require('./cabinetRepository')
const cloudFeedbackRepository = require('./cloudFeedbackRepository')
const { USE_CLOUD } = require('../config/env')

function getFeedbackForUser(userId) {
  if (!userId) return []
  if (USE_CLOUD) return cloudFeedbackRepository.getMyFeedback()
  return cabinetRepository.getFeedback().filter(item => item.userId === userId)
}

module.exports = {
  getFeedback: cabinetRepository.getFeedback,
  getFeedbackForUser,
  createFeedback: data => USE_CLOUD ? cloudFeedbackRepository.createFeedbackRecord(data) : cabinetRepository.createFeedbackRecord(data),
  updateFeedbackStatus: cabinetRepository.updateFeedbackStatus
}

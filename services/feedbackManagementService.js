const feedbackRepository = require('../repositories/feedbackRepository')
const permissionGuard = require('./permissionGuard')
const operationLogService = require('./operationLogService')
const ACTIONS = require('../constants/operationActions')
const { USE_CLOUD } = require('../config/env')
const cloudFeedbackRepository = require('../repositories/cloudFeedbackRepository')

function assertStaff() { return permissionGuard.assertRole(permissionGuard.CUSTOMER_SERVICE_ROLES) }

function getFeedbackList() {
  assertStaff()
  if (USE_CLOUD) return cloudFeedbackRepository.getFeedbackForStaff()
  return feedbackRepository.getFeedback()
}

function updateStatus(feedbackId, status) {
  assertStaff()
  if (USE_CLOUD) return cloudFeedbackRepository.updateFeedbackStatus(feedbackId, status)
  const before = feedbackRepository.getFeedback().find(item => item.id === feedbackId)
  if (!before) throw new Error('FEEDBACK_NOT_FOUND')
  const feedback = feedbackRepository.updateFeedbackStatus(feedbackId, status)
  operationLogService.log(ACTIONS.FEEDBACK_UPDATED, {
    cabinetId: feedback.cabinetId,
    lockerId: feedback.lockerId,
    detail: { feedbackId, previousStatus: before.status, status }
  })
  return feedback
}

module.exports = { getFeedbackList, updateStatus }

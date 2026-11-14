const feedbackRepository = require('../repositories/feedbackRepository')
const cabinetRepository = require('../repositories/cabinetRepository')
const lockerRepository = require('../repositories/lockerRepository')
const authService = require('./authService')
const permissionGuard = require('./permissionGuard')
const operationLogService = require('./operationLogService')
const ACTIONS = require('../constants/operationActions')
const { USE_CLOUD } = require('../config/env')

const PROBLEM_TYPES = ['LOCK_FAILED', 'CODE_ERROR', 'FOOD_MISSING', 'LOCKER_DAMAGED', 'DEVICE_OFFLINE', 'OTHER']

function submit({ problemType, cabinetId, lockerId = null, description = '' }) {
  permissionGuard.assertCoreAccess()
  const normalizedCabinetId = String(cabinetId || '').trim()
  const normalizedLockerId = lockerId === null || lockerId === '' ? null : Number(lockerId)
  try {
    if (!normalizedCabinetId) throw new Error('CABINET_ID_REQUIRED')
    if (!PROBLEM_TYPES.includes(problemType)) throw new Error('FEEDBACK_PROBLEM_TYPE_INVALID')
    if (!USE_CLOUD) cabinetRepository.getCabinet(normalizedCabinetId)
    if (!USE_CLOUD && normalizedLockerId !== null) {
      if (!Number.isInteger(normalizedLockerId) || normalizedLockerId < 1) throw new Error('LOCKER_ID_INVALID')
      if (!lockerRepository.getLocker(normalizedCabinetId, normalizedLockerId)) throw new Error('LOCKER_NOT_FOUND')
    }
    const user = authService.getCurrentUser()
    const feedback = feedbackRepository.createFeedback({
      userId: user.id, role: user.role, cabinetId: normalizedCabinetId, lockerId: normalizedLockerId,
      problemType, description: String(description || '').trim().slice(0, 500), createdAt: new Date().toISOString(), status: 'PENDING'
    })
    if (USE_CLOUD) return Promise.resolve(feedback)
    operationLogService.log(ACTIONS.FEEDBACK_CREATED, { cabinetId: feedback.cabinetId, lockerId: feedback.lockerId, detail: { feedbackId: feedback.id, problemType: feedback.problemType } })
    return feedback
  } catch (error) {
    if (!USE_CLOUD) operationLogService.log(ACTIONS.FEEDBACK_CREATED, { cabinetId: normalizedCabinetId || null, lockerId: normalizedLockerId, result: 'FAILED', detail: { reason: error.message, problemType } })
    throw error
  }
}

module.exports = { PROBLEM_TYPES, submit }

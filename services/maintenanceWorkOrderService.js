const repository = require('../repositories/maintenanceWorkOrderRepository')
const authService = require('./authService')
const permissionGuard = require('./permissionGuard')
const operationLogService = require('./operationLogService')
const ACTIONS = require('../constants/operationActions')
const { USE_CLOUD } = require('../config/env')
const cloudRepository = require('../repositories/cloudMaintenanceWorkOrderRepository')
const { CHECK_KEYS } = require('../constants/maintenanceChecks')
function createOrGet(data) {
  const existing = repository.findActiveForTarget(data.cabinetId, data.lockerId)
  if (existing) {
    const escalatedToHardwareFault = data.requiresInspection === true || data.source !== 'MANUAL_MAINTENANCE'
    return repository.save({
      ...existing,
      recordId: data.recordId || existing.recordId,
      issueId: data.issueId || existing.issueId,
      faultCode: data.faultCode || existing.faultCode,
      reason: data.reason || existing.reason,
      source: escalatedToHardwareFault ? (data.source || existing.source) : existing.source,
      requiresSelfCheck: true,
      requiresInspection: existing.requiresInspection || escalatedToHardwareFault
    })
  }
  const now = new Date().toISOString()
  const creator = authService.getCurrentUser()
  const order = repository.save({
    ...data,
    requiresSelfCheck: true,
    requiresInspection: data.requiresInspection !== undefined ? data.requiresInspection === true : data.source !== 'MANUAL_MAINTENANCE',
    id: `maintenance-${data.cabinetId}-${data.lockerId || 'cabinet'}-${Date.now()}-${Math.floor(Math.random() * 100000)}`,
    type: data.lockerId ? 'LOCKER' : 'CABINET',
    status: 'PENDING',
    createdBy: creator ? creator.id : 'SYSTEM',
    createdAt: now,
    updatedAt: now
  })
  operationLogService.log(ACTIONS.MAINTENANCE_ORDER_CREATED, { cabinetId: order.cabinetId, lockerId: order.lockerId, recordId: order.recordId, detail: { maintenanceOrderId: order.id, faultCode: order.faultCode, source: order.source } })
  return order
}
function createForLocker(data) { return createOrGet({ ...data, type: 'LOCKER' }) }
function createForCabinet(data) { return createOrGet({ ...data, lockerId: null, type: 'CABINET' }) }
function listForManager(scope = 'ACTIVE') {
  permissionGuard.assertRole(permissionGuard.MANAGEMENT_ROLES)
  if (USE_CLOUD) return cloudRepository.list(scope)
  const orders = repository.list()
  if (scope === 'HISTORY') return orders.filter(item => item.status === 'RESOLVED')
  if (scope === 'ALL') return orders
  return orders.filter(item => repository.ACTIVE_STATUSES.includes(item.status))
}
function getForManager(orderId) {
  permissionGuard.assertRole(permissionGuard.MANAGEMENT_ROLES)
  if (USE_CLOUD) return cloudRepository.getById(orderId)
  const order = repository.getById(orderId)
  if (!order) throw new Error('MAINTENANCE_ORDER_NOT_FOUND')
  return order
}
function start(orderId) {
  const manager = permissionGuard.assertRole(permissionGuard.MANAGEMENT_ROLES)
  if (USE_CLOUD) return cloudRepository.manage('START', { orderId })
  const order = getForManager(orderId)
  if (order.status !== 'PENDING') throw new Error('MAINTENANCE_ORDER_ALREADY_STARTED')
  const updated = repository.save({ ...order, status: 'IN_PROGRESS', assignedTo: manager.id, startedAt: new Date().toISOString() })
  operationLogService.log(ACTIONS.MAINTENANCE_ORDER_STARTED, { cabinetId: updated.cabinetId, lockerId: updated.lockerId, recordId: updated.recordId, detail: { maintenanceOrderId: updated.id, assignedTo: manager.id } })
  return updated
}
function arrive(orderId) {
  const manager = permissionGuard.assertRole(permissionGuard.MANAGEMENT_ROLES)
  if (USE_CLOUD) return cloudRepository.manage('ARRIVE', { orderId })
  const order = getForManager(orderId)
  if (!['IN_PROGRESS', 'ONSITE'].includes(order.status)) throw new Error('MAINTENANCE_ORDER_NOT_IN_PROGRESS')
  if (order.status === 'ONSITE') return order
  const updated = repository.save({ ...order, status: 'ONSITE', assignedTo: order.assignedTo || manager.id, arrivedAt: new Date().toISOString() })
  operationLogService.log(ACTIONS.MAINTENANCE_ORDER_ARRIVED, { cabinetId: updated.cabinetId, lockerId: updated.lockerId, recordId: updated.recordId, detail: { maintenanceOrderId: updated.id } })
  return updated
}
function saveInspection(orderId, inspection, notes = '') {
  permissionGuard.assertRole(permissionGuard.MANAGEMENT_ROLES)
  if (USE_CLOUD) return cloudRepository.manage('SAVE_INSPECTION', { orderId, inspection, notes })
  const order = getForManager(orderId)
  if (!['ONSITE', 'MANUAL_UNLOCK_COMPLETED', 'SELF_CHECK_PASSED'].includes(order.status)) throw new Error('MAINTENANCE_ORDER_NOT_ONSITE')
  const normalized = {}
  CHECK_KEYS.forEach(key => { normalized[key] = ['NORMAL', 'ABNORMAL', 'NOT_CHECKED'].includes(inspection[key]) ? inspection[key] : 'NOT_CHECKED' })
  const nextInspection = Object.prototype.hasOwnProperty.call(order.inspection || {}, 'doorSensor') ? { ...normalized, doorSensor: order.inspection.doorSensor } : normalized
  const updated = repository.save({ ...order, inspection: nextInspection, inspectionNotes: String(notes || '').trim().slice(0, 500), inspectedAt: new Date().toISOString() })
  operationLogService.log(ACTIONS.MAINTENANCE_ORDER_INSPECTION_SAVED, { cabinetId: updated.cabinetId, lockerId: updated.lockerId, recordId: updated.recordId, detail: { maintenanceOrderId: updated.id, inspection: normalized } })
  return updated
}
function markManualUnlockCompleted(orderId) {
  permissionGuard.assertRole(permissionGuard.MANAGEMENT_ROLES)
  if (USE_CLOUD) return cloudRepository.manage('MANUAL_EMERGENCY_UNLOCK', { orderId })
  const order = getForManager(orderId)
  if (!order.issueId || !order.recordId) throw new Error('MAINTENANCE_ORDER_HAS_NO_EMERGENCY_PICKUP')
  if (!['ONSITE', 'SELF_CHECK_PASSED'].includes(order.status)) throw new Error('MAINTENANCE_ORDER_NOT_ONSITE')
  if (order.manualUnlockCompletedAt) throw new Error('MANUAL_EMERGENCY_UNLOCK_ALREADY_COMPLETED')
  const updated = repository.save({ ...order, status: order.selfCheckPassedAt ? 'SELF_CHECK_PASSED' : 'MANUAL_UNLOCK_COMPLETED', manualUnlockCompletedAt: new Date().toISOString() })
  operationLogService.log(ACTIONS.MAINTENANCE_ORDER_MANUAL_UNLOCK, { cabinetId: updated.cabinetId, lockerId: updated.lockerId, recordId: updated.recordId, detail: { maintenanceOrderId: updated.id } })
  return updated
}
function markSelfCheckPassed(cabinetId, lockerId = null, orderId = '') {
  permissionGuard.assertRole(permissionGuard.MANAGEMENT_ROLES)
  if (USE_CLOUD) {
    if (!orderId) throw new Error('MAINTENANCE_ORDER_ID_REQUIRED')
    return cloudRepository.manage('SELF_CHECK_PASSED', { orderId })
  }
  const order = repository.findActiveForTarget(cabinetId, lockerId)
  if (!order) return null
  const status = ['ONSITE', 'MANUAL_UNLOCK_COMPLETED', 'SELF_CHECK_PASSED'].includes(order.status) ? 'SELF_CHECK_PASSED' : order.status
  const updated = repository.save({ ...order, status, selfCheckPassedAt: new Date().toISOString() })
  operationLogService.log(ACTIONS.MAINTENANCE_ORDER_SELF_CHECK_PASSED, { cabinetId, lockerId, recordId: updated.recordId, detail: { maintenanceOrderId: updated.id } })
  return updated
}
function inspectionPassed(order) { return CHECK_KEYS.every(key => order.inspection && order.inspection[key] === 'NORMAL') }
function assertReadyForRestore(cabinetId, lockerId = null) {
  const order = repository.findActiveForTarget(cabinetId, lockerId)
  if (!order || !order.selfCheckPassedAt) throw new Error('MAINTENANCE_SELF_CHECK_REQUIRED')
  if (order.requiresInspection && !inspectionPassed(order)) throw new Error('MAINTENANCE_INSPECTION_REQUIRED')
  if (order.recordId && order.issueId && !order.manualUnlockCompletedAt) throw new Error('EMERGENCY_PICKUP_HANDOVER_REQUIRED')
  return true
}
function resolveForTarget(cabinetId, lockerId = null) {
  const manager = authService.getCurrentUser()
  const order = repository.findActiveForTarget(cabinetId, lockerId)
  if (!order) return null
  const updated = repository.save({ ...order, status: 'RESOLVED', resolvedAt: new Date().toISOString(), resolvedBy: manager ? manager.id : 'SYSTEM' })
  operationLogService.log(ACTIONS.MAINTENANCE_ORDER_RESOLVED, { cabinetId, lockerId, recordId: updated.recordId, detail: { maintenanceOrderId: updated.id } })
  return updated
}

module.exports = { CHECK_KEYS, createForLocker, createForCabinet, listForManager, getForManager, start, arrive, saveInspection, markManualUnlockCompleted, markSelfCheckPassed, inspectionPassed, assertReadyForRestore, resolveForTarget }

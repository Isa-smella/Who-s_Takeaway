const lockerRepository = require('../repositories/lockerRepository')
const cabinetRepository = require('../repositories/cabinetRepository')
const operationLogService = require('./operationLogService')
const ACTIONS = require('../constants/operationActions')
const permissionGuard = require('./permissionGuard')
const maintenanceWorkOrderService = require('./maintenanceWorkOrderService')
const unlockAuthorizationService = require('./unlockAuthorizationService')
const unlockIssueRepository = require('../repositories/unlockIssueRepository')
const { USE_CLOUD } = require('../config/env')
const cloudCabinetManagementRepository = require('../repositories/cloudCabinetManagementRepository')
const cloudMaintenanceWorkOrderRepository = require('../repositories/cloudMaintenanceWorkOrderRepository')

function reportLockerFault(cabinetId, lockerId, faultCode) {
  if (USE_CLOUD) return cloudMaintenanceWorkOrderRepository.reportDeviceHealth('LOCKER_FAULT', { cabinetId, lockerId, faultCode })
  const locker = lockerRepository.reportLockerFault(cabinetId, lockerId, faultCode)
  unlockAuthorizationService.autoRevokeForLocker(cabinetId, lockerId, 'LOCKER_HARDWARE_FAULT')
  maintenanceWorkOrderService.createForLocker({ cabinetId, lockerId, recordId: locker.currentRecordId, source: 'DEVICE_FAULT', reason: 'LOCKER_HARDWARE_FAULT', faultCode: locker.faultCode, requiresSelfCheck: true })
  operationLogService.log(ACTIONS.LOCKER_FAULT_DETECTED, {
    cabinetId,
    lockerId: Number(lockerId),
    detail: { faultCode: locker.faultCode, automaticMaintenance: true }
  })
  return locker
}

function reportHealthCheckPassed(cabinetId, lockerId) {
  if (USE_CLOUD) return cloudMaintenanceWorkOrderRepository.reportDeviceHealth('LOCKER_SELF_CHECK', { cabinetId, lockerId, passed: true })
  const locker = lockerRepository.reportLockerHealthCheckPassed(cabinetId, lockerId)
  maintenanceWorkOrderService.markSelfCheckPassed(cabinetId, lockerId)
  operationLogService.log(ACTIONS.LOCKER_HEALTH_CHECK_PASSED, {
    cabinetId,
    lockerId: Number(lockerId),
    detail: { requiresManagerRestore: true }
  })
  return locker
}

function reportTelemetry(cabinetId, telemetry) {
  if (USE_CLOUD) return cloudMaintenanceWorkOrderRepository.reportDeviceHealth('TELEMETRY', { cabinetId, ...telemetry })
  return Promise.resolve(require('../repositories/deviceRepository').mockReportTelemetry(cabinetId, telemetry))
}

function setManualMaintenance(cabinetId, lockerId) {
  permissionGuard.assertRole(permissionGuard.MANAGEMENT_ROLES)
  if (USE_CLOUD) return cloudCabinetManagementRepository.manage('SET_LOCKER_MAINTENANCE', { cabinetId, lockerId })
  const locker = lockerRepository.setLockerMaintenance(cabinetId, lockerId)
  unlockAuthorizationService.autoRevokeForLocker(cabinetId, lockerId, 'LOCKER_MAINTENANCE')
  maintenanceWorkOrderService.createForLocker({ cabinetId, lockerId, source: 'MANUAL_MAINTENANCE', reason: 'MANUAL_MAINTENANCE', faultCode: null, requiresSelfCheck: true, requiresInspection: false })
  operationLogService.log(ACTIONS.LOCKER_SET_MAINTENANCE, { cabinetId, lockerId: Number(lockerId) })
  return locker
}

function restoreLocker(cabinetId, lockerId) {
  permissionGuard.assertRole(permissionGuard.MANAGEMENT_ROLES)
  if (USE_CLOUD) {
    return cloudCabinetManagementRepository.manage('RESTORE_LOCKER', { cabinetId, lockerId }).then(locker => {
      // 管理操作成功后立即覆盖用户端缓存，避免继续显示旧的 MAINTENANCE。
      try { cabinetRepository.applyCloudLockerSnapshot(cabinetId, locker) } catch (error) {}
      return locker
    })
  }
  try {
    const order = maintenanceWorkOrderService.listForManager('ACTIVE').find(item => item.cabinetId === cabinetId && Number(item.lockerId || 0) === Number(lockerId))
    maintenanceWorkOrderService.assertReadyForRestore(cabinetId, lockerId)
    const locker = lockerRepository.restoreLocker(cabinetId, lockerId)
    maintenanceWorkOrderService.resolveForTarget(cabinetId, lockerId)
    if (order && order.recordId) {
      const issue = unlockIssueRepository.getByRecordId(order.recordId)
      if (issue) unlockIssueRepository.save({ ...issue, status: 'RESOLVED' })
    }
    operationLogService.log(ACTIONS.LOCKER_RESTORE, { cabinetId, lockerId: Number(lockerId) })
    return locker
  } catch (error) {
    operationLogService.log(ACTIONS.LOCKER_RESTORE_REJECTED, {
      cabinetId,
      lockerId: Number(lockerId),
      result: 'FAILED',
      detail: { reason: error.message }
    })
    throw error
  }
}

function reportCabinetFault(cabinetId, faultCode) {
  if (USE_CLOUD) return cloudMaintenanceWorkOrderRepository.reportDeviceHealth('CABINET_FAULT', { cabinetId, faultCode })
  const cabinet = cabinetRepository.reportCabinetFault(cabinetId, faultCode)
  unlockAuthorizationService.autoRevokeForCabinet(cabinetId, 'CABINET_HARDWARE_FAULT')
  maintenanceWorkOrderService.createForCabinet({ cabinetId, source: 'DEVICE_FAULT', reason: 'CABINET_HARDWARE_FAULT', faultCode: cabinet.faultCode, requiresSelfCheck: true })
  operationLogService.log(ACTIONS.CABINET_FAULT_DETECTED, {
    cabinetId,
    detail: { faultCode: cabinet.faultCode, automaticMaintenance: true }
  })
  return cabinet
}

function reportCabinetHealthCheckPassed(cabinetId) {
  if (USE_CLOUD) return cloudMaintenanceWorkOrderRepository.reportDeviceHealth('CABINET_SELF_CHECK', { cabinetId, passed: true })
  const cabinet = cabinetRepository.reportCabinetHealthCheckPassed(cabinetId)
  maintenanceWorkOrderService.markSelfCheckPassed(cabinetId, null)
  operationLogService.log(ACTIONS.CABINET_HEALTH_CHECK_PASSED, {
    cabinetId,
    detail: { requiresManagerRestore: true }
  })
  return cabinet
}

module.exports = { reportLockerFault, reportHealthCheckPassed, reportTelemetry, setManualMaintenance, restoreLocker, reportCabinetFault, reportCabinetHealthCheckPassed }

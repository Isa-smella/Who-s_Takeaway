const cabinetRepository = require('../repositories/cabinetRepository')
const permissionGuard = require('./permissionGuard')
const operationLogService = require('./operationLogService')
const ACTIONS = require('../constants/operationActions')
const unlockAuthorizationService = require('./unlockAuthorizationService')
const maintenanceWorkOrderService = require('./maintenanceWorkOrderService')
const authorizationRepository = require('../repositories/unlockAuthorizationRepository')
const { USE_CLOUD } = require('../config/env')
const cloudRepository = require('../repositories/cloudCabinetManagementRepository')
const OCCUPIED_CLEAR_CONFIRM_WINDOW_MS = 5 * 60 * 1000

function assertManager() { return permissionGuard.assertRole(permissionGuard.MANAGEMENT_ROLES) }

function createCabinet(data) {
  assertManager()
  if (USE_CLOUD) return cloudRepository.manage('CREATE_CABINET', { data })
  const cabinet = cabinetRepository.createCabinetRecord(data)
  operationLogService.log(ACTIONS.CABINET_CREATED, {
    cabinetId: cabinet.id,
    detail: { name: cabinet.name, locationName: cabinet.locationName, lockerCount: cabinet.lockerCount, bleIdentifier: cabinet.bleIdentifier }
  })
  return cabinet
}

function updateCabinet(cabinetId, patch) {
  assertManager()
  if (USE_CLOUD) return cloudRepository.manage('UPDATE_CABINET', { cabinetId, data: patch })
  const before = cabinetRepository.getCabinet(cabinetId)
  const cabinet = cabinetRepository.updateCabinetRecord(cabinetId, patch)
  operationLogService.log(ACTIONS.CABINET_UPDATED, {
    cabinetId,
    detail: { before: { name: before.name, locationName: before.locationName, bleIdentifier: before.bleIdentifier, lockerCount: before.lockerCount }, after: patch }
  })
  return cabinet
}

function setMaintenance(cabinetId) {
  assertManager()
  if (USE_CLOUD) return cloudRepository.manage('SET_CABINET_MAINTENANCE', { cabinetId })
  const cabinet = cabinetRepository.setCabinetMaintenance(cabinetId)
  maintenanceWorkOrderService.createForCabinet({ cabinetId, source: 'MANUAL_MAINTENANCE', reason: 'MANUAL_MAINTENANCE', requiresSelfCheck: true, requiresInspection: false })
  unlockAuthorizationService.autoRevokeForCabinet(cabinetId, 'CABINET_MAINTENANCE')
  operationLogService.log(ACTIONS.CABINET_SET_MAINTENANCE, { cabinetId })
  return cabinet
}

function restoreCabinet(cabinetId) {
  assertManager()
  if (USE_CLOUD) return cloudRepository.manage('RESTORE_CABINET', { cabinetId })
  try {
    maintenanceWorkOrderService.assertReadyForRestore(cabinetId, null)
    const cabinet = cabinetRepository.restoreCabinet(cabinetId)
    maintenanceWorkOrderService.resolveForTarget(cabinetId, null)
    operationLogService.log(ACTIONS.CABINET_RESTORED, { cabinetId })
    return cabinet
  } catch (error) {
    operationLogService.log(ACTIONS.CABINET_RESTORE_REJECTED, { cabinetId, result: 'FAILED', detail: { reason: error.message } })
    throw error
  }
}

function disableCabinet(cabinetId) {
  return setMaintenance(cabinetId)
}

function reenableCabinet(cabinetId) {
  return normalizeLegacyDisabled(cabinetId)
}

function normalizeLegacyDisabled(cabinetId, lockerId = null) {
  assertManager()
  if (USE_CLOUD) return cloudRepository.manage(lockerId === null ? 'SET_CABINET_MAINTENANCE' : 'SET_LOCKER_MAINTENANCE', lockerId === null ? { cabinetId } : { cabinetId, lockerId })
  if (lockerId !== null) {
    const locker = cabinetRepository.normalizeLegacyDisabledLocker(cabinetId, lockerId)
    maintenanceWorkOrderService.createForLocker({
      cabinetId, lockerId, recordId: locker.currentRecordId || null,
      source: locker.faultActive ? 'DEVICE_FAULT' : 'MANUAL_MAINTENANCE',
      reason: locker.faultActive ? 'LOCKER_HARDWARE_FAULT' : 'MANUAL_MAINTENANCE',
      faultCode: locker.faultCode || null, requiresSelfCheck: true, requiresInspection: Boolean(locker.faultActive)
    })
    operationLogService.log(ACTIONS.LOCKER_SET_MAINTENANCE, { cabinetId, lockerId: Number(lockerId), detail: { migratedFromDisabled: true } })
    return locker
  }
  const cabinet = cabinetRepository.normalizeLegacyDisabledCabinet(cabinetId)
  if (cabinet.status === 'MAINTENANCE') {
    maintenanceWorkOrderService.createForCabinet({
      cabinetId,
      source: cabinet.faultActive ? 'DEVICE_FAULT' : 'MANUAL_MAINTENANCE',
      reason: cabinet.faultActive ? 'CABINET_HARDWARE_FAULT' : 'MANUAL_MAINTENANCE',
      faultCode: cabinet.faultCode || null,
      requiresSelfCheck: true,
      requiresInspection: Boolean(cabinet.faultActive)
    })
  }
  operationLogService.log(ACTIONS.CABINET_SET_MAINTENANCE, { cabinetId, detail: { migratedFromDisabled: true, faultActive: cabinet.faultActive } })
  return cabinet
}

function disableLocker(cabinetId, lockerId) {
  assertManager()
  if (USE_CLOUD) return cloudRepository.manage('SET_LOCKER_MAINTENANCE', { cabinetId, lockerId })
  const locker = cabinetRepository.disableLocker(cabinetId, lockerId)
  unlockAuthorizationService.autoRevokeForLocker(cabinetId, lockerId, 'LOCKER_MAINTENANCE')
  maintenanceWorkOrderService.createForLocker({ cabinetId, lockerId, source: 'MANUAL_MAINTENANCE', reason: 'MANUAL_MAINTENANCE', faultCode: null, requiresSelfCheck: true, requiresInspection: false })
  operationLogService.log(ACTIONS.LOCKER_SET_MAINTENANCE, { cabinetId, lockerId: Number(lockerId) })
  return locker
}

function reenableLocker(cabinetId, lockerId) {
  return normalizeLegacyDisabled(cabinetId, lockerId)
}

function correctLockerBusinessStatus(cabinetId, lockerId, targetStatus) {
  assertManager()
  const normalizedStatus = String(targetStatus || '').toUpperCase()
  if (USE_CLOUD) {
    return cloudRepository.manage('CORRECT_LOCKER_BUSINESS_STATUS', { cabinetId, lockerId, targetStatus: normalizedStatus }).then(locker => {
      try { cabinetRepository.applyCloudLockerSnapshot(cabinetId, locker) } catch (error) {}
      return locker
    })
  }
  const before = cabinetRepository.getLocker(cabinetId, lockerId)
  const locker = cabinetRepository.correctLockerBusinessStatus(cabinetId, lockerId, normalizedStatus)
  operationLogService.log(ACTIONS.LOCKER_BUSINESS_STATUS_CORRECTED, {
    cabinetId,
    lockerId: Number(lockerId),
    detail: { beforeStatus: before.status, afterStatus: locker.status, recordId: locker.currentRecordId || null }
  })
  return locker
}

function clearOccupiedLockerAsEmpty(cabinetId, lockerId, authorizationId) {
  const manager = assertManager()
  const authorization = authorizationRepository.getById(authorizationId)
  if (!authorization || authorization.source !== 'ADMIN_OCCUPIED_CLEAR') throw new Error('OCCUPIED_CLEAR_AUTHORIZATION_INVALID')
  if (authorization.status !== 'USED' || authorization.userId !== manager.id || authorization.cabinetId !== cabinetId || Number(authorization.lockerId) !== Number(lockerId)) throw new Error('OCCUPIED_CLEAR_AUTHORIZATION_INVALID')
  const usedAt = new Date(authorization.usedAt).getTime()
  if (authorization.clearConfirmedAt || !Number.isFinite(usedAt) || usedAt > Date.now() + 60 * 1000 || Date.now() - usedAt > OCCUPIED_CLEAR_CONFIRM_WINDOW_MS) throw new Error('OCCUPIED_CLEAR_AUTHORIZATION_INVALID')
  if (USE_CLOUD) {
    return cloudRepository.manage('CLEAR_OCCUPIED_LOCKER_AS_EMPTY', { cabinetId, lockerId, authorizationId }).then(result => {
      try { cabinetRepository.applyCloudLockerSnapshot(cabinetId, result.locker) } catch (error) {}
      authorizationRepository.update(authorizationId, { clearConfirmedAt: new Date().toISOString() })
      return result
    })
  }
  const result = cabinetRepository.clearOccupiedLockerAsEmpty({ cabinetId, lockerId, managerUserId: manager.id })
  authorizationRepository.update(authorizationId, { clearConfirmedAt: new Date().toISOString() })
  unlockAuthorizationService.autoRevokeForLocker(cabinetId, lockerId, 'ADMIN_CONFIRMED_PHYSICALLY_EMPTY')
  operationLogService.log(ACTIONS.ADMIN_CLEAR_OCCUPIED_LOCKER, {
    cabinetId, lockerId: Number(lockerId), recordId: result.record.id,
    detail: { authorizationId, closureReason: 'PHYSICALLY_EMPTY' }
  })
  return result
}

function getCabinetDetail(cabinetId) { assertManager(); return cloudRepository.getDetail(cabinetId) }
module.exports = { createCabinet, updateCabinet, setMaintenance, restoreCabinet, disableCabinet, reenableCabinet, disableLocker, reenableLocker, normalizeLegacyDisabled, correctLockerBusinessStatus, clearOccupiedLockerAsEmpty, getCabinetDetail }

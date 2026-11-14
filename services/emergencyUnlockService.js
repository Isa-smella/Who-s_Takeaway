const permissionGuard = require('./permissionGuard')
const cabinetRepository = require('../repositories/cabinetRepository')
const lockerRepository = require('../repositories/lockerRepository')
const unlockIssueRepository = require('../repositories/unlockIssueRepository')
const operationLogService = require('./operationLogService')
const ACTIONS = require('../constants/operationActions')
const { USE_CLOUD } = require('../config/env')
const cloudCustomerServiceRepository = require('../repositories/cloudCustomerServiceRepository')

function assertEmergencyPermission() {
  return permissionGuard.assertRole(permissionGuard.CUSTOMER_SERVICE_ROLES)
}

function validateTarget(cabinetId, lockerId) {
  const normalizedCabinetId = String(cabinetId || '').trim()
  const normalizedLockerId = Number(lockerId)
  if (!normalizedCabinetId) throw new Error('CABINET_ID_REQUIRED')
  if (!Number.isInteger(normalizedLockerId) || normalizedLockerId < 1) throw new Error('LOCKER_ID_REQUIRED')
  const cabinet = cabinetRepository.getCabinet(normalizedCabinetId)
  if (cabinet.status === 'DISABLED') throw new Error('CABINET_DISABLED')
  const locker = lockerRepository.getLocker(normalizedCabinetId, normalizedLockerId)
  if (!locker) throw new Error('LOCKER_NOT_FOUND')
  if (locker.enabled === false) throw new Error('LOCKER_DISABLED')
  return { cabinet, locker, cabinetId: normalizedCabinetId, lockerId: normalizedLockerId }
}

function getPickupVerificationInfo(cabinetId, lockerId) {
  assertEmergencyPermission()
  const target = validateTarget(cabinetId, lockerId)
  const record = cabinetRepository.getActiveRecord(target.cabinetId, target.lockerId)
  if (!record) throw new Error('NO_WAITING_PICKUP_RECORD')
  return {
    recordId: record.id,
    cabinetId: record.cabinetId,
    lockerId: record.lockerId,
    pickupCode: record.pickupCode,
    storedAt: record.storedAt,
    status: record.status
  }
}

function getSupportCabinets() {
  assertEmergencyPermission()
  if (USE_CLOUD) return cloudCustomerServiceRepository.listSupportCabinets()
  return cabinetRepository.listCabinets().slice().sort((a, b) => a.id.localeCompare(b.id)).map(cabinet => {
    const lockers = lockerRepository.getLockers(cabinet.id)
    return {
      ...cabinet,
      statusLabel: { ACTIVE: '正常', MAINTENANCE: '维修中', DISABLED: '维修中' }[cabinet.status] || cabinet.status,
      occupiedCount: lockers.filter(locker => Boolean(cabinetRepository.getActiveRecord(cabinet.id, locker.id))).length,
      availableForEmergency: cabinet.status !== 'DISABLED'
    }
  })
}

function getCabinetLockerOverview(cabinetId, options = {}) {
  assertEmergencyPermission()
  if (USE_CLOUD) return cloudCustomerServiceRepository.getCabinetOverview(String(cabinetId || '').trim(), options.audit !== false)
  const target = String(cabinetId || '').trim()
  if (!target) throw new Error('CABINET_ID_REQUIRED')
  const cabinet = cabinetRepository.getCabinet(target)
  const lockers = lockerRepository.getLockers(target).map(locker => {
    const record = cabinetRepository.getActiveRecord(target, locker.id)
    const issue = record ? unlockIssueRepository.getByRecordId(record.id) : null
    return {
      ...locker,
      pickupCode: record ? record.pickupCode : '',
      recordId: record ? record.id : '',
      recordStatus: record ? record.status : '',
      handlingStatus: issue ? issue.status : '',
      canIssueAuthorization: cabinet.status === 'ACTIVE' && locker.enabled !== false && locker.status === 'OCCUPIED' && Boolean(record) && (!issue || issue.status !== 'REQUIRES_ONSITE_MAINTENANCE')
    }
  })
  if (options.audit !== false) {
    operationLogService.log(ACTIONS.EMERGENCY_PICKUP_CODES_VIEWED, {
      cabinetId: target,
      detail: { waitingPickupCount: lockers.filter(locker => Boolean(locker.recordId)).length }
    })
  }
  return { cabinet, lockers }
}

function verifyEmergencyPickupCode({ cabinetId, lockerId, pickupCode }) {
  assertEmergencyPermission()
  if (USE_CLOUD) return cloudCustomerServiceRepository.verifyPickupCode({ cabinetId, lockerId, pickupCode })
  let target
  try { target = validateTarget(cabinetId, lockerId) } catch (error) { throw error }
  const record = cabinetRepository.getActiveRecord(target.cabinetId, target.lockerId)
  const context = {
    cabinetId: target.cabinetId,
    lockerId: target.lockerId,
    recordId: record ? record.id : null,
    detail: { providedCodeLength: String(pickupCode || '').length }
  }
  if (!record || !/^\d{4}$/.test(String(pickupCode || '')) || record.pickupCode !== String(pickupCode)) {
    operationLogService.log(ACTIONS.EMERGENCY_PICKUP_CODE_FAILED, { ...context, result: 'FAILED', detail: { ...context.detail, reason: record ? 'PICKUP_CODE_MISMATCH' : 'NO_WAITING_PICKUP_RECORD' } })
    throw new Error(record ? 'PICKUP_CODE_MISMATCH' : 'NO_WAITING_PICKUP_RECORD')
  }
  operationLogService.log(ACTIONS.EMERGENCY_PICKUP_CODE_VERIFIED, context)
  return { recordId: record.id, verified: true }
}

module.exports = { getSupportCabinets, getCabinetLockerOverview, getPickupVerificationInfo, verifyEmergencyPickupCode }

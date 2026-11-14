/** 数据模型工厂。页面只消费模型，不依赖未来数据库实现。 */
function createUser(data = {}) {
  const registrationSequence = Number.isInteger(Number(data.registrationSequence)) && Number(data.registrationSequence) > 0 ? Number(data.registrationSequence) : 0
  const registrationNumber = data.registrationNumber || (registrationSequence ? String(registrationSequence).padStart(5, '0') : '')
  return {
    id: data.id || 'mock-user',
    openid: data.openid || '',
    role: data.role || 'USER',
    registrationSequence,
    registrationNumber,
    nickname: registrationNumber || data.nickname || '',
    avatarUrl: data.avatarUrl || ''
  }
}
function createCabinet(data = {}) {
  const now = new Date().toISOString()
  const bleIdentifier = data.bleIdentifier || data.bluetoothDeviceId || ''
  return {
    id: data.id,
    name: data.name || `湖's Takeaway ${data.id}`,
    locationName: data.locationName || '',
    bleIdentifier,
    bluetoothDeviceId: bleIdentifier,
    lockerCount: Number(data.lockerCount) || 0,
    status: data.status || 'ACTIVE',
    notes: data.notes || '',
    maintenanceSource: data.maintenanceSource || null,
    faultActive: Boolean(data.faultActive),
    faultCode: data.faultCode || null,
    faultReportedAt: data.faultReportedAt || null,
    healthCheckPassedAt: data.healthCheckPassedAt || null,
    batteryVoltage: data.batteryVoltage == null ? null : Number(data.batteryVoltage),
    batteryLevel: data.batteryLevel == null ? null : Number(data.batteryLevel),
    lastBleSeenAt: data.lastBleSeenAt || null,
    createdAt: data.createdAt || now,
    updatedAt: data.updatedAt || data.createdAt || now,
    deletedAt: data.deletedAt || null
  }
}
function createLocker(data = {}) {
  return {
    id: data.id, cabinetId: data.cabinetId, controllerId: data.controllerId || 'A',
    status: data.status || 'EMPTY', doorStatus: data.doorStatus || 'CLOSED',
    enabled: data.enabled !== false,
    currentRecordId: data.currentRecordId || null, storedAt: data.storedAt || null,
    maintenanceSource: data.maintenanceSource || null,
    previousStatus: data.previousStatus || null,
    faultActive: Boolean(data.faultActive),
    faultCode: data.faultCode || null,
    faultReportedAt: data.faultReportedAt || null,
    healthCheckPassedAt: data.healthCheckPassedAt || null,
    consecutiveUnlockFailures: Math.max(0, Number(data.consecutiveUnlockFailures) || 0),
    totalUnlockAttempts: Math.max(0, Number(data.totalUnlockAttempts) || 0),
    totalUnlockSuccesses: Math.max(0, Number(data.totalUnlockSuccesses) || 0),
    totalUnlockFailures: Math.max(0, Number(data.totalUnlockFailures) || 0),
    disabledAt: data.disabledAt || null
  }
}
function createDepositRecord(data = {}) {
  return {
    id: data.id,
    lockerId: data.lockerId,
    cabinetId: data.cabinetId,
    // riderId 仅用于兼容旧 Mock 数据；新记录统一使用 depositorUserId。
    depositorUserId: data.depositorUserId || data.riderId || '',
    pickupCode: data.pickupCode,
    storedAt: data.storedAt,
    initialStoredAt: data.initialStoredAt || data.storedAt,
    reconfirmedAt: data.reconfirmedAt || null,
    pickedAt: data.pickedAt || null,
    pickedByUserId: data.pickedByUserId || '',
    completedByStaffId: data.completedByStaffId || '',
    pickupMethod: data.pickupMethod || '',
    adminClearedAt: data.adminClearedAt || null,
    adminClearedBy: data.adminClearedBy || '',
    closureReason: data.closureReason || '',
    status: data.status || 'WAITING_PICKUP'
  }
}
function createFeedback(data = {}) {
  return {
    id: data.id,
    userId: data.userId,
    role: data.role,
    cabinetId: data.cabinetId,
    lockerId: data.lockerId || null,
    problemType: data.problemType || 'OTHER',
    description: data.description || '',
    createdAt: data.createdAt || new Date().toISOString(),
    status: data.status || 'PENDING'
  }
}
function createDeviceTelemetry(data = {}) {
  return {
    cabinetId: data.cabinetId,
    batteryPercent: Number.isFinite(Number(data.batteryPercent)) ? Number(data.batteryPercent) : 100,
    voltage: Number.isFinite(Number(data.voltage)) ? Number(data.voltage) : 4.2,
    onlineStatus: data.onlineStatus || 'ONLINE',
    firmwareVersion: data.firmwareVersion || '',
    reportedAt: data.reportedAt || new Date().toISOString()
  }
}
function createPrivacyConsent(data = {}) {
  return {
    id: data.id,
    userId: data.userId,
    agreementVersion: data.agreementVersion,
    privacyVersion: data.privacyVersion,
    agreedAt: data.agreedAt
  }
}
function createOperationLog(data = {}) {
  return {
    id: data.id,
    userId: data.userId || '',
      registrationNumber: data.registrationNumber || '',
    role: data.role || '',
    cabinetId: data.cabinetId || null,
    lockerId: data.lockerId || null,
    recordId: data.recordId || null,
    action: data.action,
    result: data.result || 'SUCCESS',
    detail: data.detail || {},
    createdAt: data.createdAt,
    clientInfo: data.clientInfo || {}
  }
}
function createEmergencyUnlockAuthorization(data = {}) {
  return {
    id: data.id,
    userId: data.userId,
    cabinetId: data.cabinetId,
    lockerId: Number(data.lockerId),
    recordId: data.recordId,
    source: data.source || 'CUSTOMER_SERVICE',
    reason: data.reason || '',
    issuedBy: data.issuedBy || '',
    issuedByRole: data.issuedByRole || '',
    token: data.token,
    nonce: data.nonce || '',
    protocolVersion: data.protocolVersion || 'MOCK_V1',
    command: data.command || 'OPEN_LOCK',
    maintenanceOrderId: data.maintenanceOrderId || null,
    createdAt: data.createdAt,
    expiresAt: data.expiresAt,
    status: data.status || 'UNUSED',
    usedAt: data.usedAt || null,
    revokedAt: data.revokedAt || null,
    revokedBy: data.revokedBy || null,
    revocationReason: data.revocationReason || null
  }
}
function createUnlockIssue(data = {}) {
  return {
    id: data.id,
    userId: data.userId,
    cabinetId: data.cabinetId,
    lockerId: Number(data.lockerId),
    recordId: data.recordId,
    reason: data.reason || '',
    status: data.status || 'NORMAL_RETRY',
    failedAttempts: Number(data.failedAttempts) || 0,
    consecutiveUnlockFailures: Math.max(0, Number(data.consecutiveUnlockFailures) || Number(data.failedAttempts) || 0),
    remainingAttempts: data.remainingAttempts === undefined ? null : Math.max(0, Number(data.remainingAttempts) || 0),
    hasWaitingPickup: Boolean(data.hasWaitingPickup),
    lastFailureCode: data.lastFailureCode || '',
    authorizationId: data.authorizationId || null,
    manualUnlockCompletedAt: data.manualUnlockCompletedAt || null,
    createdAt: data.createdAt,
    updatedAt: data.updatedAt
  }
}
function createEmergencySupportRequest(data = {}) {
  return {
    id: data.id,
    userId: data.userId,
    cabinetId: data.cabinetId || null,
    lockerId: data.lockerId ? Number(data.lockerId) : null,
    recordId: data.recordId || null,
    status: data.status || 'DRAFT',
    authorizationId: data.authorizationId || null,
    createdAt: data.createdAt,
    activatedAt: data.activatedAt || null,
    handlingStartedAt: data.handlingStartedAt || null,
    handledBy: data.handledBy || null,
    cancelledAt: data.cancelledAt || null,
    resolvedAt: data.resolvedAt || null,
    closedBy: data.closedBy || null,
    statusReason: data.statusReason || null,
    issueId: data.issueId || null,
    expiresAt: data.expiresAt,
    updatedAt: data.updatedAt
  }
}
function createMaintenanceWorkOrder(data = {}) {
  const inspection = data.inspection || {}
  return {
    id: data.id,
    type: data.type || (data.lockerId ? 'LOCKER' : 'CABINET'),
    cabinetId: data.cabinetId,
    lockerId: data.lockerId ? Number(data.lockerId) : null,
    recordId: data.recordId || null,
    issueId: data.issueId || null,
    source: data.source || 'HARDWARE_FAULT',
    reason: data.reason || '',
    faultCode: data.faultCode || null,
    status: data.status || 'PENDING',
    requiresSelfCheck: data.requiresSelfCheck !== false,
    requiresInspection: data.requiresInspection !== undefined ? data.requiresInspection === true : data.source !== 'MANUAL_MAINTENANCE',
    assignedTo: data.assignedTo || null,
    createdBy: data.createdBy || null,
    createdAt: data.createdAt,
    startedAt: data.startedAt || null,
    arrivedAt: data.arrivedAt || null,
    manualUnlockCompletedAt: data.manualUnlockCompletedAt || null,
    inspection: {
      electronicLock: inspection.electronicLock || 'NOT_CHECKED',
      wiring: inspection.wiring || 'NOT_CHECKED',
      driver: inspection.driver || 'NOT_CHECKED',
      power: inspection.power || 'NOT_CHECKED',
      ...(Object.prototype.hasOwnProperty.call(inspection, 'doorSensor') ? { doorSensor: inspection.doorSensor } : {})
    },
    inspectionNotes: data.inspectionNotes || '',
    inspectedAt: data.inspectedAt || null,
    selfCheckPassedAt: data.selfCheckPassedAt || null,
    resolvedAt: data.resolvedAt || null,
    resolvedBy: data.resolvedBy || null,
    updatedAt: data.updatedAt
  }
}

module.exports = { createUser, createCabinet, createLocker, createDepositRecord, createFeedback, createDeviceTelemetry, createPrivacyConsent, createOperationLog, createEmergencyUnlockAuthorization, createUnlockIssue, createEmergencySupportRequest, createMaintenanceWorkOrder }

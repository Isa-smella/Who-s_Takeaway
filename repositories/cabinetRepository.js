const { createCabinet, createLocker, createDepositRecord, createFeedback } = require('../models/index')
const { USE_CLOUD } = require('../config/env')
const cloudService = require('../services/cloudService')

const STORAGE_KEY = 'LAKES_TAKEAWAY_MOCK_DATA_V2'
const LEGACY_STORAGE_KEY = 'LAKES_TAKEAWAY_MOCK_DATA_V1'
const cloudCabinetCache = {}
function hasActiveHardwareFault(target = {}) {
  const active = target.faultActive === true || target.faultActive === 1 || target.faultActive === 'true'
  if (!active) return false
  const passedAt = Date.parse(target.healthCheckPassedAt || '')
  const reportedAt = Date.parse(target.faultReportedAt || '')
  return !(Number.isFinite(passedAt) && Number.isFinite(reportedAt) && passedAt >= reportedAt)
}
function assertMockBackend(operation) {
  if (USE_CLOUD) throw new Error(`CLOUD_${operation}_NOT_IMPLEMENTED`)
}

function emptyStore() {
  return { version: 2, cabinets: {}, records: [], feedback: [] }
}

function seedCabinet(cabinetId, cabinetInput = {}) {
  const lockerCount = Number(cabinetInput.lockerCount) || 12
  const lockers = Array.from({ length: lockerCount }, (_, index) => createLocker({
    id: index + 1,
    cabinetId,
    controllerId: index < 6 ? 'A' : 'B',
    status: 'EMPTY',
    doorStatus: 'CLOSED',
    currentRecordId: null,
    storedAt: null
  }))
  return {
    cabinet: createCabinet({
      id: cabinetId,
      name: cabinetInput.name,
      locationName: cabinetInput.locationName,
      bleIdentifier: cabinetInput.bleIdentifier || cabinetInput.bluetoothDeviceId || `MOCK-${cabinetId}`,
      lockerCount,
      status: cabinetInput.status || 'ACTIVE',
      notes: cabinetInput.notes || '',
      createdAt: cabinetInput.createdAt,
      updatedAt: cabinetInput.updatedAt,
      deletedAt: cabinetInput.deletedAt
    }),
    lockers
  }
}

function installSeed(store, cabinetId, cabinetInput = {}) {
  const cabinetData = seedCabinet(cabinetId, cabinetInput)
  store.cabinets[cabinetId] = cabinetData
  return cabinetData
}

function writeStore(store) { wx.setStorageSync(STORAGE_KEY, store) }

function normalizeStore(store) {
  let changed = false
  if (!Array.isArray(store.records)) { store.records = []; changed = true }
  if (!Array.isArray(store.feedback)) { store.feedback = []; changed = true }
  store.records = store.records.map(record => {
    if (record.depositorUserId || !record.riderId) return record
    changed = true
    return { ...record, depositorUserId: record.riderId }
  })
  const demoRecordIds = new Set(store.records
    .filter(record => /^demo-|^migrated-demo-/.test(record.id || ''))
    .map(record => record.id))
  if (demoRecordIds.size) {
    store.records = store.records.filter(record => !demoRecordIds.has(record.id))
    changed = true
  }
  Object.keys(store.cabinets || {}).forEach(cabinetId => {
    const cabinetData = store.cabinets[cabinetId]
    if (!cabinetData.cabinet.status || !cabinetData.cabinet.lockerCount || cabinetData.cabinet.bleIdentifier === undefined || !cabinetData.cabinet.createdAt) changed = true
    cabinetData.cabinet = createCabinet({
      ...cabinetData.cabinet,
      id: cabinetId,
      lockerCount: cabinetData.cabinet.lockerCount || (cabinetData.lockers || []).length
    })
    ;(cabinetData.lockers || []).forEach(locker => {
      // 清理早期版本自动创建的06号柜演示记录；连接柜体本身绝不产生业务记录。
      if (demoRecordIds.has(locker.currentRecordId) || (locker.status === 'OCCUPIED' && !locker.currentRecordId)) {
        locker.status = 'EMPTY'
        locker.currentRecordId = null
        locker.storedAt = null
        changed = true
      }
    })
  })
  if (changed) writeStore(store)
  return store
}

function readStore() {
  let store = wx.getStorageSync(STORAGE_KEY)
  if (store && store.version === 2 && store.cabinets) return normalizeStore(store)

  store = emptyStore()
  const legacy = wx.getStorageSync(LEGACY_STORAGE_KEY)
  if (legacy && legacy.cabinet && legacy.cabinet.id) {
    const cabinetId = legacy.cabinet.id
    store.cabinets[cabinetId] = { cabinet: legacy.cabinet, lockers: legacy.lockers || [] }
    store.records = (legacy.records || []).map(record => ({ ...record, cabinetId: record.cabinetId || cabinetId }))
    store.feedback = (legacy.feedback || []).map(item => ({ ...item, cabinetId: item.cabinetId || cabinetId }))
  }
  writeStore(store)
  return normalizeStore(store)
}

function initializeCabinet(cabinetId) {
  assertMockBackend('INITIALIZE_CABINET')
  if (!cabinetId) throw new Error('CABINET_ID_REQUIRED')
  const store = readStore()
  if (!store.cabinets[cabinetId]) {
    installSeed(store, cabinetId)
    writeStore(store)
  }
  return store.cabinets[cabinetId]
}

// 当前为 Mock 后台查询；接入真实后端时替换此函数即可，页面无需改动。
function loadCabinet(cabinetId) {
  if (USE_CLOUD) {
    return Promise.all([
      cloudService.callFunction('getCabinet', { cabinetId }),
      cloudService.callFunction('getLockers', { cabinetId })
    ]).then(([cabinetInput, lockerInputs]) => {
      const cabinet = createCabinet(cabinetInput)
      if (cabinet.status === 'DISABLED') throw new Error('CABINET_DISABLED')
      if (cabinet.status === 'MAINTENANCE') throw new Error('CABINET_MAINTENANCE')
      if (cabinet.status === 'PROVISIONING') throw new Error('CABINET_PROVISIONING')
      if (cabinet.status !== 'ACTIVE') throw new Error('CABINET_NOT_ACTIVE')
      cloudCabinetCache[cabinetId] = { cabinet, lockers: lockerInputs.map(item => createLocker(item)) }
      return cabinet
    })
  }
  const store = readStore()
  const cabinetData = store.cabinets[cabinetId]
  if (!cabinetData) return Promise.reject(new Error('CABINET_NOT_FOUND'))
  if (cabinetData.cabinet.status === 'DISABLED') return Promise.reject(new Error('CABINET_DISABLED'))
  if (cabinetData.cabinet.status === 'MAINTENANCE') return Promise.reject(new Error('CABINET_MAINTENANCE'))
  if (cabinetData.cabinet.status === 'PROVISIONING') return Promise.reject(new Error('CABINET_PROVISIONING'))
  if (cabinetData.cabinet.status !== 'ACTIVE') return Promise.reject(new Error('CABINET_NOT_ACTIVE'))
  return Promise.resolve(cabinetData.cabinet)
}

// 维修诊断需要读取处于 MAINTENANCE 的柜体，不能复用面向普通业务的
// loadCabinet（后者会主动拒绝非 ACTIVE 柜体）。这里只绕过业务可用性门禁，
// 不改变柜体状态，也不改变普通页面的加载规则。
function loadCabinetForMaintenance(cabinetId) {
  if (USE_CLOUD) {
    return Promise.all([
      cloudService.callFunction('getCabinet', { cabinetId }),
      cloudService.callFunction('getLockers', { cabinetId })
    ]).then(([cabinetInput, lockerInputs]) => {
      const cabinet = createCabinet(cabinetInput)
      if (cabinet.status === 'DISABLED') throw new Error('CABINET_DISABLED')
      if (cabinet.status === 'PROVISIONING') throw new Error('CABINET_PROVISIONING')
      cloudCabinetCache[cabinetId] = { cabinet, lockers: lockerInputs.map(item => createLocker(item)) }
      return cabinet
    })
  }
  const store = readStore()
  const cabinetData = store.cabinets[cabinetId]
  if (!cabinetData) return Promise.reject(new Error('CABINET_NOT_FOUND'))
  if (cabinetData.cabinet.status === 'DISABLED') return Promise.reject(new Error('CABINET_DISABLED'))
  if (cabinetData.cabinet.status === 'PROVISIONING') return Promise.reject(new Error('CABINET_PROVISIONING'))
  return Promise.resolve(cabinetData.cabinet)
}

function getCabinetData(cabinetId) {
  if (USE_CLOUD) {
    if (!cloudCabinetCache[cabinetId]) throw new Error('CABINET_NOT_LOADED')
    return cloudCabinetCache[cabinetId]
  }
  const store = readStore()
  if (!store.cabinets[cabinetId]) throw new Error('CABINET_NOT_FOUND')
  return store.cabinets[cabinetId]
}

function getCabinet(cabinetId) { return getCabinetData(cabinetId).cabinet }
function reportCabinetTelemetry(cabinetId, lockerStatuses = [], seenAt = new Date().toISOString()) {
  assertMockBackend('RECORD_CABINET_BLE_SEEN')
  const store = readStore()
  const cabinetData = store.cabinets[cabinetId]
  if (!cabinetData) throw new Error('CABINET_NOT_FOUND')
  const statuses = Array.isArray(lockerStatuses) ? lockerStatuses : []
  const lockerMap = new Map(cabinetData.lockers.map(locker => [String(Number(locker.id)).padStart(2, '0'), locker]))
  const seen = new Set()
  statuses.forEach(item => {
    const lockerId = String(Number(item && item.lockerId)).padStart(2, '0')
    if (!item || !['OPEN', 'CLOSED'].includes(item.doorStatus) || !lockerMap.has(lockerId) || seen.has(lockerId)) throw new Error('LOCKER_STATUS_SNAPSHOT_INVALID')
    seen.add(lockerId)
    lockerMap.get(lockerId).doorStatus = item.doorStatus
  })
  if (seen.size !== lockerMap.size) throw new Error('LOCKER_STATUS_SNAPSHOT_INCOMPLETE')
  cabinetData.cabinet = createCabinet({ ...cabinetData.cabinet, lastBleSeenAt: seenAt })
  writeStore(store)
  return cabinetData.cabinet
}
function recordCabinetBleSeen(cabinetId, lockerStatuses = [], seenAt = new Date().toISOString()) {
  return reportCabinetTelemetry(cabinetId, lockerStatuses, seenAt)
}
function listCabinets(options = {}) {
  assertMockBackend('LIST_CABINETS')
  const store = readStore()
  return Object.keys(store.cabinets)
    .map(cabinetId => store.cabinets[cabinetId].cabinet)
    .filter(cabinet => options.includeDisabled !== false || cabinet.status !== 'DISABLED')
}

function validateCabinetInput(data, store, existingId = '') {
  const id = String(data.id || existingId || '').trim().toUpperCase()
  const name = String(data.name || '').trim()
  const locationName = String(data.locationName || '').trim()
  const bleIdentifier = String(data.bleIdentifier || '').trim()
  const lockerCount = Number(data.lockerCount)
  if (!/^[A-Z0-9][A-Z0-9._:-]{1,63}$/.test(id)) throw new Error('CABINET_ID_INVALID')
  if (!name) throw new Error('CABINET_NAME_REQUIRED')
  if (!locationName) throw new Error('CABINET_LOCATION_REQUIRED')
  if (!bleIdentifier) throw new Error('BLE_IDENTIFIER_REQUIRED')
  if (!Number.isInteger(lockerCount) || lockerCount < 1 || lockerCount > 200) throw new Error('LOCKER_COUNT_INVALID')
  const duplicateBle = Object.keys(store.cabinets).some(cabinetId =>
    cabinetId !== existingId && store.cabinets[cabinetId].cabinet.bleIdentifier === bleIdentifier
  )
  if (duplicateBle) throw new Error('BLE_IDENTIFIER_EXISTS')
  return { id, name, locationName, bleIdentifier, lockerCount, notes: String(data.notes || '').trim() }
}

function createCabinetRecord(data) {
  assertMockBackend('CREATE_CABINET')
  const store = readStore()
  const input = validateCabinetInput(data, store)
  if (store.cabinets[input.id]) throw new Error('CABINET_ID_EXISTS')
  const now = new Date().toISOString()
  const cabinetData = installSeed(store, input.id, { ...input, status: 'ACTIVE', createdAt: now, updatedAt: now })
  writeStore(store)
  return cabinetData.cabinet
}

function updateCabinetRecord(cabinetId, patch) {
  assertMockBackend('UPDATE_CABINET')
  const store = readStore()
  const cabinetData = store.cabinets[cabinetId]
  if (!cabinetData) throw new Error('CABINET_NOT_FOUND')
  const current = cabinetData.cabinet
  const input = validateCabinetInput({ ...current, ...patch, id: cabinetId }, store, cabinetId)
  if (input.lockerCount !== current.lockerCount) throw new Error('LOCKER_COUNT_IMMUTABLE')
  cabinetData.cabinet = createCabinet({
    ...current,
    ...input,
    id: cabinetId,
    status: current.status,
    deletedAt: current.deletedAt,
    updatedAt: new Date().toISOString()
  })
  writeStore(store)
  return cabinetData.cabinet
}

function setCabinetMaintenance(cabinetId) {
  assertMockBackend('SET_CABINET_MAINTENANCE')
  const store = readStore()
  const cabinetData = store.cabinets[cabinetId]
  if (!cabinetData) throw new Error('CABINET_NOT_FOUND')
  if (cabinetData.cabinet.status === 'DISABLED') throw new Error('CABINET_DISABLED')
  cabinetData.cabinet = createCabinet({ ...cabinetData.cabinet, status: 'MAINTENANCE', maintenanceSource: cabinetData.cabinet.faultActive ? 'HARDWARE_FAULT' : 'MANUAL', healthCheckPassedAt: null, updatedAt: new Date().toISOString() })
  writeStore(store)
  return cabinetData.cabinet
}

function restoreCabinet(cabinetId) {
  assertMockBackend('RESTORE_CABINET')
  const store = readStore()
  const cabinetData = store.cabinets[cabinetId]
  if (!cabinetData) throw new Error('CABINET_NOT_FOUND')
  if (cabinetData.cabinet.status === 'DISABLED') throw new Error('CABINET_DISABLED')
  if (hasActiveHardwareFault(cabinetData.cabinet)) throw new Error('CABINET_HARDWARE_FAULT_ACTIVE')
  if (!cabinetData.cabinet.healthCheckPassedAt) throw new Error('MAINTENANCE_SELF_CHECK_REQUIRED')
  cabinetData.cabinet = createCabinet({ ...cabinetData.cabinet, status: 'ACTIVE', maintenanceSource: null, faultActive: false, faultCode: null, faultReportedAt: null, updatedAt: new Date().toISOString() })
  writeStore(store)
  return cabinetData.cabinet
}

function reportCabinetFault(cabinetId, faultCode) {
  assertMockBackend('REPORT_CABINET_FAULT')
  const store = readStore()
  const cabinetData = store.cabinets[cabinetId]
  if (!cabinetData) throw new Error('CABINET_NOT_FOUND')
  if (cabinetData.cabinet.status === 'DISABLED') throw new Error('CABINET_DISABLED')
  cabinetData.cabinet = createCabinet({
    ...cabinetData.cabinet,
    status: 'MAINTENANCE',
    maintenanceSource: 'HARDWARE_FAULT',
    faultActive: true,
    faultCode: faultCode || 'CONTROLLER_FAULT',
    faultReportedAt: new Date().toISOString(),
    healthCheckPassedAt: null,
    updatedAt: new Date().toISOString()
  })
  writeStore(store)
  return cabinetData.cabinet
}

function reportCabinetHealthCheckPassed(cabinetId) {
  assertMockBackend('REPORT_CABINET_HEALTH_CHECK')
  const store = readStore()
  const cabinetData = store.cabinets[cabinetId]
  if (!cabinetData) throw new Error('CABINET_NOT_FOUND')
  cabinetData.cabinet = createCabinet({ ...cabinetData.cabinet, faultActive: false, healthCheckPassedAt: new Date().toISOString(), updatedAt: new Date().toISOString() })
  writeStore(store)
  return cabinetData.cabinet
}

function getWaitingPickupCount(cabinetId) {
  return getRecords(cabinetId).filter(item => item.status === 'WAITING_PICKUP').length
}

function disableCabinet(cabinetId) {
  return setCabinetMaintenance(cabinetId)
}
function normalizeLegacyDisabledCabinet(cabinetId) {
  assertMockBackend('NORMALIZE_DISABLED_TO_MAINTENANCE')
  const store = readStore()
  const cabinetData = store.cabinets[cabinetId]
  if (!cabinetData) throw new Error('CABINET_NOT_FOUND')
  if (cabinetData.cabinet.status !== 'DISABLED') return cabinetData.cabinet
  const faultActive = cabinetData.cabinet.faultActive === true || cabinetData.cabinet.faultActive === 1 || cabinetData.cabinet.faultActive === 'true'
  cabinetData.cabinet = createCabinet({
    ...cabinetData.cabinet,
    status: 'MAINTENANCE',
    deletedAt: null,
    maintenanceSource: faultActive ? 'HARDWARE_FAULT' : 'MANUAL',
    updatedAt: new Date().toISOString()
  })
  writeStore(store)
  return cabinetData.cabinet
}
function reenableCabinet(cabinetId) {
  return normalizeLegacyDisabledCabinet(cabinetId)
}
function getLockers(cabinetId) { return getCabinetData(cabinetId).lockers || [] }
function getLocker(cabinetId, lockerId) {
  return getLockers(cabinetId).find(item => item.id === Number(lockerId))
}
function applyCloudLockerSnapshot(cabinetId, lockerInput) {
  if (!USE_CLOUD) throw new Error('CLOUD_BACKEND_DISABLED')
  const data = getCabinetData(cabinetId)
  const locker = createLocker(lockerInput)
  const index = data.lockers.findIndex(item => Number(item.id) === Number(locker.id))
  if (index < 0) throw new Error('LOCKER_NOT_FOUND')
  data.lockers[index] = locker
  return locker
}

// cabinetId 省略时返回跨柜体历史；传入时只查询指定柜体。
function getRecords(cabinetId) {
  assertMockBackend('GET_DEPOSIT_RECORDS')
  const records = readStore().records || []
  return cabinetId ? records.filter(item => item.cabinetId === cabinetId) : records
}

function getSuccessfulPickupRecords(cabinetId) {
  return getRecords(cabinetId).filter(item => item.status === 'PICKED_UP' && Boolean(item.pickedAt))
}

function getRecordsForUser(userId) {
  if (!userId) return []
  return getRecords().filter(item => (item.depositorUserId || item.riderId) === userId || item.pickedByUserId === userId)
}

function getActiveRecord(cabinetId, lockerId) {
  const locker = getLocker(cabinetId, lockerId)
  if (!locker || !locker.currentRecordId) return null
  return getRecords(cabinetId).find(item =>
    item.id === locker.currentRecordId &&
    item.lockerId === Number(lockerId) &&
    item.status === 'WAITING_PICKUP'
  ) || null
}

function verifyPickupCode(cabinetId, lockerId, pickupCode) {
  const record = getActiveRecord(cabinetId, lockerId)
  if (!record || record.pickupCode !== String(pickupCode)) return null
  return record
}

function getFeedback(cabinetId) {
  assertMockBackend('GET_FEEDBACK')
  const feedback = readStore().feedback || []
  return cabinetId ? feedback.filter(item => item.cabinetId === cabinetId) : feedback
}

function updateLocker(cabinetId, lockerId, patch) {
  assertMockBackend('UPDATE_LOCKER')
  const store = readStore()
  if (!store.cabinets[cabinetId]) throw new Error('CABINET_NOT_FOUND')
  const lockers = store.cabinets[cabinetId].lockers
  const index = lockers.findIndex(item => item.id === Number(lockerId))
  if (index < 0) throw new Error('LOCKER_NOT_FOUND')
  lockers[index] = { ...lockers[index], ...patch, cabinetId }
  writeStore(store)
  return lockers[index]
}

function setLockerMaintenance(cabinetId, lockerId) {
  const locker = getLocker(cabinetId, lockerId)
  if (!locker) throw new Error('LOCKER_NOT_FOUND')
  if (locker.enabled === false) throw new Error('LOCKER_DISABLED')
  if (locker.status === 'OCCUPIED') throw new Error('LOCKER_OCCUPIED')
  return updateLocker(cabinetId, lockerId, {
    status: 'MAINTENANCE',
    maintenanceSource: 'MANUAL',
    previousStatus: locker.status === 'MAINTENANCE' ? (locker.previousStatus || 'EMPTY') : locker.status,
    healthCheckPassedAt: null
  })
}

function reportLockerFault(cabinetId, lockerId, faultCode) {
  const locker = getLocker(cabinetId, lockerId)
  if (!locker) throw new Error('LOCKER_NOT_FOUND')
  if (locker.enabled === false) throw new Error('LOCKER_DISABLED')
  const previousStatus = locker.status === 'MAINTENANCE' ? (locker.previousStatus || 'EMPTY') : locker.status
  return updateLocker(cabinetId, lockerId, {
    status: 'MAINTENANCE',
    maintenanceSource: 'HARDWARE_FAULT',
    previousStatus,
    faultActive: true,
    faultCode: faultCode || 'UNKNOWN_HARDWARE_FAULT',
    faultReportedAt: new Date().toISOString(),
    healthCheckPassedAt: null
  })
}

function reportLockerHealthCheckPassed(cabinetId, lockerId) {
  const locker = getLocker(cabinetId, lockerId)
  if (!locker) throw new Error('LOCKER_NOT_FOUND')
  return updateLocker(cabinetId, lockerId, {
    faultActive: false,
    healthCheckPassedAt: new Date().toISOString()
  })
}

function restoreLocker(cabinetId, lockerId) {
  const locker = getLocker(cabinetId, lockerId)
  if (!locker) throw new Error('LOCKER_NOT_FOUND')
  if (locker.enabled === false) throw new Error('LOCKER_DISABLED')
  if (locker.status !== 'MAINTENANCE') throw new Error('LOCKER_NOT_IN_MAINTENANCE')
  if (hasActiveHardwareFault(locker)) throw new Error('HARDWARE_FAULT_ACTIVE')
  if (!locker.healthCheckPassedAt) throw new Error('MAINTENANCE_SELF_CHECK_REQUIRED')
  // 维修字段可能来自旧版本；只有仍然有效的 WAITING_PICKUP 记录才能证明
  // 柜格维修前是占用状态，避免恢复流程误删未取餐业务。
  const activeRecord = getActiveRecord(cabinetId, lockerId)
  const restoredStatus = activeRecord ? 'OCCUPIED' : 'EMPTY'
  return updateLocker(cabinetId, lockerId, {
    status: restoredStatus,
    currentRecordId: activeRecord ? activeRecord.id : null,
    storedAt: activeRecord ? activeRecord.storedAt || locker.storedAt || null : null,
    consecutiveUnlockFailures: 0,
    maintenanceSource: null,
    previousStatus: null,
    faultActive: false,
    faultCode: null,
    faultReportedAt: null
  })
}

function disableLocker(cabinetId, lockerId) {
  const locker = getLocker(cabinetId, lockerId)
  if (!locker) throw new Error('LOCKER_NOT_FOUND')
  if (locker.status === 'OCCUPIED' || locker.currentRecordId) throw new Error('LOCKER_HAS_WAITING_PICKUP')
  if (locker.enabled === false || locker.status === 'DISABLED') return normalizeLegacyDisabledLocker(cabinetId, lockerId)
  return setLockerMaintenance(cabinetId, lockerId)
}

function normalizeLegacyDisabledLocker(cabinetId, lockerId) {
  const locker = getLocker(cabinetId, lockerId)
  if (!locker) throw new Error('LOCKER_NOT_FOUND')
  if (locker.enabled !== false && locker.status !== 'DISABLED') return locker
  return updateLocker(cabinetId, lockerId, {
    enabled: true,
    status: 'MAINTENANCE',
    maintenanceSource: locker.faultActive ? 'HARDWARE_FAULT' : 'MANUAL',
    previousStatus: locker.currentRecordId ? 'OCCUPIED' : 'EMPTY',
    disabledAt: null
  })
}

function reenableLocker(cabinetId, lockerId) {
  const locker = getLocker(cabinetId, lockerId)
  if (!locker) throw new Error('LOCKER_NOT_FOUND')
  if (locker.enabled === false || locker.status === 'DISABLED') return normalizeLegacyDisabledLocker(cabinetId, lockerId)
  return locker
}

function correctLockerBusinessStatus(cabinetId, lockerId, targetStatus) {
  const locker = getLocker(cabinetId, lockerId)
  if (!locker) throw new Error('LOCKER_NOT_FOUND')
  if (locker.enabled === false) throw new Error('LOCKER_DISABLED')
  if (locker.status === 'MAINTENANCE') throw new Error('LOCKER_IN_MAINTENANCE')
  const normalizedStatus = String(targetStatus || '').toUpperCase()
  if (!['EMPTY', 'OCCUPIED'].includes(normalizedStatus)) throw new Error('LOCKER_STATUS_INVALID')
  const waitingRecord = getRecords(cabinetId).find(record => Number(record.lockerId) === Number(lockerId) && record.status === 'WAITING_PICKUP')
  if (normalizedStatus === 'EMPTY' && waitingRecord) throw new Error('LOCKER_HAS_WAITING_PICKUP')
  if (normalizedStatus === 'OCCUPIED' && !waitingRecord) throw new Error('LOCKER_WAITING_RECORD_REQUIRED')
  return updateLocker(cabinetId, lockerId, {
    status: normalizedStatus,
    currentRecordId: waitingRecord ? waitingRecord.id : null,
    storedAt: waitingRecord ? waitingRecord.storedAt : null,
    maintenanceSource: null,
    previousStatus: null
  })
}

function resetCabinet(cabinetId) {
  assertMockBackend('RESET_CABINET')
  const store = readStore()
  if (!store.cabinets[cabinetId]) throw new Error('CABINET_NOT_FOUND')
  const cabinet = store.cabinets[cabinetId].cabinet
  store.records = store.records.filter(item => item.cabinetId !== cabinetId)
  store.feedback = store.feedback.filter(item => item.cabinetId !== cabinetId)
  installSeed(store, cabinetId, cabinet)
  writeStore(store)
  return store.cabinets[cabinetId]
}

function confirmDeposit({ cabinetId, lockerId, depositorUserId, riderId, pickupCode, recordId }) {
  if (!/^\d{4}$/.test(String(pickupCode || ''))) throw new Error('PICKUP_CODE_INVALID')
  assertMockBackend('CREATE_DEPOSIT')
  if (!cabinetId) throw new Error('CABINET_ID_REQUIRED')
  const store = readStore()
  const cabinetData = store.cabinets[cabinetId]
  if (!cabinetData) throw new Error('CABINET_NOT_FOUND')
  if (cabinetData.cabinet.status !== 'ACTIVE') throw new Error('CABINET_NOT_ACTIVE')
  const locker = cabinetData.lockers.find(item => item.id === Number(lockerId))
  if (!locker) throw new Error('LOCKER_NOT_FOUND')
  if (locker.enabled === false) throw new Error('LOCKER_DISABLED')
  const currentUserId = depositorUserId || riderId
  if (recordId) {
    if (locker.status === 'MAINTENANCE' || locker.faultActive) throw new Error('LOCKER_IN_MAINTENANCE')
    if (locker.status !== 'OCCUPIED' || locker.currentRecordId !== recordId) throw new Error('REDEPOSIT_RECORD_MISMATCH')
    if (locker.doorStatus !== 'CLOSED') throw new Error('DOOR_NOT_CLOSED')
    const record = store.records.find(item => item.id === recordId && item.cabinetId === cabinetId && Number(item.lockerId) === Number(lockerId))
    if (!record || record.status !== 'WAITING_PICKUP') throw new Error('REDEPOSIT_RECORD_MISMATCH')
    if ((record.depositorUserId || record.riderId) !== currentUserId) throw new Error('REDEPOSIT_NOT_ALLOWED')
    const storedAt = new Date().toISOString()
    record.initialStoredAt = record.initialStoredAt || record.storedAt
    record.storedAt = storedAt
    record.reconfirmedAt = storedAt
    record.pickupCode = String(pickupCode)
    locker.storedAt = storedAt
    writeStore(store)
    return createDepositRecord(record)
  }
  if (locker.status !== 'EMPTY') throw new Error('LOCKER_NOT_EMPTY')
  if (locker.doorStatus !== 'CLOSED') throw new Error('DOOR_NOT_CLOSED')

  const storedAt = new Date().toISOString()
  const record = createDepositRecord({
    id: `deposit-${cabinetId}-${Date.now()}-${locker.id}`,
    lockerId: locker.id,
    cabinetId,
    depositorUserId: currentUserId,
    pickupCode,
    storedAt,
    status: 'WAITING_PICKUP'
  })
  locker.status = 'OCCUPIED'
  locker.currentRecordId = record.id
  locker.storedAt = storedAt
  store.records.push(record)
  writeStore(store)
  return record
}

function clearOccupiedLockerAsEmpty({ cabinetId, lockerId, managerUserId }) {
  assertMockBackend('CLEAR_OCCUPIED_LOCKER_AS_EMPTY')
  const store = readStore()
  const cabinetData = store.cabinets[cabinetId]
  if (!cabinetData || cabinetData.cabinet.status !== 'ACTIVE') throw new Error('CABINET_NOT_ACTIVE')
  const locker = cabinetData.lockers.find(item => Number(item.id) === Number(lockerId))
  if (!locker) throw new Error('LOCKER_NOT_FOUND')
  if (locker.enabled === false) throw new Error('LOCKER_DISABLED')
  if (locker.status !== 'OCCUPIED' || !locker.currentRecordId) throw new Error('LOCKER_NOT_OCCUPIED')
  if (locker.doorStatus !== 'OPEN') throw new Error('DOOR_NOT_OPEN')
  const waitingRecords = store.records.filter(item => item.cabinetId === cabinetId && Number(item.lockerId) === Number(lockerId) && item.status === 'WAITING_PICKUP')
  if (waitingRecords.length > 1) throw new Error('LOCKER_MULTIPLE_WAITING_RECORDS')
  const record = waitingRecords[0]
  if (!record || record.id !== locker.currentRecordId) throw new Error('LOCKER_WAITING_RECORD_MISMATCH')
  const now = new Date().toISOString()
  record.status = 'ADMIN_CLEARED'
  record.adminClearedAt = now
  record.adminClearedBy = managerUserId
  record.closureReason = 'PHYSICALLY_EMPTY'
  locker.status = 'EMPTY'
  locker.currentRecordId = null
  locker.storedAt = null
  writeStore(store)
  return { locker: { ...locker }, record: createDepositRecord(record) }
}

function completePickup({ cabinetId, lockerId, recordId, pickedByUserId, completedByStaffId, pickupMethod, allowMaintenance = false }) {
  assertMockBackend('COMPLETE_PICKUP')
  if (!cabinetId) throw new Error('CABINET_ID_REQUIRED')
  const store = readStore()
  const cabinetData = store.cabinets[cabinetId]
  if (!cabinetData) throw new Error('CABINET_NOT_FOUND')
  const cabinetCanCompletePickup = cabinetData.cabinet.status === 'ACTIVE' || (allowMaintenance && cabinetData.cabinet.status === 'MAINTENANCE')
  if (!cabinetCanCompletePickup) throw new Error('CABINET_NOT_ACTIVE')
  const locker = cabinetData.lockers.find(item => item.id === Number(lockerId))
  if (!locker) throw new Error('LOCKER_NOT_FOUND')
  const lockerCanCompletePickup = locker.status === 'OCCUPIED' || (allowMaintenance && locker.status === 'MAINTENANCE')
  if (!lockerCanCompletePickup) throw new Error('LOCKER_NOT_OCCUPIED')
  if (locker.doorStatus !== 'OPEN') throw new Error('DOOR_NOT_OPEN')
  if (locker.currentRecordId !== recordId) throw new Error('RECORD_MISMATCH')

  const record = store.records.find(item =>
    item.id === recordId &&
    item.cabinetId === cabinetId &&
    item.lockerId === Number(lockerId)
  )
  if (!record || record.status !== 'WAITING_PICKUP' || record.pickedAt) throw new Error('RECORD_NOT_ACTIVE')

  const pickedAt = new Date().toISOString()
  record.status = 'PICKED_UP'
  record.pickedAt = pickedAt
  record.pickedByUserId = pickedByUserId || ''
  record.completedByStaffId = completedByStaffId || ''
  record.pickupMethod = pickupMethod || (completedByStaffId ? 'STAFF_ASSISTED' : 'USER_SELF_SERVICE')
  locker.status = 'EMPTY'
  locker.currentRecordId = null
  locker.storedAt = null
  // 用户取餐成功不要求关门，doorStatus 保持实际门磁的 OPEN。
  writeStore(store)
  return record
}

function createFeedbackRecord(data) {
  assertMockBackend('CREATE_FEEDBACK')
  if (!data.cabinetId) throw new Error('CABINET_ID_REQUIRED')
  const store = readStore()
  const feedback = createFeedback({ ...data, id: data.id || `feedback-${data.cabinetId}-${Date.now()}` })
  store.feedback.push(feedback)
  writeStore(store)
  return feedback
}

function updateFeedbackStatus(feedbackId, status) {
  assertMockBackend('UPDATE_FEEDBACK')
  const allowed = ['PENDING', 'PROCESSING', 'RESOLVED']
  if (!allowed.includes(status)) throw new Error('FEEDBACK_STATUS_INVALID')
  const store = readStore()
  const index = store.feedback.findIndex(item => item.id === feedbackId)
  if (index < 0) throw new Error('FEEDBACK_NOT_FOUND')
  store.feedback[index] = {
    ...store.feedback[index],
    status,
    updatedAt: new Date().toISOString()
  }
  writeStore(store)
  return store.feedback[index]
}

module.exports = {
  initializeCabinet,
  loadCabinet,
  loadCabinetForMaintenance,
  getCabinet,
  reportCabinetTelemetry,
  recordCabinetBleSeen,
  listCabinets,
  createCabinetRecord,
  updateCabinetRecord,
  setCabinetMaintenance,
  restoreCabinet,
  reportCabinetFault,
  reportCabinetHealthCheckPassed,
  disableCabinet,
  normalizeLegacyDisabledCabinet,
  reenableCabinet,
  getWaitingPickupCount,
  getLockers,
  getLocker,
  applyCloudLockerSnapshot,
  getRecords,
  getSuccessfulPickupRecords,
  getRecordsForUser,
  getActiveRecord,
  verifyPickupCode,
  getFeedback,
  updateLocker,
  setLockerMaintenance,
  reportLockerFault,
  reportLockerHealthCheckPassed,
  restoreLocker,
  disableLocker,
  normalizeLegacyDisabledLocker,
  reenableLocker,
  correctLockerBusinessStatus,
  confirmDeposit,
  clearOccupiedLockerAsEmpty,
  completePickup,
  createFeedbackRecord,
  updateFeedbackStatus,
  resetCabinet
}

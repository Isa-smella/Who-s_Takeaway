const lockerRepository = require('../repositories/lockerRepository')
const eventBus = require('./eventBus')
const bleLockerService = require('./bleLockerService')
const cabinetTelemetryService = require('./cabinetTelemetryService')
const bluetoothService = require('./bluetoothService')
const { USE_CLOUD, BLE_TRANSPORT } = require('../config/env')
const runtimeDoorStates = {}
const MOCK_DOOR_STORAGE_KEY = 'LAKES_TAKEAWAY_MOCK_DOOR_STATES_V1'
const DEFAULT_DOOR_STATUS_POLL_INTERVAL_MS = 900
const DEFAULT_DOOR_STATUS_POLL_TIMEOUT_MS = 15000
const doorStatusPollers = {}

function key(cabinetId, lockerId) { return `${cabinetId}:${Number(lockerId)}` }
function readPersistedDoorStates() {
  try { return wx.getStorageSync(MOCK_DOOR_STORAGE_KEY) || {} } catch (error) { return {} }
}
function writePersistedDoorStates(states) {
  try { wx.setStorageSync(MOCK_DOOR_STORAGE_KEY, states) } catch (error) {}
}
function resolveDoorStatus(cabinetId, lockerId) {
  const stateKey = key(cabinetId, lockerId)
  const runtimeStatus = runtimeDoorStates[stateKey] || ''
  const hardwareStatus = BLE_TRANSPORT === 'HM10_TEXT' && bleLockerService.getCachedLockerStatus(cabinetId, lockerId)
  const hardwareDoorStatus = hardwareStatus && hardwareStatus.doorStatus ? hardwareStatus.doorStatus : ''
  const persistedStatus = readPersistedDoorStates()[stateKey] || ''

  // 当前运行时状态来自本次进程收到的真实反馈（或 MOCK 模式的显式模拟），
  // BLE cache 是同一运行时的实体反馈缓存；本地存储和仓库值都只代表最近已知状态。
  if (runtimeStatus) return { status: runtimeStatus, source: 'RUNTIME' }
  if (hardwareDoorStatus) return { status: hardwareDoorStatus, source: 'BLE_CACHE' }
  if (persistedStatus) return { status: persistedStatus, source: 'LAST_KNOWN_LOCAL' }

  const locker = lockerRepository.getLocker(cabinetId, lockerId)
  const repositoryStatus = locker && locker.doorStatus ? locker.doorStatus : ''
  if (repositoryStatus) return { status: repositoryStatus, source: USE_CLOUD ? 'LAST_KNOWN_CLOUD' : 'LAST_KNOWN_REPOSITORY' }
  return { status: 'UNKNOWN', source: 'UNKNOWN' }
}
function getDoorStatus(cabinetId, lockerId) {
  return resolveDoorStatus(cabinetId, lockerId).status
}
function getDoorStatusDetails(cabinetId, lockerId) {
  const stateKey = key(cabinetId, lockerId)
  let locker = null
  try { locker = lockerRepository.getLocker(cabinetId, lockerId) } catch (error) {}
  const runtimeStatus = runtimeDoorStates[stateKey] || ''
  const hardwareStatus = BLE_TRANSPORT === 'HM10_TEXT' && bleLockerService.getCachedLockerStatus(cabinetId, lockerId)
  const hardwareDoorStatus = hardwareStatus && hardwareStatus.doorStatus ? hardwareStatus.doorStatus : ''
  const persistedStatus = readPersistedDoorStates()[stateKey] || ''
  const repositoryStatus = locker ? locker.doorStatus : 'UNKNOWN'
  const resolved = resolveDoorStatus(cabinetId, lockerId)
  return { stateKey, runtimeStatus, hardwareStatus: hardwareDoorStatus, persistedStatus, repositoryStatus, resolvedStatus: resolved.status, source: resolved.source }
}

function subscribeDoorStatus(cabinetId, lockerId, callback) { return eventBus.on(`door:${key(cabinetId, lockerId)}`, callback) }
function mockSetDoorStatus(cabinetId, lockerId, doorStatus) {
  if (BLE_TRANSPORT !== 'MOCK') throw new Error('MOCK_DOOR_STATUS_REQUIRES_MOCK_TRANSPORT')
  const normalized = doorStatus === 'OPEN' ? 'OPEN' : 'CLOSED'
  let locker
  if (USE_CLOUD) {
    const stateKey = key(cabinetId, lockerId)
    runtimeDoorStates[stateKey] = normalized
    const persisted = readPersistedDoorStates()
    persisted[stateKey] = normalized
    writePersistedDoorStates(persisted)
    locker = { ...lockerRepository.getLocker(cabinetId, lockerId), doorStatus: normalized }
  } else locker = lockerRepository.updateLocker(cabinetId, lockerId, { doorStatus: normalized })
  eventBus.emit(`door:${key(cabinetId, lockerId)}`, normalized)
  eventBus.emit(`lockers:changed:${cabinetId}`, locker)
  return locker
}
function subscribeAll(cabinetId, callback) { return eventBus.on(`lockers:changed:${cabinetId}`, callback) }

function applyHardwareStatus(payload) {
  if (!payload || !payload.cabinetId || !payload.lockerId || !['OPEN', 'CLOSED'].includes(payload.doorStatus)) return
  const stateKey = key(payload.cabinetId, payload.lockerId)
  runtimeDoorStates[stateKey] = payload.doorStatus
  const persisted = readPersistedDoorStates()
  persisted[stateKey] = payload.doorStatus
  writePersistedDoorStates(persisted)
  let locker = null
  try { locker = lockerRepository.getLocker(payload.cabinetId, payload.lockerId) } catch (error) {}
  eventBus.emit(`door:${key(payload.cabinetId, payload.lockerId)}`, payload.doorStatus)
  eventBus.emit(`lockers:changed:${payload.cabinetId}`, locker ? { ...locker, doorStatus: payload.doorStatus } : { cabinetId: payload.cabinetId, id: Number(payload.lockerId), doorStatus: payload.doorStatus })
}

function refreshDoorStatus(cabinetId, lockerId) {
  if (BLE_TRANSPORT !== 'HM10_TEXT') return Promise.resolve(getDoorStatus(cabinetId, lockerId))
  return bleLockerService.getLockerStatus(lockerId, cabinetId).then(result => {
    applyHardwareStatus({ cabinetId, lockerId: result.lockerId, doorStatus: result.doorStatus })
    return result.doorStatus
  })
}

function stopDoorStatusPollingByKey(stateKey) {
  const poller = doorStatusPollers[stateKey]
  if (!poller) return
  poller.cancelled = true
  if (poller.timer) clearTimeout(poller.timer)
  if (poller.handle) poller.handle.active = false
  delete doorStatusPollers[stateKey]
}

function stopDoorStatusPolling(cabinetId, lockerId) {
  stopDoorStatusPollingByKey(key(cabinetId, lockerId))
}

function startDoorStatusPolling(cabinetId, lockerId, options = {}) {
  if (BLE_TRANSPORT !== 'HM10_TEXT') {
    const noOp = () => {}
    noOp.active = false
    return noOp
  }

  const stateKey = key(cabinetId, lockerId)
  const targetStatus = ['OPEN', 'CLOSED'].includes(options.targetStatus) ? options.targetStatus : ''
  const intervalMs = Math.max(300, Number(options.intervalMs) || DEFAULT_DOOR_STATUS_POLL_INTERVAL_MS)
  const timeoutMs = Math.max(intervalMs, Number(options.timeoutMs) || DEFAULT_DOOR_STATUS_POLL_TIMEOUT_MS)
  const existing = doorStatusPollers[stateKey]
  if (existing && !existing.cancelled && existing.targetStatus === targetStatus) return existing.handle
  stopDoorStatusPollingByKey(stateKey)

  const poller = {
    cabinetId,
    lockerId,
    targetStatus,
    intervalMs,
    timeoutMs,
    startedAt: Date.now(),
    timer: null,
    inFlight: false,
    cancelled: false,
    handle: null
  }
  const handle = () => stopDoorStatusPollingByKey(stateKey)
  handle.active = true
  poller.handle = handle
  doorStatusPollers[stateKey] = poller

  const schedule = () => {
    if (poller.cancelled || doorStatusPollers[stateKey] !== poller) return
    const remaining = poller.timeoutMs - (Date.now() - poller.startedAt)
    if (remaining <= 0) {
      stopDoorStatusPollingByKey(stateKey)
      return
    }
    poller.timer = setTimeout(run, Math.min(poller.intervalMs, remaining))
  }

  const run = () => {
    if (poller.cancelled || doorStatusPollers[stateKey] !== poller || poller.inFlight) return
    if (Date.now() - poller.startedAt >= poller.timeoutMs) {
      stopDoorStatusPollingByKey(stateKey)
      return
    }
    poller.timer = null
    poller.inFlight = true
    Promise.resolve()
      .then(() => refreshDoorStatus(poller.cabinetId, poller.lockerId))
      .then(status => {
        poller.inFlight = false
        if (poller.cancelled || doorStatusPollers[stateKey] !== poller) return
        if (poller.targetStatus && status === poller.targetStatus) {
          stopDoorStatusPollingByKey(stateKey)
          return
        }
        schedule()
      })
      .catch(() => {
        poller.inFlight = false
        stopDoorStatusPollingByKey(stateKey)
      })
  }

  run()
  return handle
}

function refreshDoorStatuses(cabinetId, lockerIds = []) {
  let ids = lockerIds
  if (!Array.isArray(ids) || !ids.length) {
    try { ids = lockerRepository.getLockers(cabinetId).map(item => item.id) } catch (error) { ids = [] }
  }
  ids = Array.from(new Set(ids.map(item => Number(item)).filter(item => Number.isInteger(item) && item > 0)))
  return ids.reduce((chain, lockerId) => chain.then(results => refreshDoorStatus(cabinetId, lockerId)
    .then(doorStatus => results.concat({ lockerId, doorStatus, ok: true }))
    .catch(error => results.concat({ lockerId, ok: false, error }))), Promise.resolve([]))
}

// 维修自检需要在维修人员手动扣门期间等待真实反馈。与页面长期轮询不同，
// 这里是一次有明确超时的、可等待的诊断操作；每次查询失败都会终止自检，
// 不会把未知状态伪造成 CLOSED。
function waitForDoorStatus(cabinetId, lockerId, targetStatus, options = {}) {
  if (BLE_TRANSPORT !== 'HM10_TEXT') return Promise.reject(new Error('MAINTENANCE_DIAGNOSTIC_REQUIRES_BLE'))
  const expected = String(targetStatus || '').toUpperCase()
  if (!['OPEN', 'CLOSED'].includes(expected)) return Promise.reject(new Error('DOOR_STATUS_TARGET_INVALID'))
  const intervalMs = Math.max(300, Number(options.intervalMs) || DEFAULT_DOOR_STATUS_POLL_INTERVAL_MS)
  const timeoutMs = Math.max(intervalMs, Number(options.timeoutMs) || 30000)
  stopDoorStatusPolling(cabinetId, lockerId)
  const startedAt = Date.now()
  return new Promise((resolve, reject) => {
    let timer = null
    let settled = false
    const finish = (error, status) => {
      if (settled) return
      settled = true
      if (timer) clearTimeout(timer)
      if (error) {
        if (status) error.lastDoorStatus = status
        reject(error)
      } else resolve(status)
    }
    const run = () => {
      if (settled) return
      if (Date.now() - startedAt >= timeoutMs) {
        let lastStatus = ''
        try { lastStatus = getDoorStatus(cabinetId, lockerId) } catch (error) {}
        finish(new Error('MAINTENANCE_DOOR_STATUS_TIMEOUT'), lastStatus)
        return
      }
      refreshDoorStatus(cabinetId, lockerId)
        .then(status => {
          if (status === expected) {
            finish(null, status)
            return
          }
          const remaining = timeoutMs - (Date.now() - startedAt)
          if (remaining <= 0) finish(new Error('MAINTENANCE_DOOR_STATUS_TIMEOUT'), status)
          else timer = setTimeout(run, Math.min(intervalMs, remaining))
        })
        .catch(error => finish(error))
    }
    run()
  })
}

bleLockerService.subscribeLockerStatus(applyHardwareStatus)
bluetoothService.subscribeConnectionStatus(state => {
  if (state && state.status === 'CONNECTED' && state.identified && state.cabinetId) {
    cabinetTelemetryService.start(state.cabinetId)
    return
  }
  cabinetTelemetryService.stop()
  Object.keys(doorStatusPollers).forEach(stopDoorStatusPollingByKey)
})
function clearMockDoorStatesForCabinet(cabinetId) {
  Object.keys(doorStatusPollers)
    .filter(item => item.startsWith(`${cabinetId}:`))
    .forEach(stopDoorStatusPollingByKey)
  Object.keys(runtimeDoorStates).filter(item => item.startsWith(`${cabinetId}:`)).forEach(item => delete runtimeDoorStates[item])
  const persisted = readPersistedDoorStates()
  Object.keys(persisted).filter(item => item.startsWith(`${cabinetId}:`)).forEach(item => delete persisted[item])
  writePersistedDoorStates(persisted)
}
module.exports = {
  getDoorStatus,
  getDoorStatusDetails,
  subscribeDoorStatus,
  refreshDoorStatus,
  refreshDoorStatuses,
  syncCabinetState: cabinetTelemetryService.syncNow,
  startCabinetStateSync: cabinetTelemetryService.start,
  stopCabinetStateSync: cabinetTelemetryService.stop,
  waitForDoorStatus,
  startDoorStatusPolling,
  stopDoorStatusPolling,
  mockSetDoorStatus,
  subscribeAll,
  clearMockDoorStatesForCabinet
}

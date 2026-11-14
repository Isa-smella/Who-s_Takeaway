const lockerRepository = require('../repositories/lockerRepository')
const bleLockerService = require('./bleLockerService')
const bluetoothService = require('./bluetoothService')
const cloudService = require('./cloudService')
const cabinetRepository = require('../repositories/cabinetRepository')
const { USE_CLOUD, BLE_TRANSPORT } = require('../config/env')
const { normalizeCabinetId, normalizeLockerId } = require('../utils/idNormalizer')

const SYNC_INTERVAL_MS = 10000
const runtimeLastSyncAt = {}
let activePoller = null

function normalizeLockerIds(lockerIds, cabinetId) {
  const source = Array.isArray(lockerIds) && lockerIds.length
    ? lockerIds
    : lockerRepository.getLockers(cabinetId).map(item => item.id)
  return Array.from(new Set(source.map(item => normalizeLockerId(item)).filter(item => item && Number(item) > 0 && Number(item) <= 200)))
}

function isVerifiedConnection(cabinetId) {
  const snapshot = bluetoothService.getVerifiedConnectionSnapshot()
  return Boolean(snapshot.verified && snapshot.cabinetId === cabinetId)
}

function syncNow(cabinetId, lockerIds = []) {
  const normalizedCabinetId = normalizeCabinetId(cabinetId)
  if (BLE_TRANSPORT !== 'HM10_TEXT') return Promise.resolve({ cabinetId: normalizedCabinetId, synced: false, lockers: [] })
  if (!normalizedCabinetId) return Promise.reject(new Error('CABINET_ID_REQUIRED'))
  if (!isVerifiedConnection(normalizedCabinetId)) return Promise.reject(new Error('BLE_NOT_IDENTIFIED'))

  let ids
  try { ids = normalizeLockerIds(lockerIds, normalizedCabinetId) } catch (error) { return Promise.reject(error) }
  if (!ids.length) return Promise.reject(new Error('TELEMETRY_LOCKER_LIST_EMPTY'))

  const readNext = (index, result) => {
    if (index >= ids.length) return Promise.resolve(result)
    return bleLockerService.getLockerStatus(ids[index], normalizedCabinetId, { priority: 'LOW' })
      .then(status => readNext(index + 1, result.concat({ lockerId: status.lockerId, doorStatus: status.doorStatus })))
  }

  return readNext(0, []).then(lockers => {
    const persist = USE_CLOUD
      ? cloudService.callFunction('reportCabinetTelemetry', { cabinetId: normalizedCabinetId, lockers })
      : Promise.resolve(cabinetRepository.reportCabinetTelemetry(normalizedCabinetId, lockers, new Date().toISOString()))
    return Promise.resolve(persist).then(() => {
      const syncedAt = new Date().toISOString()
      runtimeLastSyncAt[normalizedCabinetId] = syncedAt
      return { cabinetId: normalizedCabinetId, lockers, lastBleSeenAt: syncedAt, synced: true }
    }).catch(error => {
      try { console.warn('reportCabinetTelemetry failed', normalizedCabinetId, error) } catch (ignored) {}
      return { cabinetId: normalizedCabinetId, lockers, lastBleSeenAt: null, synced: false, error }
    })
  })
}

function stop() {
  if (!activePoller) return
  activePoller.cancelled = true
  if (activePoller.timer) clearTimeout(activePoller.timer)
  activePoller = null
}

function start(cabinetId, options = {}) {
  const normalizedCabinetId = normalizeCabinetId(cabinetId)
  if (BLE_TRANSPORT !== 'HM10_TEXT' || !normalizedCabinetId) return () => {}
  if (activePoller && !activePoller.cancelled && activePoller.cabinetId === normalizedCabinetId) return activePoller.stop
  stop()

  const poller = {
    cabinetId: normalizedCabinetId,
    lockerIds: Array.isArray(options.lockerIds) ? options.lockerIds : [],
    intervalMs: Math.max(8000, Math.min(15000, Number(options.intervalMs) || SYNC_INTERVAL_MS)),
    timer: null,
    running: false,
    cancelled: false,
    stop: null
  }
  poller.stop = () => {
    if (activePoller === poller) stop()
  }
  activePoller = poller

  const schedule = () => {
    if (poller.cancelled || activePoller !== poller) return
    poller.timer = setTimeout(run, poller.intervalMs)
  }
  const run = () => {
    if (poller.cancelled || activePoller !== poller || poller.running) return
    if (!isVerifiedConnection(poller.cabinetId)) {
      stop()
      return
    }
    poller.running = true
    syncNow(poller.cabinetId, poller.lockerIds)
      .catch(() => null)
      .then(() => {
        poller.running = false
        if (poller.cancelled || activePoller !== poller) return
        schedule()
      })
  }
  run()
  return poller.stop
}

function getRuntimeLastSyncAt(cabinetId) {
  return runtimeLastSyncAt[normalizeCabinetId(cabinetId)] || null
}

module.exports = { start, stop, syncNow, getRuntimeLastSyncAt, SYNC_INTERVAL_MS }

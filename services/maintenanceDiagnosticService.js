const permissionGuard = require('./permissionGuard')
const maintenanceWorkOrderService = require('./maintenanceWorkOrderService')
const cabinetRepository = require('../repositories/cabinetRepository')
const lockerRepository = require('../repositories/lockerRepository')
const bluetoothService = require('./bluetoothService')
const bleLockerService = require('./bleLockerService')
const doorSensorService = require('./doorSensorService')
const deviceHealthService = require('./deviceHealthService')
const operationLogService = require('./operationLogService')
const ACTIONS = require('../constants/operationActions')
const { BLE_TRANSPORT, USE_CLOUD, IS_DEVELOPMENT } = require('../config/env')

const ACTIVE_SELF_CHECK_STATUSES = ['ONSITE', 'MANUAL_UNLOCK_COMPLETED', 'SELF_CHECK_PASSED']
const checksInProgress = new Set()

function assertDiagnosticAccess() {
  return permissionGuard.assertRole(permissionGuard.MANAGEMENT_ROLES)
}

async function loadLockerTarget(orderId) {
  const order = await maintenanceWorkOrderService.getForManager(orderId)
  if (order.type !== 'LOCKER' || !order.lockerId) throw new Error('MAINTENANCE_LOCKER_TARGET_REQUIRED')
  if (!ACTIVE_SELF_CHECK_STATUSES.includes(order.status)) throw new Error('MAINTENANCE_ORDER_NOT_ONSITE')
  const cabinet = await cabinetRepository.loadCabinetForMaintenance(order.cabinetId)
  const locker = lockerRepository.getLocker(order.cabinetId, order.lockerId)
  if (!locker) throw new Error('LOCKER_NOT_FOUND')
  if (locker.status !== 'MAINTENANCE') throw new Error('LOCKER_NOT_IN_MAINTENANCE')
  if (locker.enabled === false) throw new Error('LOCKER_DISABLED')
  return { order, cabinet, locker }
}

// 维修诊断专用开锁链路。它不创建普通存取授权，也不调用 unlockExecutionService，
// 只有已登录的管理角色、已到场的对应工单可以进入；MAINTENANCE 对普通用户的限制不变。
async function runLockerSelfCheck(orderId, options = {}) {
  assertDiagnosticAccess()
  if (BLE_TRANSPORT !== 'HM10_TEXT') throw new Error('MAINTENANCE_DIAGNOSTIC_REQUIRES_BLE')
  const lockKey = String(orderId || '')
  if (!lockKey) throw new Error('MAINTENANCE_ORDER_ID_REQUIRED')
  if (checksInProgress.has(lockKey)) throw new Error('MAINTENANCE_SELF_CHECK_IN_PROGRESS')
  checksInProgress.add(lockKey)

  let connectedBefore = false
  let cabinetId = ''
  let lockerId = null
  try {
    const target = await loadLockerTarget(lockKey)
    const { order, cabinet, locker } = target
    cabinetId = cabinet.id
    lockerId = locker.id
    const existingBleState = bleLockerService.getConnectionState()
    connectedBefore = bluetoothService.isConnectedTo(cabinetId) && existingBleState.identified === true
    if (!connectedBefore) {
      const connectionAttemptId = `ble-maintenance-${Date.now()}-${Math.floor(Math.random() * 1000000)}`
      const connectionStartedAtMs = Date.now()
      operationLogService.log(ACTIONS.BLE_CONNECT_START, { cabinetId, connectionAttemptId, detail: { source: 'MAINTENANCE_SELF_CHECK' } })
      try {
        await bluetoothService.autoConnect(cabinet)
        const durationMs = Date.now() - connectionStartedAtMs
        if (IS_DEVELOPMENT) console.info('[BLE_CONNECT_TIMING]', { connectionAttemptId, cabinetId, startedAtMs: connectionStartedAtMs, durationMs, status: 'SUCCESS', source: 'MAINTENANCE_SELF_CHECK' })
        operationLogService.log(ACTIONS.BLE_CONNECT_SUCCESS, { cabinetId, connectionAttemptId, durationMs, detail: { source: 'MAINTENANCE_SELF_CHECK' } })
      } catch (error) {
        const durationMs = Date.now() - connectionStartedAtMs
        if (IS_DEVELOPMENT) console.info('[BLE_CONNECT_TIMING]', { connectionAttemptId, cabinetId, startedAtMs: connectionStartedAtMs, durationMs, status: 'FAILED', errorCode: error && error.message, source: 'MAINTENANCE_SELF_CHECK' })
        operationLogService.log(ACTIONS.BLE_CONNECT_FAILED, { cabinetId, connectionAttemptId, durationMs, result: 'FAILED', detail: { source: 'MAINTENANCE_SELF_CHECK', reason: error.message } })
        throw error
      }
    }

    // 先确认初始状态，避免在门尚未复位时把一次旧 OPEN 误当成新自检结果。
    const initialStatus = await doorSensorService.refreshDoorStatus(cabinetId, lockerId)
    if (initialStatus !== 'CLOSED') {
      const error = new Error('MAINTENANCE_DOOR_MUST_BE_CLOSED')
      error.lastDoorStatus = initialStatus
      throw error
    }

    const opened = await bleLockerService.openLocker(lockerId, cabinetId)
    if (!opened || opened.success !== true) throw new Error('MAINTENANCE_OPEN_FEEDBACK_REQUIRED')
    const openedStatus = await doorSensorService.refreshDoorStatus(cabinetId, lockerId)
    if (openedStatus !== 'OPEN') {
      const error = new Error('MAINTENANCE_OPEN_FEEDBACK_REQUIRED')
      error.lastDoorStatus = openedStatus
      throw error
    }
    if (typeof options.onOpened === 'function') options.onOpened()

    await doorSensorService.waitForDoorStatus(cabinetId, lockerId, 'CLOSED', {
      intervalMs: Number(options.intervalMs) || 900,
      timeoutMs: Number(options.timeoutMs) || 30000
    })

    let passed
    if (USE_CLOUD) passed = await maintenanceWorkOrderService.markSelfCheckPassed(cabinetId, lockerId, order.id)
    else passed = await deviceHealthService.reportHealthCheckPassed(cabinetId, lockerId)
    if (!passed) throw new Error('MAINTENANCE_ORDER_NOT_FOUND')
    return { ok: true, order: passed, cabinetId, lockerId: Number(lockerId), initialStatus, finalStatus: 'CLOSED' }
  } finally {
    checksInProgress.delete(lockKey)
    // 如果本次诊断独占建立了连接，结束后释放；若页面原本已连接则交还给原会话。
    if (!connectedBefore && bluetoothService.isConnectedTo(cabinetId)) {
      await bluetoothService.disconnectController().catch(() => null)
    }
  }
}

module.exports = { runLockerSelfCheck }

const { BLUETOOTH_STATUS } = require('../constants/status')
const { MOCK_CONNECT_DELAY_MS, BLE_TRANSPORT } = require('../config/env')
const eventBus = require('./eventBus')
const permissionGuard = require('./permissionGuard')
const bleLockerService = require('./bleLockerService')

let connection = {
  cabinetId: null,
  controllerId: null,
  deviceId: null,
  status: BLUETOOTH_STATUS.DISCONNECTED,
  phase: 'DISCONNECTED',
  identified: false
}
let attemptToken = 0
let realStateUnsubscribe = null

function mapRealStatus(status) {
  if (status === 'CONNECTED') return BLUETOOTH_STATUS.CONNECTED
  if (status === 'ERROR') return BLUETOOTH_STATUS.ERROR
  if (status === 'DISCONNECTED') return BLUETOOTH_STATUS.DISCONNECTED
  return BLUETOOTH_STATUS.CONNECTING
}

function ensureRealStateSubscription() {
  if (realStateUnsubscribe) return
  realStateUnsubscribe = bleLockerService.subscribeConnectionStatus(realState => {
    setState({
      cabinetId: realState.cabinetId || null,
      controllerId: realState.deviceId || null,
      deviceId: realState.deviceId || null,
      status: mapRealStatus(realState.status),
      phase: realState.status || 'DISCONNECTED',
      identified: Boolean(realState.identified)
    })
  })
}

function emitState() { eventBus.emit('bluetooth:status', { ...connection }) }
function setState(patch) { connection = { ...connection, ...patch }; emitState(); return { ...connection } }

function initializeBluetooth(cabinetId) {
  try { permissionGuard.assertRole(permissionGuard.CABINET_ACCESS_ROLES) } catch (error) { return Promise.reject(error) }
  if (!cabinetId) return Promise.reject(new Error('CABINET_ID_REQUIRED'))
  setState({ cabinetId, controllerId: null, deviceId: null, status: BLUETOOTH_STATUS.CONNECTING, phase: 'CONNECTING', identified: false })
  return Promise.resolve(true)
}

function scanForCabinet(cabinet) {
  try { permissionGuard.assertRole(permissionGuard.CABINET_ACCESS_ROLES) } catch (error) { return Promise.reject(error) }
  if (!cabinet || !cabinet.id) return Promise.reject(new Error('CABINET_REQUIRED'))
  if (!cabinet.bluetoothDeviceId) return Promise.reject(new Error('BLUETOOTH_DEVICE_ID_MISSING'))
  return Promise.resolve({
    cabinetId: cabinet.id,
    deviceId: cabinet.bluetoothDeviceId,
    controllerId: cabinet.bluetoothDeviceId
  })
}

function connectController(controllerId, cabinetId, deviceId, token = attemptToken) {
  try { permissionGuard.assertRole(permissionGuard.CABINET_ACCESS_ROLES) } catch (error) { return Promise.reject(error) }
  return new Promise((resolve, reject) => {
    setTimeout(() => {
      if (token !== attemptToken || connection.cabinetId !== cabinetId) {
        reject(new Error('CONNECTION_ATTEMPT_CANCELLED'))
        return
      }
      setState({ cabinetId, controllerId, deviceId, status: BLUETOOTH_STATUS.CONNECTED, phase: 'CONNECTED', identified: true })
      resolve(getConnectionState())
    }, MOCK_CONNECT_DELAY_MS)
  })
}

function autoConnect(cabinet) {
  try { permissionGuard.assertRole(permissionGuard.CABINET_ACCESS_ROLES) } catch (error) { return Promise.reject(error) }
  if (!cabinet || !cabinet.id) return Promise.reject(new Error('CABINET_REQUIRED'))
  const cabinetId = cabinet.id
  const token = ++attemptToken
  if (BLE_TRANSPORT === 'HM10_TEXT') {
    ensureRealStateSubscription()
    setState({ cabinetId, controllerId: null, deviceId: null, status: BLUETOOTH_STATUS.CONNECTING, phase: 'SCANNING', identified: false })
    return bleLockerService.connectCabinet(cabinetId, { bleIdentifier: cabinet.bleIdentifier || cabinet.bluetoothDeviceId || '' })
      .then(realState => {
        if (token !== attemptToken) throw new Error('CONNECTION_ATTEMPT_CANCELLED')
        setState({ cabinetId, controllerId: realState.deviceId || null, deviceId: realState.deviceId || null, status: BLUETOOTH_STATUS.CONNECTED, phase: 'CONNECTED', identified: true })
        return getConnectionState()
      })
      .catch(error => {
        if (error.message !== 'CONNECTION_ATTEMPT_CANCELLED' && token === attemptToken) setState({ cabinetId, status: BLUETOOTH_STATUS.ERROR, phase: 'ERROR', identified: false })
        throw error
      })
  }
  return initializeBluetooth(cabinetId)
    .then(() => scanForCabinet(cabinet))
    .then(device => connectController(device.controllerId, cabinetId, device.deviceId, token))
    .catch(error => {
      if (error.message !== 'CONNECTION_ATTEMPT_CANCELLED' && token === attemptToken) {
        setState({ cabinetId, status: BLUETOOTH_STATUS.ERROR, phase: 'ERROR', identified: false })
      }
      throw error
    })
}

function disconnectController() {
  attemptToken += 1
  if (BLE_TRANSPORT === 'HM10_TEXT') {
    return bleLockerService.disconnectCabinet().catch(() => {}).then(() => {
      connection = { cabinetId: null, controllerId: null, deviceId: null, status: BLUETOOTH_STATUS.DISCONNECTED, phase: 'DISCONNECTED', identified: false }
      emitState()
      return getConnectionState()
    })
  }
  connection = { cabinetId: null, controllerId: null, deviceId: null, status: BLUETOOTH_STATUS.DISCONNECTED, phase: 'DISCONNECTED', identified: false }
  emitState()
  return Promise.resolve()
}

function getConnectionState() { return { ...connection } }
function getVerifiedConnectionSnapshot() {
  const state = getConnectionState()
  const verified = Boolean(
    state.cabinetId &&
    state.status === BLUETOOTH_STATUS.CONNECTED &&
    state.identified
  )
  return {
    connected: verified,
    verified,
    cabinetId: state.cabinetId || null,
    state: state.status,
    phase: state.phase,
    identified: Boolean(state.identified)
  }
}
function getConnectionStatus(cabinetId) {
  if (cabinetId && connection.cabinetId !== cabinetId) return BLUETOOTH_STATUS.DISCONNECTED
  return connection.status
}
function isConnectedTo(cabinetId) {
  return isVerifiedConnectedTo(cabinetId)
}
function isVerifiedConnectedTo(cabinetId) {
  return Boolean(cabinetId && connection.cabinetId === cabinetId && connection.status === BLUETOOTH_STATUS.CONNECTED && connection.identified)
}
function subscribeConnectionStatus(callback) { return eventBus.on('bluetooth:status', callback) }
function mockSetConnectionStatus(status, cabinetId) {
  permissionGuard.assertRole(['DEVELOPER'])
  attemptToken += 1
  const targetCabinetId = cabinetId || connection.cabinetId
  setState({
    cabinetId: targetCabinetId,
    controllerId: status === BLUETOOTH_STATUS.CONNECTED ? `${targetCabinetId}-MAIN` : null,
    deviceId: status === BLUETOOTH_STATUS.CONNECTED ? `MOCK-${targetCabinetId}` : null,
    status,
    phase: status,
    identified: status === BLUETOOTH_STATUS.CONNECTED
  })
}

module.exports = {
  initializeBluetooth,
  scanForCabinet,
  connectController,
  disconnectController,
  getConnectionState,
  getVerifiedConnectionSnapshot,
  getConnectionStatus,
  isConnectedTo,
  isVerifiedConnectedTo,
  subscribeConnectionStatus,
  autoConnect,
  mockSetConnectionStatus
}

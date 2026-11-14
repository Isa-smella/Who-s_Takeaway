const eventBus = require('./eventBus')
const { BLE_IDENTIFY_TIMEOUT_MS, BLE_COMMAND_TIMEOUT_MS, BLE_CONNECT_TIMEOUT_MS } = require('../config/env')
const { normalizeCabinetId: normalizeCabinetIdValue, formatLockerIdForProtocol } = require('../utils/idNormalizer')

const HM10_NAME_PATTERN = /HMSoft/i
const FFE0_PATTERN = /FFE0/i
const FFE1_PATTERN = /FFE1/i

let state = {
  cabinetId: null,
  deviceId: null,
  deviceName: null,
  serviceId: null,
  characteristicId: null,
  status: 'DISCONNECTED',
  identified: false
}
let connectionSession = null
let pendingRequest = null
const commandQueue = []
let commandInFlight = false
let rxBuffer = ''
let lockerStatuses = {}
let valueChangeHandler = null
let deviceFoundHandler = null
let connectionStateHandler = null

function normalizeCabinetId(cabinetId) {
  const value = normalizeCabinetIdValue(cabinetId)
  if (!value) throw new Error('CABINET_ID_REQUIRED')
  return value
}

function normalizeLockerId(lockerId) {
  return formatLockerIdForProtocol(lockerId)
}

function stateSnapshot() { return { ...state } }

function setState(patch) {
  state = { ...state, ...patch }
  eventBus.emit('ble-locker:status', stateSnapshot())
  return stateSnapshot()
}

function cacheLockerStatus(cabinetId, lockerId, doorStatus) {
  const normalizedLockerId = normalizeLockerId(lockerId)
  const payload = { cabinetId, lockerId: normalizedLockerId, doorStatus }
  lockerStatuses[`${cabinetId}:${normalizedLockerId}`] = payload
  eventBus.emit('ble-locker:locker-status', payload)
  return payload
}

function getCachedLockerStatus(cabinetId, lockerId) {
  let normalizedLockerId
  try { normalizedLockerId = normalizeLockerId(lockerId) } catch (error) { return null }
  return lockerStatuses[`${cabinetId}:${normalizedLockerId}`] || null
}

function asciiToArrayBuffer(text) {
  const buffer = new ArrayBuffer(text.length)
  const view = new Uint8Array(buffer)
  for (let index = 0; index < text.length; index += 1) view[index] = text.charCodeAt(index) & 0xFF
  return buffer
}

function arrayBufferToAscii(buffer) {
  const view = new Uint8Array(buffer)
  let text = ''
  for (let index = 0; index < view.length; index += 1) text += String.fromCharCode(view[index])
  return text
}

function parseProtocolLine(line) {
  const identify = line.match(/^@IDENTIFY:(.+)$/)
  if (identify) return { type: 'IDENTIFY', cabinetId: identify[1].trim() }

  const open = line.match(/^@OPEN:(\d+):(OK|FAIL)$/)
  if (open) return { type: 'OPEN', lockerId: String(Number(open[1])).padStart(2, '0'), result: open[2] }

  const status = line.match(/^@STATUS:(\d+):(OPEN|LOCKED)$/)
  if (status) {
    const lockerId = String(Number(status[1])).padStart(2, '0')
    return { type: 'STATUS', lockerId, doorStatus: status[2] === 'OPEN' ? 'OPEN' : 'CLOSED' }
  }

  return { type: 'UNKNOWN', raw: line }
}

function clearPendingRequest(error) {
  if (!pendingRequest) return
  const request = pendingRequest
  pendingRequest = null
  clearTimeout(request.timer)
  request.reject(error)
}

function settlePendingRequest(frame) {
  if (!pendingRequest || !pendingRequest.matchResponse(frame)) return false
  const request = pendingRequest
  pendingRequest = null
  clearTimeout(request.timer)
  request.resolve(frame)
  return true
}

function handleProtocolLine(line) {
  const frame = parseProtocolLine(line)
  if (frame.type === 'STATUS') cacheLockerStatus(state.cabinetId, frame.lockerId, frame.doorStatus)
  if (frame.type === 'OPEN' && frame.result === 'OK') cacheLockerStatus(state.cabinetId, frame.lockerId, 'OPEN')
  settlePendingRequest(frame)
}

function handleCharacteristicValueChange(result) {
  if (!result || (state.deviceId && result.deviceId && result.deviceId !== state.deviceId)) return
  rxBuffer += arrayBufferToAscii(result.value)
  let lineEnd
  while ((lineEnd = rxBuffer.indexOf('\n')) !== -1) {
    const line = rxBuffer.slice(0, lineEnd).replace(/\r/g, '').trim()
    rxBuffer = rxBuffer.slice(lineEnd + 1)
    if (line) handleProtocolLine(line)
  }
}

function bindValueChangeHandler() {
  if (valueChangeHandler || !wx.onBLECharacteristicValueChange) return
  valueChangeHandler = handleCharacteristicValueChange
  wx.onBLECharacteristicValueChange(valueChangeHandler)
}

function unbindValueChangeHandler() {
  if (!valueChangeHandler || !wx.offBLECharacteristicValueChange) return
  wx.offBLECharacteristicValueChange(valueChangeHandler)
  valueChangeHandler = null
}

function bindConnectionStateHandler() {
  if (connectionStateHandler || !wx.onBLEConnectionStateChange) return
  connectionStateHandler = result => {
    if (!result || !state.deviceId || result.deviceId !== state.deviceId || result.connected) return
    clearPendingRequest(new Error('BLE_DISCONNECTED'))
    setState({ status: 'DISCONNECTED', identified: false, deviceId: null, deviceName: null, serviceId: null, characteristicId: null })
  }
  wx.onBLEConnectionStateChange(connectionStateHandler)
}

function unbindConnectionStateHandler() {
  if (!connectionStateHandler || !wx.offBLEConnectionStateChange) return
  wx.offBLEConnectionStateChange(connectionStateHandler)
  connectionStateHandler = null
}

function bindDeviceFoundHandler(handler) {
  if (deviceFoundHandler && wx.offBluetoothDeviceFound) wx.offBluetoothDeviceFound(deviceFoundHandler)
  deviceFoundHandler = handler
  wx.onBluetoothDeviceFound(deviceFoundHandler)
}

function unbindDeviceFoundHandler() {
  if (!deviceFoundHandler || !wx.offBluetoothDeviceFound) return
  wx.offBluetoothDeviceFound(deviceFoundHandler)
  deviceFoundHandler = null
}

function stopDiscovery() {
  if (!wx.stopBluetoothDevicesDiscovery) return Promise.resolve()
  return new Promise(resolve => wx.stopBluetoothDevicesDiscovery({ complete: resolve }))
}

function closeDevice(deviceId) {
  if (!deviceId || !wx.closeBLEConnection) return Promise.resolve()
  return new Promise(resolve => wx.closeBLEConnection({ deviceId, complete: resolve }))
}

function openAdapter() {
  return new Promise((resolve, reject) => {
    wx.openBluetoothAdapter({ success: resolve, fail: reject })
  })
}

function startDiscovery() {
  return new Promise((resolve, reject) => {
    wx.startBluetoothDevicesDiscovery({ allowDuplicatesKey: false, success: resolve, fail: reject })
  })
}

function connectGatt(deviceId) {
  return new Promise((resolve, reject) => {
    wx.createBLEConnection({ deviceId, timeout: 10000, success: resolve, fail: reject })
  })
}

function getServices(deviceId) {
  return new Promise((resolve, reject) => {
    wx.getBLEDeviceServices({ deviceId, success: result => resolve(result.services || []), fail: reject })
  })
}

function getCharacteristics(deviceId, serviceId) {
  return new Promise((resolve, reject) => {
    wx.getBLEDeviceCharacteristics({ deviceId, serviceId, success: result => resolve(result.characteristics || []), fail: reject })
  })
}

function enableNotify(deviceId, serviceId, characteristicId) {
  return new Promise((resolve, reject) => {
    wx.notifyBLECharacteristicValueChange({ state: true, deviceId, serviceId, characteristicId, success: resolve, fail: reject })
  })
}

function findWritableCharacteristic(deviceId, services) {
  const preferred = services.filter(item => FFE0_PATTERN.test(item.uuid))
  const candidates = preferred.concat(services.filter(item => !preferred.includes(item)))
  let chain = Promise.resolve(null)
  candidates.forEach(service => {
    chain = chain.then(found => {
      if (found) return found
      return getCharacteristics(deviceId, service.uuid).then(characteristics => {
        const characteristic = characteristics.find(item => FFE1_PATTERN.test(item.uuid))
        if (!characteristic) return null
        const properties = characteristic.properties || {}
        if (!properties.write && !properties.writeNoResponse) return null
        if (!properties.notify && !properties.indicate) return null
        return { serviceId: service.uuid, characteristicId: characteristic.uuid }
      }).catch(() => null)
    })
  })
  return chain.then(found => found || Promise.reject(new Error('BLE_FFE1_NOT_FOUND')))
}

function sendCommandAndWait({ command, matchResponse, timeout }) {
  if (!state.deviceId || !state.serviceId || !state.characteristicId) return Promise.reject(new Error('BLE_NOT_READY'))
  return new Promise((resolve, reject) => {
    if (pendingRequest) {
      reject(new Error('BLE_COMMAND_BUSY'))
      return
    }
    const request = {
      command,
      matchResponse,
      resolve,
      reject,
      timer: setTimeout(() => {
        if (pendingRequest !== request) return
        pendingRequest = null
        reject(new Error('BLE_COMMAND_TIMEOUT'))
      }, timeout)
    }
    pendingRequest = request
    try {
      wx.writeBLECharacteristicValue({
        deviceId: state.deviceId,
        serviceId: state.serviceId,
        characteristicId: state.characteristicId,
        value: asciiToArrayBuffer(`${command}\r`),
        fail: error => {
          if (pendingRequest !== request) return
          pendingRequest = null
          clearTimeout(request.timer)
          reject(error || new Error('BLE_WRITE_FAILED'))
        }
      })
    } catch (error) {
      if (pendingRequest === request) pendingRequest = null
      clearTimeout(request.timer)
      reject(error || new Error('BLE_WRITE_FAILED'))
    }
  })
}

function enqueueCommand(request) {
  return new Promise((resolve, reject) => {
    const item = { request, resolve, reject }
    if (request && request.priority === 'LOW') commandQueue.push(item)
    else {
      const firstLowIndex = commandQueue.findIndex(queued => queued.request && queued.request.priority === 'LOW')
      if (firstLowIndex < 0) commandQueue.push(item)
      else commandQueue.splice(firstLowIndex, 0, item)
    }
    drainCommandQueue()
  })
}

function drainCommandQueue() {
  if (commandInFlight || !commandQueue.length) return
  const item = commandQueue.shift()
  commandInFlight = true
  Promise.resolve(sendCommandAndWait(item.request))
    .then(item.resolve, item.reject)
    .then(() => {
      commandInFlight = false
      drainCommandQueue()
    }, () => {
      commandInFlight = false
      drainCommandQueue()
    })
}

function clearQueuedCommands(error = new Error('BLE_COMMAND_CANCELLED')) {
  while (commandQueue.length) commandQueue.shift().reject(error)
}

function createIdentityError(expectedCabinetId, actualCabinetId) {
  const error = new Error('BLE_CABINET_IDENTITY_MISMATCH')
  error.expectedCabinetId = expectedCabinetId
  error.actualCabinetId = actualCabinetId
  return error
}

function resetDeviceFields() {
  state = { ...state, deviceId: null, deviceName: null, serviceId: null, characteristicId: null, identified: false }
}

function failConnectionSession(session, error) {
  if (!connectionSession || connectionSession !== session || session.finished) return
  session.finished = true
  clearTimeout(session.timer)
  unbindDeviceFoundHandler()
  stopDiscovery().catch(() => {})
  closeDevice(state.deviceId).catch(() => {})
  connectionSession = null
  resetDeviceFields()
  setState({ status: 'ERROR', identified: false })
  session.reject(error)
}

function succeedConnectionSession(session) {
  if (!connectionSession || connectionSession !== session || session.finished) return
  session.finished = true
  clearTimeout(session.timer)
  unbindDeviceFoundHandler()
  stopDiscovery().catch(() => {})
  connectionSession = null
  setState({ status: 'CONNECTED', cabinetId: session.cabinetId, identified: true })
  session.resolve({ ...stateSnapshot(), connected: true })
}

function closeCandidate(session, deviceId) {
  resetDeviceFields()
  return closeDevice(deviceId).catch(() => {})
}

function attemptCandidate(session, device) {
  if (!connectionSession || connectionSession !== session || session.finished || session.trying) return
  session.trying = true
  setState({ status: 'CONNECTING', cabinetId: session.cabinetId, deviceId: device.deviceId, deviceName: device.localName || device.name || 'HMSoft', identified: false, serviceId: null, characteristicId: null })
  connectGatt(device.deviceId)
    .then(() => getServices(device.deviceId))
    .then(services => findWritableCharacteristic(device.deviceId, services))
    .then(characteristic => {
      setState({ serviceId: characteristic.serviceId, characteristicId: characteristic.characteristicId, status: 'VERIFYING' })
      bindValueChangeHandler()
      bindConnectionStateHandler()
      return enableNotify(device.deviceId, characteristic.serviceId, characteristic.characteristicId)
    })
    .then(() => enqueueCommand({
      command: '@IDENTIFY',
      timeout: BLE_IDENTIFY_TIMEOUT_MS,
      matchResponse: frame => frame.type === 'IDENTIFY'
    }))
    .then(frame => {
      const actualCabinetId = normalizeCabinetId(frame.cabinetId)
      if (actualCabinetId !== session.cabinetId) throw createIdentityError(session.cabinetId, actualCabinetId)
      succeedConnectionSession(session)
    })
    .catch(error => {
      session.lastError = error
      closeCandidate(session, device.deviceId).then(() => {
        if (!connectionSession || connectionSession !== session || session.finished) return
        session.trying = false
        setState({ status: 'SCANNING', cabinetId: session.cabinetId, identified: false })
        attemptNextCandidate(session)
      })
    })
}

function attemptNextCandidate(session) {
  if (!connectionSession || connectionSession !== session || session.finished || session.trying) return
  const device = session.candidates.shift()
  if (!device) {
    setState({ status: 'SCANNING', cabinetId: session.cabinetId, identified: false })
    return
  }
  attemptCandidate(session, device)
}

function isCandidateDevice(device) {
  const name = String(device.localName || device.name || '')
  return HM10_NAME_PATTERN.test(name)
}

function candidateScore(device, preferredIdentifier) {
  if (!preferredIdentifier) return 0
  const deviceId = String(device.deviceId || '')
  const name = String(device.localName || device.name || '')
  return deviceId === preferredIdentifier || name === preferredIdentifier ? 1 : 0
}

function beginConnectionSession(session, preferredIdentifier) {
  bindDeviceFoundHandler(result => {
    const devices = (result.devices || []).slice().sort((a, b) => candidateScore(b, preferredIdentifier) - candidateScore(a, preferredIdentifier))
    for (const device of devices) {
      if (!device || !device.deviceId || !isCandidateDevice(device) || session.seen.has(device.deviceId)) continue
      session.seen.add(device.deviceId)
      session.candidates.push(device)
    }
    attemptNextCandidate(session)
  })
  openAdapter()
    .then(() => startDiscovery())
    .catch(error => failConnectionSession(session, error))
}

function connectCabinet(cabinetId, options = {}) {
  const targetCabinetId = normalizeCabinetId(cabinetId)
  if (state.status === 'CONNECTED' && state.cabinetId === targetCabinetId && state.identified) return Promise.resolve({ ...stateSnapshot(), connected: true })
  if (connectionSession) return Promise.reject(new Error('BLE_CONNECTION_BUSY'))

  const start = () => new Promise((resolve, reject) => {
    const session = {
      cabinetId: targetCabinetId,
      candidates: [],
      seen: new Set(),
      trying: false,
      finished: false,
      lastError: null,
      resolve,
      reject,
      timer: setTimeout(() => failConnectionSession(session, session.lastError || new Error('BLE_CONNECTION_TIMEOUT')), BLE_CONNECT_TIMEOUT_MS)
    }
    connectionSession = session
    rxBuffer = ''
    setState({ cabinetId: targetCabinetId, status: 'SCANNING', identified: false, deviceId: null, deviceName: null, serviceId: null, characteristicId: null })
    beginConnectionSession(session, options.bleIdentifier || '')
  })

  if (state.status !== 'DISCONNECTED' || state.deviceId) return disconnectCabinet().then(start)
  return start()
}

function assertConnectedCabinet(targetCabinetId) {
  if (targetCabinetId && state.cabinetId !== targetCabinetId) throw new Error('BLE_CABINET_MISMATCH')
  if (state.status !== 'CONNECTED' || !state.identified) throw new Error('BLE_NOT_IDENTIFIED')
}

function openLocker(lockerId, cabinetId = '') {
  let normalizedLockerId
  try { normalizedLockerId = normalizeLockerId(lockerId) } catch (error) { return Promise.reject(error) }
  try { assertConnectedCabinet(cabinetId) } catch (error) { return Promise.reject(error) }
  return enqueueCommand({
    command: `@OPEN:${normalizedLockerId}`,
    timeout: BLE_COMMAND_TIMEOUT_MS,
    priority: 'HIGH',
    matchResponse: frame => frame.type === 'OPEN' && frame.lockerId === normalizedLockerId
  }).then(frame => {
    if (frame.result !== 'OK') throw new Error('BLE_LOCKER_OPEN_FAILED')
    return { lockerId: normalizedLockerId, success: true, doorStatus: 'OPEN', cabinetId: state.cabinetId }
  })
}

function getLockerStatus(lockerId, cabinetId = '', options = {}) {
  let normalizedLockerId
  try { normalizedLockerId = normalizeLockerId(lockerId) } catch (error) { return Promise.reject(error) }
  try { assertConnectedCabinet(cabinetId) } catch (error) { return Promise.reject(error) }
  return enqueueCommand({
    command: `@STATUS:${normalizedLockerId}`,
    timeout: BLE_COMMAND_TIMEOUT_MS,
    priority: options.priority === 'LOW' ? 'LOW' : 'HIGH',
    matchResponse: frame => frame.type === 'STATUS' && frame.lockerId === normalizedLockerId
  }).then(frame => ({ cabinetId: state.cabinetId, lockerId: normalizedLockerId, doorStatus: frame.doorStatus }))
}

function disconnectCabinet() {
  const session = connectionSession
  if (session) {
    session.finished = true
    clearTimeout(session.timer)
    connectionSession = null
    session.reject(new Error('BLE_CONNECTION_CANCELLED'))
  }
  clearPendingRequest(new Error('BLE_CONNECTION_CANCELLED'))
  clearQueuedCommands(new Error('BLE_CONNECTION_CANCELLED'))
  unbindDeviceFoundHandler()
  unbindConnectionStateHandler()
  const deviceId = state.deviceId
  resetDeviceFields()
  return stopDiscovery()
    .catch(() => {})
    .then(() => closeDevice(deviceId))
    .catch(() => {})
    .then(() => {
      setState({ cabinetId: null, status: 'DISCONNECTED', identified: false })
      return stateSnapshot()
    })
}

function subscribeConnectionStatus(callback) { return eventBus.on('ble-locker:status', callback) }
function subscribeLockerStatus(callback) { return eventBus.on('ble-locker:locker-status', callback) }

module.exports = {
  connectCabinet,
  openLocker,
  getLockerStatus,
  disconnectCabinet,
  getConnectionState: stateSnapshot,
  getCachedLockerStatus,
  subscribeConnectionStatus,
  subscribeLockerStatus,
  normalizeLockerId
}

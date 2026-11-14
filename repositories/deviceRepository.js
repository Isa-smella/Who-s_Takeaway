const { createDeviceTelemetry } = require('../models/index')

const STORAGE_KEY = 'LAKES_TAKEAWAY_MOCK_DEVICE_TELEMETRY_V1'

function readStore() { return wx.getStorageSync(STORAGE_KEY) || {} }
function writeStore(store) { wx.setStorageSync(STORAGE_KEY, store) }

function createDefault(cabinetId) {
  return createDeviceTelemetry({
    cabinetId,
    batteryPercent: 86,
    voltage: 4.03,
    onlineStatus: 'ONLINE',
    firmwareVersion: 'mock-0.1.0'
  })
}

function getTelemetry(cabinetId) {
  if (!cabinetId) throw new Error('CABINET_ID_REQUIRED')
  const store = readStore()
  if (!store[cabinetId]) {
    store[cabinetId] = createDefault(cabinetId)
    writeStore(store)
  }
  return createDeviceTelemetry(store[cabinetId])
}

// 仅供开发调试页模拟 ESP32 上报；正式版替换为云端设备遥测接口。
function mockReportTelemetry(cabinetId, patch = {}) {
  const store = readStore()
  const current = store[cabinetId] || createDefault(cabinetId)
  const batteryPercent = Math.max(0, Math.min(100, Number(patch.batteryPercent ?? current.batteryPercent)))
  store[cabinetId] = createDeviceTelemetry({
    ...current,
    ...patch,
    cabinetId,
    batteryPercent,
    reportedAt: new Date().toISOString()
  })
  writeStore(store)
  return store[cabinetId]
}
function resetMockTelemetry(cabinetId) {
  const store = readStore()
  delete store[cabinetId]
  writeStore(store)
}

module.exports = { getTelemetry, mockReportTelemetry, resetMockTelemetry }

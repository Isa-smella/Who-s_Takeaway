const bluetoothService = require('./bluetoothService')
const cabinetTelemetryService = require('./cabinetTelemetryService')
const { formatDateTime } = require('../utils/dateFormatter')

function getDisplay(cabinetId, persistedLastSeenAt) {
  const connected = bluetoothService.isVerifiedConnectedTo(cabinetId)
  const lastSeenAt = cabinetTelemetryService.getRuntimeLastSyncAt(cabinetId) || persistedLastSeenAt || null
  const formattedLastSeenAt = formatDateTime(lastSeenAt)
  return {
    bleConnected: connected,
    bleStatusText: connected ? '在线' : '未连接',
    bleLastSeenLabel: connected ? '最后通信：刚刚' : formattedLastSeenAt ? `最近通信：${formattedLastSeenAt}` : '暂无通信记录'
  }
}

function decorateCabinet(cabinet) {
  return { ...cabinet, ...getDisplay(cabinet.id, cabinet.lastBleSeenAt) }
}

function subscribe(callback) { return bluetoothService.subscribeConnectionStatus(callback) }

module.exports = { getDisplay, decorateCabinet, subscribe, formatDateTime }

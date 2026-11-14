const bluetoothService = require('./bluetoothService')
const protocol = require('./bleEspProtocolService')
const bleLockerService = require('./bleLockerService')
const { BLE_TRANSPORT } = require('../config/env')

// 当前由 Mock handler 模拟 ESP32。接入实体机时仅替换本文件中的传输实现：
// wx.writeBLECharacteristicValue 分包写入，notify 收包后按 requestId 重组。
function send(cabinetId, request, mockDeviceHandler) {
  if (!bluetoothService.isConnectedTo(cabinetId)) return Promise.reject(new Error('BLUETOOTH_NOT_CONNECTED_TO_CABINET'))
  try {
    protocol.validateRequest(request)
    if (BLE_TRANSPORT === 'HM10_TEXT') {
      if (request.command !== protocol.COMMANDS.OPEN_LOCK) return Promise.reject(new Error('BLE_COMMAND_UNSUPPORTED'))
      return bleLockerService.openLocker(request.lockerId, cabinetId).then(result => {
        const response = protocol.createResponse(request, protocol.RESPONSE_CODES.OK, {
          commandAccepted: true,
          driverExecuted: true,
          doorOpened: result.doorStatus === 'OPEN'
        })
        return protocol.validateResponse(response, request)
      })
    }
    const outboundChunks = protocol.splitFrame(request)
    const deviceRequest = protocol.joinChunks(outboundChunks)
    return Promise.resolve(mockDeviceHandler(deviceRequest)).then(deviceResponse => {
      const inboundChunks = protocol.splitFrame(deviceResponse)
      return protocol.validateResponse(protocol.joinChunks(inboundChunks), request)
    })
  } catch (error) { return Promise.reject(error) }
}

module.exports = { send }

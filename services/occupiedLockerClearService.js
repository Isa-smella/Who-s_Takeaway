const unlockAuthorizationService = require('./unlockAuthorizationService')
const unlockExecutionService = require('./unlockExecutionService')
const cabinetManagementService = require('./cabinetManagementService')

function openForInspection(cabinetId, lockerId) {
  return Promise.resolve(getApp().switchCabinet(cabinetId))
    .then(() => unlockAuthorizationService.requestUnlockAuthorization({
      source: 'ADMIN_OCCUPIED_CLEAR',
      cabinetId,
      lockerId: Number(lockerId)
    }))
    .then(authorization => unlockExecutionService.executeAuthorization({ authorizationId: authorization.id, currentCabinetId: cabinetId })
      .then(() => ({ authorizationId: authorization.id })))
}

function confirmPhysicallyEmpty(cabinetId, lockerId, authorizationId) {
  return Promise.resolve(cabinetManagementService.clearOccupiedLockerAsEmpty(cabinetId, Number(lockerId), authorizationId))
}

function getErrorMessage(error) {
  const messages = {
    CABINET_NOT_ACTIVE: '整柜当前不可操作',
    LOCKER_NOT_OCCUPIED: '该柜格已经不是占用状态',
    LOCKER_DISABLED: '该柜格正在维修中',
    LOCKER_IN_MAINTENANCE: '该柜格正在维修中',
    LOCKER_MULTIPLE_WAITING_RECORDS: '该柜格存在多条未取餐记录，请先核查数据',
    LOCKER_WAITING_RECORD_MISMATCH: '柜格与未取餐记录不一致，请刷新后核查',
    OCCUPIED_CLEAR_AUTHORIZATION_INVALID: '本次核空授权已失效，请重新开柜核查',
    BLUETOOTH_NOT_CONNECTED_TO_CABINET: '未连接对应柜体，请靠近后重试',
    DOOR_NOT_OPEN: '开锁指令已发送，但柜门未弹开',
    LOCK_DRIVER_FAILED: '柜锁驱动执行失败，请重试',
    ESP32_AUTHORIZATION_REJECTED: '柜体拒绝了本次开柜指令'
  }
  return messages[error && error.message] || '操作失败，请刷新后重试'
}

module.exports = { openForInspection, confirmPhysicallyEmpty, getErrorMessage }

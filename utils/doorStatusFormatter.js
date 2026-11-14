const VALID_DOOR_STATUSES = Object.freeze(['OPEN', 'CLOSED'])

function isDoorStatus(value) {
  return VALID_DOOR_STATUSES.includes(value)
}

function formatDoorStatus(value, unknownLabel = '门状态未知') {
  if (value === 'OPEN') return '柜门开启'
  if (value === 'CLOSED') return '柜门关闭'
  return unknownLabel
}

module.exports = { VALID_DOOR_STATUSES, isDoorStatus, formatDoorStatus }

function toTrimmedString(value) {
  return String(value || '').trim()
}

// 业务层统一使用不带补零的字符串，例如 1、'1'、'01' 都归一为 '1'。
function normalizeLockerId(value) {
  const text = toTrimmedString(value)
  const numeric = Number(text)
  return Number.isInteger(numeric) && numeric > 0
    ? String(numeric)
    : text.replace(/^0+(?=\d)/, '')
}

// STM32 协议仍要求两位柜格编号，例如 01。
function formatLockerIdForProtocol(value) {
  const numeric = Number(toTrimmedString(value))
  if (!Number.isInteger(numeric) || numeric < 1 || numeric > 200) throw new Error('LOCKER_ID_INVALID')
  return String(numeric).padStart(2, '0')
}

function normalizeCabinetId(value) {
  return toTrimmedString(value).toUpperCase()
}

module.exports = { normalizeLockerId, normalizeCabinetId, formatLockerIdForProtocol }

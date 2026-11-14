const PENDING_KEY = 'LAKES_TAKEAWAY_PENDING_CABINET_ID'

function setPendingCabinetId(cabinetId) {
  const value = String(cabinetId || '').trim()
  if (!value) return clearPendingCabinetId()
  wx.setStorageSync(PENDING_KEY, value)
  return value
}
function getPendingCabinetId() { return wx.getStorageSync(PENDING_KEY) || null }
function clearPendingCabinetId() { wx.removeStorageSync(PENDING_KEY) }

module.exports = { setPendingCabinetId, getPendingCabinetId, clearPendingCabinetId }

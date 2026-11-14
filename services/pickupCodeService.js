/** 取餐码由存餐人员输入用户手机号后4位；本模块只负责格式规范，不再生成随机码。 */
function normalizePickupCode(value) { return String(value || '').slice(0, 5) }
function isValidPickupCode(value) { return /^\d{4}$/.test(String(value || '')) }
function assertValidPickupCode(value) {
  const pickupCode = String(value || '')
  if (!isValidPickupCode(pickupCode)) throw new Error('PICKUP_CODE_INVALID')
  return pickupCode
}

module.exports = { normalizePickupCode, isValidPickupCode, assertValidPickupCode }

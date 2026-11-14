function safeDecode(value) {
  try { return decodeURIComponent(value) } catch (error) { return value }
}

function extractFromText(value) {
  const text = safeDecode(String(value || '').trim())
  if (!text) return null

  const cabinetMatch = text.match(/(?:[?&]|^)cabinetId=([^&#]+)/i)
  if (cabinetMatch) return safeDecode(cabinetMatch[1]).trim() || null

  const sceneMatch = text.match(/(?:[?&]|^)scene=([^&#]+)/i)
  if (sceneMatch) {
    const scene = safeDecode(sceneMatch[1])
    const nested = scene.match(/(?:^|&)cabinetId=([^&]+)/i)
    return safeDecode(nested ? nested[1] : scene).trim() || null
  }

  // 允许二维码内容直接就是 cabinetId，但不会把普通网址误当成柜体编号。
  if (/^[A-Za-z0-9][A-Za-z0-9._:-]{0,63}$/.test(text)) return text
  return null
}

function parseCabinetId(scanResult = {}) {
  return extractFromText(scanResult.path) || extractFromText(scanResult.result)
}

function scanCabinetId() {
  return permissionGuard.requireAccess().then(() => new Promise((resolve, reject) => {
    wx.scanCode({
      onlyFromCamera: false,
      success(result) {
        const cabinetId = parseCabinetId(result)
        if (!cabinetId) {
          reject(new Error('CABINET_ID_NOT_FOUND'))
          return
        }
        resolve(cabinetId)
      },
      fail: reject
    })
  }))
}

function scanAndSwitchCabinet() {
  return scanCabinetId().then(cabinetId => getApp().handleScannedCabinet(cabinetId)
    .then(() => cabinetId)
    .catch(error => {
      error.cabinetId = cabinetId
      throw error
    }))
}

function getCabinetErrorMessage(error) {
  const messages = {
    CABINET_ID_NOT_FOUND: '二维码中没有柜体编号',
    CABINET_NOT_FOUND: '未找到该柜体',
    CABINET_DISABLED: '该柜体维修中',
    CABINET_MAINTENANCE: '该柜体维修中'
  }
  return messages[error && error.message] || '扫码连接失败'
}

module.exports = { parseCabinetId, scanCabinetId, scanAndSwitchCabinet, getCabinetErrorMessage }
const permissionGuard = require('./permissionGuard')

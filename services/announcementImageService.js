const cloudService = require('./cloudService')

const MAX_IMAGE_BYTES = 10 * 1024 * 1024
const COMPRESS_THRESHOLD_BYTES = 1024 * 1024
const MAX_UPLOAD_ATTEMPTS = 3

function createError(code) { return new Error(code) }
function getExtension(filePath) {
  const matched = String(filePath || '').match(/\.([a-z0-9]+)(?:\?|$)/i)
  const extension = matched ? matched[1].toLowerCase() : 'jpg'
  return ['jpg', 'jpeg', 'png', 'webp', 'gif'].includes(extension) ? extension : 'jpg'
}
function normalizeChosenImages(result) {
  const detailedFiles = Array.isArray(result && result.tempFiles) ? result.tempFiles : []
  const pathFiles = Array.isArray(result && result.tempFilePaths) ? result.tempFilePaths : []
  const files = detailedFiles.map(file => ({
    tempFilePath: file && (file.tempFilePath || file.path),
    size: Number(file && file.size || 0)
  }))
  pathFiles.forEach((tempFilePath, index) => {
    if (!files[index]) files[index] = { tempFilePath, size: 0 }
    else if (!files[index].tempFilePath) files[index].tempFilePath = tempFilePath
  })
  return files.filter(file => file && file.tempFilePath)
}
function chooseImages(maxCount) {
  return new Promise((resolve, reject) => {
    const count = Math.min(9, Math.max(1, Number(maxCount) || 1))
    const chooser = typeof wx.chooseImage === 'function' ? wx.chooseImage : wx.chooseMedia
    if (typeof chooser !== 'function') return reject(createError('ANNOUNCEMENT_IMAGE_CHOOSE_UNAVAILABLE'))
    const options = {
      count,
      sourceType: ['album', 'camera'],
      success: result => {
        const files = normalizeChosenImages(result).slice(0, count)
        if (!files.length) return reject(createError('ANNOUNCEMENT_IMAGE_NOT_SELECTED'))
        if (files.some(file => Number(file.size || 0) > MAX_IMAGE_BYTES)) return reject(createError('ANNOUNCEMENT_IMAGE_TOO_LARGE'))
        resolve(files)
      },
      fail: error => {
        if (/cancel/i.test(String(error && error.errMsg))) return reject(createError('ANNOUNCEMENT_IMAGE_CHOOSE_CANCELLED'))
        reject(error || createError('ANNOUNCEMENT_IMAGE_CHOOSE_FAILED'))
      }
    }
    if (chooser === wx.chooseMedia) options.mediaType = ['image']
    else options.sizeType = ['original', 'compressed']
    chooser.call(wx, options)
  })
}
function compressIfNeeded(file) {
  if (Number(file.size || 0) <= COMPRESS_THRESHOLD_BYTES || typeof wx.compressImage !== 'function') return Promise.resolve(file.tempFilePath)
  return new Promise((resolve, reject) => {
    wx.compressImage({
      src: file.tempFilePath,
      quality: 78,
      success: result => resolve(result.tempFilePath || file.tempFilePath),
      fail: reject
    })
  })
}
function createCloudPath(filePath) {
  const now = new Date()
  const month = `${now.getFullYear()}-${String(now.getMonth() + 1).padStart(2, '0')}`
  const nonce = Math.random().toString(16).slice(2, 10)
  return `announcement-images/${month}/${Date.now()}-${nonce}.${getExtension(filePath)}`
}
function wait(milliseconds) { return new Promise(resolve => setTimeout(resolve, milliseconds)) }
function isRetryableNetworkError(error) {
  const message = `${String(error && error.message || '')} ${String(error && error.errMsg || '')}`
  return /ECONNRESET|ETIMEDOUT|timeout|network|uploadFile:fail undefined/i.test(message)
}
function uploadWithRetry(cloudPath, filePath, attempt = 1) {
  return wx.cloud.uploadFile({ cloudPath, filePath }).catch(error => {
    if (!isRetryableNetworkError(error) || attempt >= MAX_UPLOAD_ATTEMPTS) throw error
    return wait(attempt * 700).then(() => uploadWithRetry(cloudPath, filePath, attempt + 1))
  })
}
function upload(filePath) {
  cloudService.initialize()
  const cloudPath = createCloudPath(filePath)
  return uploadWithRetry(cloudPath, filePath).then(result => {
    if (!result || !result.fileID) throw createError('ANNOUNCEMENT_IMAGE_UPLOAD_FAILED')
    return result.fileID
  })
}
function uploadFiles(files) {
  const uploaded = []
  return files.reduce((promise, file) => promise
    .then(() => compressIfNeeded(file))
    .then(upload)
    .then(fileID => { uploaded.push(fileID) }), Promise.resolve())
    .then(() => uploaded)
    .catch(error => Promise.all(uploaded.map(deleteUploadedFile)).then(() => { throw error }))
}
function chooseAndUpload(maxCount) {
  return chooseImages(maxCount).then(uploadFiles)
}
function deleteUploadedFile(fileID) {
  if (!/^cloud:\/\//i.test(String(fileID || ''))) return Promise.resolve()
  cloudService.initialize()
  return wx.cloud.deleteFile({ fileList: [fileID] }).catch(() => {})
}

module.exports = { chooseAndUpload, deleteUploadedFile }

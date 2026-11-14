const announcementRepository = require('../repositories/announcementRepository')
const mockAnnouncements = require('../config/announcements')
const { IS_DEVELOPMENT, USE_CLOUD } = require('../config/env')

const PACKAGED_IMAGE_ALIASES = [
  {
    sourceName: '微信图片_20260819185801_9_1.png',
    assetPath: '/assets/announcement-campus-life.jpg'
  }
]

function safelyDecode(value) {
  try { return decodeURIComponent(value) } catch (error) { return value }
}
function normalizeImageUrl(value) {
  const imageUrl = String(value || '').trim()
  if (!imageUrl) return ''
  const decoded = safelyDecode(imageUrl)
  const alias = PACKAGED_IMAGE_ALIASES.find(item => decoded.includes(item.sourceName))
  if (alias) return alias.assetPath
  // 小程序无法访问管理员电脑的盘符路径、UNC 路径或 file:// 地址。
  if (/^(?:[a-z]:|\\\\|file:\/\/)/i.test(decoded)) return ''
  return imageUrl
}
function normalizeItems(items) {
  return (Array.isArray(items) ? items : []).map(item => {
    const sources = Array.isArray(item.imageUrls) && item.imageUrls.length ? item.imageUrls : [item.imageUrl]
    const imageUrls = sources.map(normalizeImageUrl).filter(Boolean)
      .filter((value, index, list) => list.indexOf(value) === index).slice(0, 9)
    return { ...item, imageUrls, imageUrl: imageUrls[0] || '', imageCount: imageUrls.length }
  })
}
function sortItems(items) {
  return items.slice().sort((left, right) => Number(right.priority || 0) - Number(left.priority || 0) || String(right.updatedAt || '').localeCompare(String(left.updatedAt || '')))
}
function getActiveAnnouncements() {
  return Promise.resolve(announcementRepository.listActive())
    .then(normalizeItems)
    .then(sortItems)
    .catch(error => {
      // 公告云函数部署前保留开发预览；正式环境不吞掉云端错误。
      if (IS_DEVELOPMENT && USE_CLOUD) return sortItems(normalizeItems(mockAnnouncements))
      throw error
    })
}
function listForManagement() { return Promise.resolve(announcementRepository.listForManagement()).then(normalizeItems).then(sortItems) }
function saveAnnouncement(data) { return announcementRepository.save(data) }
function setAnnouncementStatus(id, status) { return announcementRepository.setStatus(id, status) }
function deleteAnnouncement(id) { return announcementRepository.softDelete(id) }

module.exports = { getActiveAnnouncements, listForManagement, saveAnnouncement, setAnnouncementStatus, deleteAnnouncement }

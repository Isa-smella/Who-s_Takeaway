const cloudService = require('../services/cloudService')
const mockAnnouncements = require('../config/announcements')
const { USE_CLOUD } = require('../config/env')

const STORAGE_KEY = 'LAKES_TAKEAWAY_ANNOUNCEMENTS_V1'

function clone(value) { return JSON.parse(JSON.stringify(value)) }
function readLocal() {
  const saved = wx.getStorageSync(STORAGE_KEY)
  return Array.isArray(saved) ? saved : clone(mockAnnouncements)
}
function writeLocal(items) { wx.setStorageSync(STORAGE_KEY, items) }
function localId() { return `announcement-${Date.now()}-${Math.random().toString(16).slice(2, 10)}` }

function listActive() {
  if (USE_CLOUD) return cloudService.callFunction('listAnnouncements', { scope: 'PUBLIC' }).then(result => result.items || [])
  const now = Date.now()
  return readLocal().filter(item => item.enabled !== false && item.status !== 'DRAFT' && item.status !== 'DISABLED' && !item.deletedAt)
    .filter(item => (!item.startsAt || new Date(item.startsAt).getTime() <= now) && (!item.endsAt || new Date(item.endsAt).getTime() >= now))
}
function listForManagement() {
  if (USE_CLOUD) return cloudService.callFunction('listAnnouncements', { scope: 'MANAGEMENT' }).then(result => result.items || [])
  return Promise.resolve(readLocal().filter(item => !item.deletedAt))
}
function save(data) {
  if (USE_CLOUD) return cloudService.callFunction('manageAnnouncement', { action: 'SAVE', data })
  const items = readLocal()
  const now = new Date().toISOString()
  const index = items.findIndex(item => item.id === data.id)
  const saved = { ...(index >= 0 ? items[index] : {}), ...clone(data), id: data.id || localId(), createdAt: index >= 0 ? items[index].createdAt : now, updatedAt: now, enabled: data.status === 'PUBLISHED' }
  if (index >= 0) items[index] = saved
  else items.push(saved)
  writeLocal(items)
  return Promise.resolve(saved)
}
function setStatus(id, status) {
  if (USE_CLOUD) return cloudService.callFunction('manageAnnouncement', { action: 'SET_STATUS', announcementId: id, status })
  const items = readLocal()
  const item = items.find(entry => entry.id === id)
  if (!item) return Promise.reject(new Error('ANNOUNCEMENT_NOT_FOUND'))
  item.status = status
  item.enabled = status === 'PUBLISHED'
  item.updatedAt = new Date().toISOString()
  writeLocal(items)
  return Promise.resolve(clone(item))
}
function softDelete(id) {
  if (USE_CLOUD) return cloudService.callFunction('manageAnnouncement', { action: 'SOFT_DELETE', announcementId: id })
  const items = readLocal()
  const item = items.find(entry => entry.id === id)
  if (!item) return Promise.reject(new Error('ANNOUNCEMENT_NOT_FOUND'))
  item.status = 'DISABLED'
  item.enabled = false
  item.deletedAt = new Date().toISOString()
  item.updatedAt = item.deletedAt
  writeLocal(items)
  return Promise.resolve(clone(item))
}

module.exports = { listActive, listForManagement, save, setStatus, softDelete }

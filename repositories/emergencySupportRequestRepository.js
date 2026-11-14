const { createEmergencySupportRequest } = require('../models/index')

const STORAGE_KEY = 'LAKES_TAKEAWAY_MOCK_EMERGENCY_SUPPORT_REQUESTS_V1'

function readAll() { return wx.getStorageSync(STORAGE_KEY) || [] }
function writeAll(items) { wx.setStorageSync(STORAGE_KEY, items) }
function refreshExpired(items = readAll()) {
  const now = Date.now()
  let changed = false
  const refreshed = items.map(item => {
    if (['DRAFT', 'OPEN', 'VERIFYING'].includes(item.status) && new Date(item.expiresAt).getTime() <= now) {
      changed = true
      return { ...item, status: 'EXPIRED', updatedAt: new Date(now).toISOString() }
    }
    return item
  })
  if (changed) writeAll(refreshed)
  return refreshed
}
function list() { return refreshExpired() }
function getById(id) { return list().find(item => item.id === id) || null }
function create(data) {
  const items = list()
  const request = createEmergencySupportRequest(data)
  items.push(request)
  writeAll(items)
  return request
}
function update(id, patch) {
  const items = list()
  const index = items.findIndex(item => item.id === id)
  if (index < 0) throw new Error('SUPPORT_REQUEST_NOT_FOUND')
  items[index] = createEmergencySupportRequest({ ...items[index], ...patch, updatedAt: new Date().toISOString() })
  writeAll(items)
  return items[index]
}
function listOpen() { return list().filter(item => item.status === 'OPEN') }
function findActiveForUser(userId) { return list().find(item => item.userId === userId && ['DRAFT', 'OPEN', 'VERIFYING', 'AUTHORIZED', 'REQUIRES_ONSITE_MAINTENANCE'].includes(item.status)) || null }
// 仅供开发调试重置；正式客服请求由云端保留。
function clearForCabinet(cabinetId) { writeAll(list().filter(item => item.cabinetId !== cabinetId)) }

module.exports = { list, getById, create, update, listOpen, findActiveForUser, clearForCabinet }

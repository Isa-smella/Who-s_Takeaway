const { createEmergencyUnlockAuthorization } = require('../models/index')

const STORAGE_KEY = 'LAKES_TAKEAWAY_MOCK_UNLOCK_AUTHORIZATIONS_V1'

function readAll() { return wx.getStorageSync(STORAGE_KEY) || [] }
function writeAll(items) { wx.setStorageSync(STORAGE_KEY, items) }
function refreshExpired(items = readAll()) {
  const now = Date.now()
  let changed = false
  const refreshed = items.map(item => {
    if (item.status === 'UNUSED' && new Date(item.expiresAt).getTime() <= now) {
      changed = true
      return { ...item, status: 'EXPIRED' }
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
  const authorization = createEmergencyUnlockAuthorization(data)
  items.push(authorization)
  writeAll(items)
  return authorization
}
function update(id, patch) {
  const items = list()
  const index = items.findIndex(item => item.id === id)
  if (index < 0) throw new Error('UNLOCK_AUTHORIZATION_NOT_FOUND')
  items[index] = { ...items[index], ...patch }
  writeAll(items)
  return items[index]
}
function revokeUnusedForRecord(recordId, userId) {
  const now = new Date().toISOString()
  const items = list().map(item => item.recordId === recordId && (!userId || item.userId === userId) && item.status === 'UNUSED'
    ? { ...item, status: 'REVOKED', revokedAt: now, revokedBy: 'SYSTEM', revocationReason: 'SUPERSEDED' }
    : item)
  writeAll(items)
  return items
}
function revoke(id, { revokedBy = 'SYSTEM', reason = 'REVOKED' } = {}) {
  const authorization = getById(id)
  if (!authorization) throw new Error('UNLOCK_AUTHORIZATION_NOT_FOUND')
  if (authorization.status !== 'UNUSED') throw new Error(`UNLOCK_AUTHORIZATION_${authorization.status}`)
  return update(id, { status: 'REVOKED', revokedAt: new Date().toISOString(), revokedBy, revocationReason: reason })
}
function revokeWhere(predicate, metadata = {}) {
  const now = new Date().toISOString()
  const items = list().map(item => item.status === 'UNUSED' && predicate(item)
    ? { ...item, status: 'REVOKED', revokedAt: now, revokedBy: metadata.revokedBy || 'SYSTEM', revocationReason: metadata.reason || 'REVOKED' }
    : item)
  writeAll(items)
  return items
}
function revokeUnusedForCabinet(cabinetId, metadata) { return revokeWhere(item => item.cabinetId === cabinetId, metadata) }
function revokeUnusedForLocker(cabinetId, lockerId, metadata) { return revokeWhere(item => item.cabinetId === cabinetId && Number(item.lockerId) === Number(lockerId), metadata) }
function markUsed(id) {
  const authorization = getById(id)
  if (!authorization) throw new Error('UNLOCK_AUTHORIZATION_NOT_FOUND')
  if (authorization.status !== 'UNUSED') throw new Error(`UNLOCK_AUTHORIZATION_${authorization.status}`)
  return update(id, { status: 'USED', usedAt: new Date().toISOString() })
}
function listActiveForUser(userId) { return list().filter(item => item.userId === userId && item.status === 'UNUSED') }
// 仅供开发调试重置；正式云端仓库不提供此接口。
function clearForCabinet(cabinetId) { writeAll(list().filter(item => item.cabinetId !== cabinetId)) }

module.exports = { list, getById, create, update, revoke, revokeWhere, revokeUnusedForRecord, revokeUnusedForCabinet, revokeUnusedForLocker, markUsed, listActiveForUser, clearForCabinet }

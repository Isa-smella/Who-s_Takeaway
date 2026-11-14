const { createMaintenanceWorkOrder } = require('../models/index')

const STORAGE_KEY = 'LAKES_TAKEAWAY_MOCK_MAINTENANCE_ORDERS_V1'
const ACTIVE_STATUSES = ['PENDING', 'IN_PROGRESS', 'ONSITE', 'MANUAL_UNLOCK_COMPLETED', 'SELF_CHECK_PASSED']

function list() { return wx.getStorageSync(STORAGE_KEY) || [] }
function write(items) { wx.setStorageSync(STORAGE_KEY, items) }
function getById(id) { return list().find(item => item.id === id) || null }
function save(data) {
  const items = list()
  const index = items.findIndex(item => item.id === data.id)
  const now = new Date().toISOString()
  const order = createMaintenanceWorkOrder({ ...(index >= 0 ? items[index] : {}), ...data, updatedAt: now })
  if (index >= 0) items[index] = order
  else items.push(order)
  write(items)
  return order
}
function findActiveForTarget(cabinetId, lockerId = null) {
  return list().find(item => item.cabinetId === cabinetId && Number(item.lockerId || 0) === Number(lockerId || 0) && ACTIVE_STATUSES.includes(item.status)) || null
}
// 仅供开发调试重置；正式维修工单不可由客户端删除。
function clearForCabinet(cabinetId) { write(list().filter(item => item.cabinetId !== cabinetId)) }

module.exports = { ACTIVE_STATUSES, list, getById, save, findActiveForTarget, clearForCabinet }

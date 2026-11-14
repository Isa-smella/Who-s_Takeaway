const { createUnlockIssue } = require('../models/index')

const STORAGE_KEY = 'LAKES_TAKEAWAY_MOCK_UNLOCK_ISSUES_V1'

function list() { return wx.getStorageSync(STORAGE_KEY) || [] }
function write(items) { wx.setStorageSync(STORAGE_KEY, items) }
function getByRecordId(recordId) { return list().find(item => item.recordId === recordId) || null }
function getByCabinet(cabinetId) { return list().filter(item => item.cabinetId === cabinetId) }
function save(data) {
  const items = list()
  const index = items.findIndex(item => item.recordId === data.recordId)
  const now = new Date().toISOString()
  const issue = createUnlockIssue({ ...(index >= 0 ? items[index] : {}), ...data, id: data.id || (index >= 0 ? items[index].id : `unlock-issue-${Date.now()}-${Math.floor(Math.random() * 100000)}`), createdAt: index >= 0 ? items[index].createdAt : now, updatedAt: now })
  if (index >= 0) items[index] = issue
  else items.push(issue)
  write(items)
  return issue
}
// 仅供开发调试重置；正式故障记录不可由客户端删除。
function clearForCabinet(cabinetId) { write(list().filter(item => item.cabinetId !== cabinetId)) }

module.exports = { list, getByRecordId, getByCabinet, save, clearForCabinet }

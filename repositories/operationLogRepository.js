const { createOperationLog } = require('../models/index')
const STORAGE_KEY = 'LAKES_TAKEAWAY_MOCK_CLOUD_OPERATION_LOGS_V1'

function append(data) {
  const logs = wx.getStorageSync(STORAGE_KEY) || []
  const log = createOperationLog(data)
  logs.push(log)
  wx.setStorageSync(STORAGE_KEY, logs)
  return log
}
function query(filters = {}) {
  const registrationUsers = { '00001': 'mock-user', '00002': 'mock-admin', '00003': 'mock-customer-service', '00004': 'mock-developer' }
  const resolvedUserId = filters.userId || (filters.registrationNumber && registrationUsers[String(filters.registrationNumber).trim()]) || (filters.registrationNumber ? '__USER_NOT_FOUND__' : '')
  return (wx.getStorageSync(STORAGE_KEY) || []).filter(item =>
    (!resolvedUserId || item.userId === resolvedUserId) &&
    (!filters.cabinetId || item.cabinetId === filters.cabinetId) &&
    (!filters.lockerId || item.lockerId === Number(filters.lockerId)) &&
    (!filters.recordId || item.recordId === filters.recordId) &&
    (!filters.action || item.action === filters.action) &&
    (!filters.result || item.result === filters.result) &&
    (!filters.startAt || item.createdAt >= filters.startAt) &&
    (!filters.endAt || item.createdAt <= filters.endAt)
  )
}

// 故意不提供 update/delete：Mock 阶段也保持审计日志不可修改、不可删除。
module.exports = { append, query }

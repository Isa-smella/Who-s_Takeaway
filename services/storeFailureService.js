const cloudService = require('./cloudService')
const cabinetRepository = require('../repositories/cabinetRepository')
const { USE_CLOUD } = require('../config/env')

const STORAGE_KEY = 'LAKES_TAKEAWAY_STORE_CONFIRM_FAILURES_V1'

function report(cabinetId, lockerId, failureCode) {
  if (USE_CLOUD) {
    return cloudService.callFunction('reportStoreDepositFailure', { cabinetId, lockerId: Number(lockerId), failureCode }).then(result => {
      if (result && result.locker) {
        try { cabinetRepository.applyCloudLockerSnapshot(cabinetId, result.locker) } catch (error) {}
      }
      return result.issue
    })
  }
  const key = `${cabinetId}:${Number(lockerId)}`
  const counts = wx.getStorageSync(STORAGE_KEY) || {}
  counts[key] = Number(counts[key] || 0) + 1
  wx.setStorageSync(STORAGE_KEY, counts)
  // 确认存入失败不是一次实体 @OPEN 失败，不进入柜格硬件连续失败计数，
  // 也不单独触发维修；实体开锁失败统一由 unlockIssueService 处理。
  return Promise.resolve({ failedAttempts: counts[key], status: 'NORMAL_RETRY' })
}

function clear(cabinetId, lockerId) {
  if (USE_CLOUD) return
  const key = `${cabinetId}:${Number(lockerId)}`
  const counts = wx.getStorageSync(STORAGE_KEY) || {}
  delete counts[key]
  wx.setStorageSync(STORAGE_KEY, counts)
}

module.exports = { report, clear }

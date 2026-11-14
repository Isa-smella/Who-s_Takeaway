const { createPrivacyConsent } = require('../models/index')
const STORAGE_KEY = 'LAKES_TAKEAWAY_MOCK_PRIVACY_CONSENTS_V1'

function getByUserId(userId) {
  const records = wx.getStorageSync(STORAGE_KEY) || []
  return records.find(item => item.userId === userId) || null
}
function save(data) {
  const records = wx.getStorageSync(STORAGE_KEY) || []
  const consent = createPrivacyConsent(data)
  const index = records.findIndex(item => item.userId === consent.userId)
  if (index >= 0) records[index] = consent
  else records.push(consent)
  wx.setStorageSync(STORAGE_KEY, records)
  return consent
}
function clearByUserId(userId) {
  const records = wx.getStorageSync(STORAGE_KEY) || []
  wx.setStorageSync(STORAGE_KEY, records.filter(item => item.userId !== userId))
}

module.exports = { getByUserId, save, clearByUserId }

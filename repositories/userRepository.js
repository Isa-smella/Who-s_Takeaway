const { createUser } = require('../models/index')
const STORAGE_KEY = 'LAKES_TAKEAWAY_MOCK_USER_V1'

function getCurrentUser() { return wx.getStorageSync(STORAGE_KEY) || null }
function saveCurrentUser(data) {
  const user = createUser(data)
  wx.setStorageSync(STORAGE_KEY, user)
  return user
}
function clearCurrentUser() { wx.removeStorageSync(STORAGE_KEY) }

module.exports = { getCurrentUser, saveCurrentUser, clearCurrentUser }

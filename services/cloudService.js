const { USE_CLOUD, CLOUD_ENV_ID } = require('../config/env')

let initialized = false

function initialize() {
  if (!USE_CLOUD) return false
  if (!wx.cloud) throw new Error('WECHAT_CLOUD_NOT_AVAILABLE')
  if (!initialized) {
    const options = { traceUser: true }
    if (CLOUD_ENV_ID) options.env = CLOUD_ENV_ID
    wx.cloud.init(options)
    initialized = true
  }
  return true
}

function callFunction(name, data = {}) {
  if (!USE_CLOUD) return Promise.reject(new Error('CLOUD_BACKEND_DISABLED'))
  initialize()
  return wx.cloud.callFunction({ name, data }).then(response => {
    const result = response && response.result
    if (!result || result.ok !== true) {
      const error = new Error((result && result.error && result.error.code) || 'CLOUD_FUNCTION_FAILED')
      error.cloudDetail = result && result.error
      throw error
    }
    return result.data
  })
}

function isEnabled() { return USE_CLOUD }

module.exports = { initialize, callFunction, isEnabled }

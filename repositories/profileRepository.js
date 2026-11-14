const cloudService = require('../services/cloudService')
const userRepository = require('./userRepository')
const { USE_CLOUD } = require('../config/env')

function updateMyProfile(data) {
  if (USE_CLOUD) return cloudService.callFunction('updateMyProfile', data)
  if (!userRepository.getCurrentUser()) return Promise.reject(new Error('LOGIN_REQUIRED'))
  return Promise.reject(new Error('REGISTRATION_NAME_IMMUTABLE'))
}

module.exports = { updateMyProfile }

const userRepository = require('../repositories/userRepository')
const eventBus = require('./eventBus')
const { MOCK_AUTO_LOGIN, USE_CLOUD } = require('../config/env')
const cloudService = require('./cloudService')
const privacyConsentRepository = require('../repositories/privacyConsentRepository')
const { USER_ROLE } = require('../constants/status')

let currentUser = null
const MOCK_ROLE_SEQUENCES = {
  [USER_ROLE.USER]: 1,
  [USER_ROLE.ADMIN]: 2,
  [USER_ROLE.CUSTOMER_SERVICE]: 3,
  [USER_ROLE.DEVELOPER]: 4
}

function initialize() {
  if (USE_CLOUD) {
    // A locally cached role is never authoritative in cloud mode.
    userRepository.clearCurrentUser()
    currentUser = null
    return null
  }
  currentUser = userRepository.getCurrentUser()
  if (currentUser && currentUser.role) {
    const storedRole = String(currentUser.role).toUpperCase()
    currentUser.role = ['CUSTOMER', 'RIDER'].includes(storedRole) ? USER_ROLE.USER : storedRole
    const registrationSequence = MOCK_ROLE_SEQUENCES[currentUser.role] || 1
    if (currentUser.role !== storedRole || !currentUser.registrationNumber) {
      currentUser = userRepository.saveCurrentUser({ ...currentUser, registrationSequence, registrationNumber: String(registrationSequence).padStart(5, '0') })
    }
  }
  if (!currentUser && MOCK_AUTO_LOGIN && !USE_CLOUD) {
    currentUser = userRepository.saveCurrentUser({ id: 'mock-developer', openid: 'mock-openid', role: USER_ROLE.DEVELOPER, registrationSequence: 4, registrationNumber: '00004' })
  }
  return currentUser
}
function login() {
  if (!USE_CLOUD) return loginMock(USER_ROLE.DEVELOPER)
  return cloudService.callFunction('login').then(result => {
    if (!result || !result.user || !result.user.id || !result.user.role) throw new Error('CLOUD_LOGIN_RESPONSE_INVALID')
    currentUser = userRepository.saveCurrentUser(result.user)
    privacyConsentRepository.clearByUserId(currentUser.id)
    if (result.privacyConsent) privacyConsentRepository.save(result.privacyConsent)
    eventBus.emit('auth:changed', currentUser)
    return currentUser
  })
}
function loginMock(role = USER_ROLE.DEVELOPER) {
  if (USE_CLOUD) return Promise.reject(new Error('MOCK_LOGIN_DISABLED'))
  const requestedRole = String(role || USER_ROLE.USER).toUpperCase()
  const normalizedRole = ['CUSTOMER', 'RIDER'].includes(requestedRole) ? USER_ROLE.USER : requestedRole
  const roleIds = {
    [USER_ROLE.USER]: 'mock-user',
    [USER_ROLE.ADMIN]: 'mock-admin',
    [USER_ROLE.CUSTOMER_SERVICE]: 'mock-customer-service',
    [USER_ROLE.DEVELOPER]: 'mock-developer'
  }
  const registrationSequence = MOCK_ROLE_SEQUENCES[normalizedRole] || 1
  currentUser = userRepository.saveCurrentUser({
    id: roleIds[normalizedRole] || 'mock-user',
    openid: `mock-openid-${normalizedRole.toLowerCase()}`,
    role: normalizedRole,
    registrationSequence,
    registrationNumber: String(registrationSequence).padStart(5, '0')
  })
  eventBus.emit('auth:changed', currentUser)
  return Promise.resolve(currentUser)
}
function logout() {
  const previous = currentUser
  userRepository.clearCurrentUser()
  currentUser = null
  eventBus.emit('auth:changed', null)
  return previous
}
function isLoggedIn() { return Boolean(currentUser && currentUser.id) }
function getCurrentUser() { return currentUser }
function updateCurrentUser(data = {}) {
  if (!currentUser || !currentUser.id) throw new Error('LOGIN_REQUIRED')
  currentUser = userRepository.saveCurrentUser({
    ...currentUser,
    ...data,
    id: currentUser.id,
    openid: currentUser.openid,
    role: currentUser.role,
    registrationSequence: currentUser.registrationSequence,
    registrationNumber: currentUser.registrationNumber,
    nickname: currentUser.registrationNumber || currentUser.nickname
  })
  eventBus.emit('auth:changed', currentUser)
  return currentUser
}
function subscribe(callback) { return eventBus.on('auth:changed', callback) }

module.exports = { initialize, login, loginMock, logout, isLoggedIn, getCurrentUser, updateCurrentUser, subscribe }

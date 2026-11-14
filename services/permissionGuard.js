const authService = require('./authService')
const privacyService = require('./privacyService')
const { USER_ROLE } = require('../constants/status')

const CORE_ROLES = Object.freeze(Object.values(USER_ROLE))
const STORE_ROLES = Object.freeze([USER_ROLE.USER, USER_ROLE.ADMIN, USER_ROLE.DEVELOPER])
const PICKUP_ROLES = Object.freeze([USER_ROLE.USER, USER_ROLE.ADMIN, USER_ROLE.DEVELOPER])
// 允许手机进入实体柜业务并建立 BLE 的角色。纯客服只能在后台核验和签发授权。
const CABINET_ACCESS_ROLES = Object.freeze([USER_ROLE.USER, USER_ROLE.ADMIN, USER_ROLE.DEVELOPER])
// 管理员是“客服 plus”：所有客服能力统一从此集合授权，避免新增客服功能时遗漏管理员。
const CUSTOMER_SERVICE_ROLES = Object.freeze([USER_ROLE.CUSTOMER_SERVICE, USER_ROLE.ADMIN, USER_ROLE.DEVELOPER])
const LOG_VIEW_ROLES = CUSTOMER_SERVICE_ROLES
const MANAGEMENT_ROLES = Object.freeze([USER_ROLE.ADMIN, USER_ROLE.DEVELOPER])
const EMERGENCY_UNLOCK_ROLES = CUSTOMER_SERVICE_ROLES

function guardError(code) { const error = new Error(code); error.code = code; return error }
function navigateGuard(url) {
  setTimeout(() => {
    const pages = typeof getCurrentPages === 'function' ? getCurrentPages() : []
    const currentRoute = pages.length ? pages[pages.length - 1].route : ''
    // 替换未授权页面，避免用户从登录/协议页返回到被隐藏的白屏页面。
    if (currentRoute !== url.replace(/^\//, '')) wx.redirectTo({ url })
  }, 0)
}
function requireLogin(options = {}) {
  if (authService.isLoggedIn()) return Promise.resolve(authService.getCurrentUser())
  if (options.redirect !== false) navigateGuard('/pages/login/login')
  return Promise.reject(guardError('AUTH_REQUIRED'))
}
function requirePrivacyConsent(options = {}) {
  const user = authService.getCurrentUser()
  if (user && privacyService.hasCurrentConsent(user.id)) return Promise.resolve(true)
  if (options.redirect !== false) navigateGuard('/pages/privacy-consent/privacy-consent')
  return Promise.reject(guardError('PRIVACY_CONSENT_REQUIRED'))
}
function requireRole(roles, options = {}) {
  const user = authService.getCurrentUser()
  const allowed = Array.isArray(roles) ? roles : [roles]
  if (user && allowed.includes(user.role)) return Promise.resolve(user)
  if (options.showMessage !== false) wx.showToast({ title: '当前账号没有此操作权限', icon: 'none' })
  return Promise.reject(guardError('ROLE_FORBIDDEN'))
}
function requireAccess({ roles = CORE_ROLES } = {}) {
  return requireLogin().then(() => requirePrivacyConsent()).then(() => requireRole(roles))
}
function assertCoreAccess() {
  const user = authService.getCurrentUser()
  if (!user) throw guardError('AUTH_REQUIRED')
  if (!privacyService.hasCurrentConsent(user.id)) throw guardError('PRIVACY_CONSENT_REQUIRED')
  return user
}
function assertRole(roles) {
  const user = assertCoreAccess()
  const allowed = Array.isArray(roles) ? roles : [roles]
  if (!allowed.includes(user.role)) throw guardError('ROLE_FORBIDDEN')
  return user
}

module.exports = { requireLogin, requirePrivacyConsent, requireRole, requireAccess, assertCoreAccess, assertRole, CORE_ROLES, STORE_ROLES, PICKUP_ROLES, CABINET_ACCESS_ROLES, CUSTOMER_SERVICE_ROLES, LOG_VIEW_ROLES, MANAGEMENT_ROLES, EMERGENCY_UNLOCK_ROLES }

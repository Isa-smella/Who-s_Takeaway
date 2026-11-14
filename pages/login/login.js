const authService = require('../../services/authService')
const privacyService = require('../../services/privacyService')
const operationLogService = require('../../services/operationLogService')
const ACTIONS = require('../../constants/operationActions')
const { USER_ROLE } = require('../../constants/status')
const { USE_CLOUD } = require('../../config/env')

Page({
  data: {
    roleOptions: [USER_ROLE.USER, USER_ROLE.ADMIN, USER_ROLE.CUSTOMER_SERVICE, USER_ROLE.DEVELOPER],
    roleLabels: ['用户 USER', '管理员 ADMIN', '客服 CUSTOMER_SERVICE', '开发者 DEVELOPER'],
    roleIndex: 3,
    loggingIn: false,
    useCloud: USE_CLOUD
  },
  chooseRole(event) { this.setData({ roleIndex: Number(event.detail.value) }) },
  login() {
    if (this.data.loggingIn) return
    this.setData({ loggingIn: true })
    const loginPromise = this.data.useCloud
      ? authService.login()
      : authService.loginMock(this.data.roleOptions[this.data.roleIndex])
    loginPromise.then(user => {
      getApp().globalData.currentUser = user
      operationLogService.log(ACTIONS.LOGIN_SUCCESS)
      if (!privacyService.hasCurrentConsent(user.id)) {
        wx.redirectTo({ url: '/pages/privacy-consent/privacy-consent' })
        return
      }
      getApp().resumePendingCabinet().then(() => wx.reLaunch({ url: '/pages/home/home' }))
    }).catch(error => {
      operationLogService.log(ACTIONS.LOGIN_FAILED, { result: 'FAILED', detail: { reason: error.message } })
      this.setData({ loggingIn: false })
      wx.showToast({ title: '登录失败', icon: 'none' })
    })
  }
})

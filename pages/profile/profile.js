const depositRepository = require('../../repositories/depositRepository')
const cabinetScanService = require('../../services/cabinetScanService')
const permissionGuard = require('../../services/permissionGuard')
const authService = require('../../services/authService')
const bluetoothService = require('../../services/bluetoothService')
const cabinetSessionService = require('../../services/cabinetSessionService')
const operationLogService = require('../../services/operationLogService')
const ACTIONS = require('../../constants/operationActions')
const { USER_ROLE } = require('../../constants/status')
const { LEGAL_DOCUMENTS, CONTACT_INFO } = require('../../config/publicInfo')

Page({
  data: { pickupCount: 0, totalCount: 0, unlockAuthorizationCount: 0, authorized: false, userName: '', roleLabel: '', canManage: false, canHandleFeedback: false },
  onLoad() {
    permissionGuard.requireAccess().then(() => {
      this.setData({ authorized: true })
      this.applyUser()
      this.loadSummary()
    }).catch(() => {})
  },
  onShow() {
    if (!this.data.authorized) return
    this.applyUser()
    this.loadSummary()
  },
  applyUser() {
    const user = authService.getCurrentUser()
    if (!user) return
    this.setData({
      userName: user.registrationNumber || user.nickname || user.id,
      roleLabel: user.role,
      canManage: permissionGuard.MANAGEMENT_ROLES.includes(user.role),
      canHandleFeedback: permissionGuard.CUSTOMER_SERVICE_ROLES.includes(user.role)
    })
  },
  loadSummary() {
    const user = authService.getCurrentUser()
    const depositRecords = depositRepository.getDepositRecordsForUser(user.id)
    const pickupRecords = depositRepository.getPickupRecordsForUser(user.id)
    let authorizationRecords = []
    try { authorizationRecords = require('../../services/unlockAuthorizationService').getActiveForCurrentUser() } catch (error) {}
    Promise.all([Promise.resolve(depositRecords), Promise.resolve(pickupRecords), Promise.resolve(authorizationRecords)]).then(([deposits, pickups, authorizations]) => {
      this.setData({ totalCount: deposits.length, pickupCount: pickups.length, unlockAuthorizationCount: authorizations.length })
    }).catch(() => wx.showToast({ title: '个人记录加载失败', icon: 'none' }))
  },
  goDepositRecords() { wx.navigateTo({ url: '/pages/deposit-records/deposit-records' }) },
  goPickupRecords() { wx.navigateTo({ url: '/pages/pickup-records/pickup-records' }) },
  goMyFeedback() { wx.navigateTo({ url: '/pages/my-feedback/my-feedback' }) },
  goUnlockAuthorizations() { wx.navigateTo({ url: '/pages/unlock-authorizations/unlock-authorizations' }) },
  goManagement() { wx.navigateTo({ url: '/pages/management/management' }) },
  goFeedbackManagement() { wx.navigateTo({ url: '/pages/feedback-management/feedback-management' }) },
  goHome() { wx.reLaunch({ url: '/pages/home/home' }) },
  scanCabinet() {
    const user = authService.getCurrentUser()
    if (user && user.role === USER_ROLE.CUSTOMER_SERVICE) {
      return cabinetScanService.scanCabinetId()
        .then(cabinetId => {
          wx.navigateTo({ url: `/pages/support-cabinet/support-cabinet?cabinetId=${encodeURIComponent(cabinetId)}` })
        })
        .catch(error => {
          if (String(error.errMsg || '').includes('cancel')) return
          wx.showToast({ title: cabinetScanService.getCabinetErrorMessage(error), icon: 'none' })
        })
    }
    cabinetScanService.scanAndSwitchCabinet()
      .then(cabinetId => {
        wx.showToast({ title: `已连接 ${cabinetId}`, icon: 'success' })
        setTimeout(() => wx.reLaunch({ url: '/pages/home/home' }), 500)
      })
      .catch(error => {
        if (String(error.errMsg || '').includes('cancel')) return
        if (!getApp().showCabinetUnavailable(error, error.cabinetId || '')) wx.showToast({ title: cabinetScanService.getCabinetErrorMessage(error), icon: 'none' })
      })
  },
  cooperationContact() {
    wx.showModal({
      title: CONTACT_INFO.cooperationTitle,
      content: CONTACT_INFO.cooperationContent,
      showCancel: false,
      confirmText: '复制QQ',
      success: result => {
        if (result.confirm) wx.setClipboardData({ data: CONTACT_INFO.cooperationQQ })
      }
    })
  },
  showAccount() {
    const user = authService.getCurrentUser()
    wx.showModal({ title: '账号信息', content: `注册编号：${user.registrationNumber || user.nickname || '未分配'}\n用户ID：${user.id}\n角色：${user.role}`, showCancel: false })
  },
  showAgreement() { wx.showModal({ title: LEGAL_DOCUMENTS.agreement.title, content: LEGAL_DOCUMENTS.agreement.content, showCancel: false }) },
  showPrivacy() { wx.showModal({ title: LEGAL_DOCUMENTS.privacy.title, content: LEGAL_DOCUMENTS.privacy.content, showCancel: false }) },
  logout() {
    operationLogService.log(ACTIONS.LOGOUT)
    authService.logout()
    cabinetSessionService.clearPendingCabinetId()
    bluetoothService.disconnectController()
    getApp().globalData.currentUser = null
    getApp().globalData.currentCabinetId = null
    getApp().globalData.currentCabinet = null
    // 退出后直接清空页面栈并进入登录页，首页不能作为未登录返回页残留。
    wx.reLaunch({ url: '/pages/login/login' })
  },
  contactService() { wx.navigateTo({ url: '/pages/customer-service/customer-service' }) }
})

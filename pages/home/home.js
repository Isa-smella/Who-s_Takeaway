const bluetoothService = require('../../services/bluetoothService')
const cabinetScanService = require('../../services/cabinetScanService')
const cabinetRepository = require('../../repositories/cabinetRepository')
const permissionGuard = require('../../services/permissionGuard')
const authService = require('../../services/authService')
const { USER_ROLE } = require('../../constants/status')
const { IS_DEVELOPMENT } = require('../../config/env')
const unlockAuthorizationService = require('../../services/unlockAuthorizationService')
const announcementService = require('../../services/announcementService')

const statusText = { DISCONNECTED: '蓝牙未连接', CONNECTING: '正在连接柜体...', CONNECTED: '蓝牙已连接', ERROR: '蓝牙连接异常' }
Page({
  data: {
    authorized: false,
    cabinetId: '', hasCabinet: false, bluetoothStatus: 'DISCONNECTED', bluetoothText: '请扫描柜体二维码',
    isDevelopment: IS_DEVELOPMENT, canStore: false, canPickup: false, canDebug: false, roleText: '', unlockAuthorizationCount: 0,
    announcementItems: []
  },
  onLoad(options) {
    permissionGuard.requireAccess().then(() => {
      this.setData({ authorized: true })
      this.initializeHome(options)
    }).catch(() => {})
  },
  initializeHome(options) {
    const app = getApp()
    this.applyRole()
    const cabinetId = app.resolveCabinetId({ query: options }) || app.globalData.currentCabinetId
    this.setData({ cabinetId: cabinetId || '', hasCabinet: Boolean(cabinetId) })
    this.unsubscribeBluetooth = bluetoothService.subscribeConnectionStatus(state => {
      if (state.cabinetId === this.data.cabinetId || !state.cabinetId) this.applyStatus(state.status)
    })
    this.unsubscribeCabinet = app.subscribeCurrentCabinet(({ cabinetId: nextCabinetId }) => {
      this.setData({ cabinetId: nextCabinetId || '', hasCabinet: Boolean(nextCabinetId) })
      this.applyStatus(nextCabinetId ? bluetoothService.getConnectionStatus(nextCabinetId) : 'DISCONNECTED')
    })
    if (cabinetId && cabinetId !== app.globalData.currentCabinetId) app.switchCabinet(cabinetId).catch(() => this.applyStatus('ERROR'))
    if (cabinetId) this.applyStatus(bluetoothService.getConnectionStatus(cabinetId))
    this.refreshUnlockAuthorizations()
    this.refreshAnnouncements()
  },
  onShow() {
    if (!this.data.authorized) return
    this.applyRole()
    const cabinetId = getApp().globalData.currentCabinetId
    this.setData({ cabinetId: cabinetId || '', hasCabinet: Boolean(cabinetId) })
    if (cabinetId) this.applyStatus(bluetoothService.getConnectionStatus(cabinetId))
    this.refreshUnlockAuthorizations()
    this.refreshAnnouncements()
  },
  onUnload() {
    if (this.unsubscribeBluetooth) this.unsubscribeBluetooth()
    if (this.unsubscribeCabinet) this.unsubscribeCabinet()
  },
  applyStatus(status) { this.setData({ bluetoothStatus: status, bluetoothText: statusText[status] }) },
  refreshUnlockAuthorizations() {
    try {
      Promise.resolve(unlockAuthorizationService.getActiveForCurrentUser())
        .then(items => this.setData({ unlockAuthorizationCount: Array.isArray(items) ? items.length : 0 }))
        .catch(() => this.setData({ unlockAuthorizationCount: 0 }))
    } catch (error) { this.setData({ unlockAuthorizationCount: 0 }) }
  },
  refreshAnnouncements() {
    announcementService.getActiveAnnouncements()
      .then(items => this.setData({ announcementItems: Array.isArray(items) ? items : [] }))
      .catch(() => this.setData({ announcementItems: [] }))
  },
  openAnnouncement(event) {
    const item = this.data.announcementItems[Number(event.currentTarget.dataset.index)]
    if (!item) return
    if (item.targetUrl && item.targetUrl.startsWith('/pages/')) {
      wx.navigateTo({ url: item.targetUrl })
      return
    }
    wx.showModal({ title: item.title || item.label || '公告', content: item.content || item.summary || '', showCancel: false })
  },
  previewAnnouncementImages(event) {
    const item = this.data.announcementItems[Number(event.currentTarget.dataset.index)]
    if (!item || !Array.isArray(item.imageUrls) || !item.imageUrls.length) return
    wx.previewImage({ current: item.imageUrls[0], urls: item.imageUrls })
  },
  goUnlockAuthorizations() { wx.navigateTo({ url: '/pages/unlock-authorizations/unlock-authorizations' }) },
  applyRole() {
    const user = authService.getCurrentUser()
    const role = user ? user.role : ''
    const roleLabels = { USER: '用户', ADMIN: '管理员', CUSTOMER_SERVICE: '客服', DEVELOPER: '开发者' }
    this.setData({
      canStore: permissionGuard.STORE_ROLES.includes(role),
      canPickup: permissionGuard.PICKUP_ROLES.includes(role),
      canDebug: IS_DEVELOPMENT && role === USER_ROLE.DEVELOPER,
      roleText: roleLabels[role] || ''
    })
  },
  reconnect() {
    if (!this.data.hasCabinet) return this.requireCabinet()
    getApp().switchCabinet(this.data.cabinetId).catch(() => this.applyStatus('ERROR'))
  },
  goStore() {
    if (!this.data.hasCabinet) return this.requireCabinet()
    if (!bluetoothService.isConnectedTo(this.data.cabinetId)) return this.requireBluetoothConnection()
    if (!this.ensureCabinetAvailable()) return
    permissionGuard.requireAccess({ roles: permissionGuard.STORE_ROLES }).then(() => {
      wx.navigateTo({ url: `/pages/lockers/lockers?mode=store&cabinetId=${encodeURIComponent(this.data.cabinetId)}` })
    }).catch(() => {})
  },
  goPickup() {
    if (!this.data.hasCabinet) return this.requireCabinet()
    if (!bluetoothService.isConnectedTo(this.data.cabinetId)) return this.requireBluetoothConnection()
    if (!this.ensureCabinetAvailable()) return
    permissionGuard.requireAccess({ roles: permissionGuard.PICKUP_ROLES }).then(() => {
      wx.navigateTo({ url: `/pages/lockers/lockers?mode=pickup&cabinetId=${encodeURIComponent(this.data.cabinetId)}` })
    }).catch(() => {})
  },
  requireCabinet() { wx.showToast({ title: '请先扫描柜体二维码', icon: 'none' }) },
  requireBluetoothConnection() { wx.showToast({ title: '请等待柜体蓝牙连接成功', icon: 'none' }) },
  ensureCabinetAvailable() {
    try {
      const cabinet = cabinetRepository.getCabinet(this.data.cabinetId)
      if (cabinet.status === 'ACTIVE') return true
      const error = new Error(cabinet.status === 'DISABLED' ? 'CABINET_DISABLED' : 'CABINET_MAINTENANCE')
      getApp().deactivateCurrentCabinet(this.data.cabinetId)
      getApp().showCabinetUnavailable(error, this.data.cabinetId)
      return false
    } catch (error) {
      getApp().showCabinetUnavailable(error, this.data.cabinetId)
      return false
    }
  },
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
      .then(cabinetId => wx.showToast({ title: `已连接 ${cabinetId}`, icon: 'success' }))
      .catch(error => {
        if (String(error.errMsg || '').includes('cancel')) return
        if (!getApp().showCabinetUnavailable(error, error.cabinetId || this.data.cabinetId)) wx.showToast({ title: cabinetScanService.getCabinetErrorMessage(error), icon: 'none' })
      })
  },
  goHome() { wx.pageScrollTo({ scrollTop: 0, duration: 200 }) },
  goProfile() { permissionGuard.requireAccess().then(() => wx.navigateTo({ url: '/pages/profile/profile' })).catch(() => {}) },
  goDebug() { wx.navigateTo({ url: '/pages/debug/debug' }) },
  contactService() {
    const query = this.data.cabinetId ? `?cabinetId=${encodeURIComponent(this.data.cabinetId)}` : ''
    permissionGuard.requireLogin().then(() => {
      wx.navigateTo({ url: `/pages/customer-service/customer-service${query}` })
    }).catch(() => {})
  }
})

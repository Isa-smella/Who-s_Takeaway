const permissionGuard = require('../../services/permissionGuard')
const unlockAuthorizationService = require('../../services/unlockAuthorizationService')
const unlockExecutionService = require('../../services/unlockExecutionService')
const bluetoothService = require('../../services/bluetoothService')
const cabinetScanService = require('../../services/cabinetScanService')

Page({
  data: { authorized: false, authorizations: [], executingId: '', scanningId: '', currentCabinetId: '' },
  onLoad() {
    permissionGuard.requireAccess({ roles: permissionGuard.PICKUP_ROLES }).then(() => {
      this.setData({ authorized: true })
      this.loadAuthorizations()
    }).catch(() => {})
  },
  onShow() {
    if (!this.data.authorized) return
    this.loadAuthorizations()
    this.startCountdown()
  },
  onHide() { this.stopCountdown() },
  onUnload() { this.stopCountdown() },
  startCountdown() {
    this.stopCountdown()
    this.countdownTimer = setInterval(() => this.refreshCountdown(), 1000)
  },
  stopCountdown() { if (this.countdownTimer) { clearInterval(this.countdownTimer); this.countdownTimer = null } },
  formatRemaining(expiresAt, now = Date.now()) {
    const seconds = Math.max(0, Math.ceil((new Date(expiresAt).getTime() - now) / 1000))
    return `${String(Math.floor(seconds / 60)).padStart(2, '0')}:${String(seconds % 60).padStart(2, '0')}`
  },
  refreshCountdown() {
    const now = Date.now()
    if (this.data.authorizations.some(item => new Date(item.expiresAt).getTime() <= now)) return this.loadAuthorizations()
    this.setData({ authorizations: this.data.authorizations.map(item => ({ ...item, remainingText: this.formatRemaining(item.expiresAt, now) })) })
  },
  loadAuthorizations() {
    let request
    try {
      const now = Date.now()
      const currentCabinetId = getApp().globalData.currentCabinetId || ''
      request = unlockAuthorizationService.getActiveForCurrentUser()
      Promise.resolve(request).then(items => {
      const authorizations = items.map(item => ({
        ...item,
        lockerNumber: String(item.lockerId).padStart(2, '0'),
        remainingText: this.formatRemaining(item.expiresAt, now),
        isTargetCabinet: currentCabinetId === item.cabinetId,
        bluetoothConnected: bluetoothService.isConnectedTo(item.cabinetId)
      }))
      this.setData({ authorizations, currentCabinetId })
      }).catch(() => this.setData({ authorizations: [], currentCabinetId: '' }))
    } catch (error) { this.setData({ authorizations: [], currentCabinetId: '' }) }
  },
  scanTargetCabinet(event) {
    if (this.data.scanningId || this.data.executingId) return
    const authorization = this.data.authorizations.find(item => item.id === event.currentTarget.dataset.id)
    if (!authorization) return
    this.setData({ scanningId: authorization.id })
    cabinetScanService.scanCabinetId().then(cabinetId => {
      if (cabinetId !== authorization.cabinetId) throw new Error('UNLOCK_AUTHORIZATION_CABINET_MISMATCH')
      return getApp().handleScannedCabinet(cabinetId)
    }).then(() => {
      this.setData({ scanningId: '' })
      this.loadAuthorizations()
      wx.showToast({ title: '目标柜体已连接', icon: 'success' })
    }).catch(error => {
      this.setData({ scanningId: '' })
      if (String(error.errMsg || '').includes('cancel')) return
      wx.showToast({ title: error.message === 'UNLOCK_AUTHORIZATION_CABINET_MISMATCH' ? `请扫描 ${authorization.cabinetId}` : cabinetScanService.getCabinetErrorMessage(error), icon: 'none' })
    })
  },
  abandonAuthorization(event) {
    if (this.data.executingId || this.data.scanningId) return
    const authorizationId = event.currentTarget.dataset.id
    wx.showModal({
      title: '放弃此次开锁授权',
      content: '放弃后该授权立即失效；如仍需开锁，需要重新联系客服核验。',
      confirmText: '确认放弃', confirmColor: '#C03338',
      success: result => {
        if (!result.confirm) return
        let request
        try { request = unlockAuthorizationService.revokeByCurrentUser(authorizationId) } catch (error) { request = Promise.reject(error) }
        Promise.resolve(request).then(() => { this.loadAuthorizations(); wx.showToast({ title: '授权已放弃', icon: 'success' }) })
          .catch(() => { wx.showToast({ title: '授权已失效', icon: 'none' }); this.loadAuthorizations() })
      }
    })
  },
  execute(event) {
    if (this.data.executingId) return
    const authorizationId = event.currentTarget.dataset.id
    const authorization = this.data.authorizations.find(item => item.id === authorizationId)
    if (!authorization) return
    const currentCabinetId = getApp().globalData.currentCabinetId
    if (currentCabinetId !== authorization.cabinetId) {
      return wx.showModal({ title: '柜体不匹配', content: `请先扫描 ${authorization.cabinetId} 柜体二维码，再使用此授权。`, showCancel: false })
    }
    const run = () => {
      this.setData({ executingId: authorizationId })
      unlockExecutionService.executeAuthorization({ authorizationId, currentCabinetId })
        .then(result => {
          this.setData({ executingId: '' })
          this.loadAuthorizations()
          wx.showModal({ title: '开锁成功', content: `${authorization.lockerNumber}号柜已打开，已记录为取餐成功。`, showCancel: false })
        })
        .catch(error => {
          this.setData({ executingId: '' })
          this.loadAuthorizations()
          const onsite = error.issue && error.issue.status === 'REQUIRES_ONSITE_MAINTENANCE'
          const rawCount = error.issue && (error.issue.consecutiveUnlockFailures !== undefined ? error.issue.consecutiveUnlockFailures : error.issue.failedAttempts)
          const failureCount = Number(rawCount)
          const serverRemaining = Number(error.issue && error.issue.remainingAttempts)
          const remaining = Number.isFinite(serverRemaining)
            ? Math.max(0, serverRemaining)
            : Number.isFinite(failureCount) && failureCount > 0 ? Math.max(0, 3 - failureCount) : null
          const failureHint = remaining === null
            ? ''
            : remaining > 0
              ? `本柜格还可尝试 ${remaining} 次，您可继续尝试开柜或更换其他柜格；如多次失败后自动停用，也请不用担心，工作人员会尽快处理。`
              : error.issue.hasWaitingPickup
                ? '该柜格已自动停用。如您的外卖仍在柜内，请先联系客服，工作人员会尽快处理，请不用担心。'
                : '该柜格已自动停用，工作人员会尽快处理，请暂时选择其他柜格或联系客服。'
          wx.showModal({
            title: onsite ? '需要现场维修' : '本次开锁失败',
            content: failureHint || (onsite ? '该柜格已转维修，工作人员会尽快处理，请联系客服。' : '本次开柜未成功，请联系客服核验后重试。'),
            showCancel: false
          })
        })
    }
    if (bluetoothService.isConnectedTo(authorization.cabinetId)) return run()
    wx.showLoading({ title: '连接柜体中' })
    getApp().switchCabinet(authorization.cabinetId).then(() => { wx.hideLoading(); run() }).catch(() => {
      wx.hideLoading()
      wx.showToast({ title: 'BLE连接失败，请靠近柜体', icon: 'none' })
    })
  }
})

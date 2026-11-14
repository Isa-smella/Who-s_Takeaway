const bluetoothService = require('../../services/bluetoothService')
const lockerRepository = require('../../repositories/lockerRepository')
const depositRepository = require('../../repositories/depositRepository')
const unlockAuthorizationService = require('../../services/unlockAuthorizationService')
const unlockExecutionService = require('../../services/unlockExecutionService')
const doorSensorService = require('../../services/doorSensorService')
const operationLogService = require('../../services/operationLogService')
const permissionGuard = require('../../services/permissionGuard')
const ACTIONS = require('../../constants/operationActions')
const { USE_CLOUD } = require('../../config/env')

Page({
  data: { cabinetId: '', lockerId: null, lockerNumber: '', pickupCode: '', phase: 'INPUT', errorMessage: '', unlockFailureHint: '', consecutiveUnlockFailures: 0, remainingAttempts: null, failureHasWaitingPickup: true, doorStatus: 'UNKNOWN', bluetoothStatus: 'DISCONNECTED', authorizedRecordId: '', authorizationId: '', pickedTime: '', submitting: false, requiresOnsite: false },
  onLoad(options) {
    try { permissionGuard.assertRole(permissionGuard.PICKUP_ROLES) } catch (error) { permissionGuard.requireAccess({ roles: permissionGuard.PICKUP_ROLES }).catch(() => {}); return }
    const cabinetId = options.cabinetId ? decodeURIComponent(options.cabinetId) : getApp().globalData.currentCabinetId
    const lockerId = Number(options.lockerId)
    const locker = lockerRepository.getLocker(cabinetId, lockerId)
    if (!locker || locker.status !== 'OCCUPIED') {
      wx.showModal({ title: '柜格不可取餐', content: '该柜格当前没有可正常取餐的外卖。', showCancel: false, success: () => wx.navigateBack() })
      return
    }
    this.setData({ cabinetId, lockerId, lockerNumber: String(lockerId).padStart(2, '0'), bluetoothStatus: bluetoothService.getConnectionStatus(cabinetId) })
    this.unsubscribeBluetooth = bluetoothService.subscribeConnectionStatus(state => {
      if (state.cabinetId === cabinetId || !state.cabinetId) this.setData({ bluetoothStatus: state.status })
    })
    this.unsubscribeDoor = doorSensorService.subscribeDoorStatus(cabinetId, lockerId, status => this.handleDoorStatus(status))
  },
  onUnload() {
    this.stopDoorPolling()
    if (this.unsubscribeBluetooth) this.unsubscribeBluetooth()
    if (this.unsubscribeDoor) this.unsubscribeDoor()
  },

  onHide() { this.stopDoorPolling() },

  onShow() {
    if (!this.data.cabinetId || this.data.lockerId === null || !bluetoothService.isConnectedTo(this.data.cabinetId)) return
    if (this.data.phase === 'OPENING') this.startDoorPolling('OPEN')
    if (this.data.phase === 'SUCCESS') this.startDoorPolling('CLOSED')
  },

  startDoorPolling(targetStatus) {
    if (this.doorPollingTarget === targetStatus && this.doorPollingStop && this.doorPollingStop.active !== false) return
    this.stopDoorPolling()
    this.doorPollingTarget = targetStatus
    this.doorPollingStop = doorSensorService.startDoorStatusPolling(this.data.cabinetId, this.data.lockerId, { targetStatus })
  },

  stopDoorPolling() {
    if (this.doorPollingStop) this.doorPollingStop()
    this.doorPollingStop = null
    this.doorPollingTarget = ''
  },

  handleDoorStatus(status) {
    if (!status) return
    const phase = this.data.phase
    this.setData({ doorStatus: status })
    if (status === 'OPEN' && ['OPENING', 'SUCCESS'].includes(phase)) {
      this.startDoorPolling('CLOSED')
    } else if (status === 'CLOSED' && this.doorPollingTarget === 'CLOSED') {
      this.stopDoorPolling()
    }
  },

  onCodeInput(event) { this.setData({ pickupCode: String(event.detail.value || '').replace(/\D/g, '').slice(0, 4), errorMessage: '' }) },
  confirmPickup() {
    if (this.data.submitting) return
    if (this.data.pickupCode.length !== 4) return this.setData({ errorMessage: '请输入4位取餐码' })
    if (!USE_CLOUD) operationLogService.log(ACTIONS.USER_ENTER_PICKUP_CODE, { cabinetId: this.data.cabinetId, lockerId: this.data.lockerId, detail: { codeLength: 4 } })
    this.createAndExecuteAuthorization()
  },
  createAndExecuteAuthorization(recordId) {
    let request
    try { request = unlockAuthorizationService.requestUnlockAuthorization({ source: 'NORMAL_PICKUP', cabinetId: this.data.cabinetId, lockerId: this.data.lockerId, recordId, pickupCode: this.data.pickupCode }) }
    catch (error) { request = Promise.reject(error) }
    this.setData({ submitting: true })
    Promise.resolve(request).then(authorization => {
      if (!USE_CLOUD) operationLogService.log(ACTIONS.USER_PICKUP_VERIFY_SUCCESS, { cabinetId: this.data.cabinetId, lockerId: this.data.lockerId, recordId: authorization.recordId })
      this.setData({ authorizedRecordId: authorization.recordId, authorizationId: authorization.id, requiresOnsite: false, submitting: false })
      if (!bluetoothService.isConnectedTo(this.data.cabinetId)) return this.setData({ phase: 'CONNECTION_ERROR', errorMessage: '暂未连接柜体' })
      this.executeAuthorization()
    }).catch(error => {
      if (!USE_CLOUD) operationLogService.log(ACTIONS.USER_PICKUP_VERIFY_FAILED, { cabinetId: this.data.cabinetId, lockerId: this.data.lockerId, result: 'FAILED', detail: { reason: error.message } })
      const limited = error.message === 'PICKUP_ATTEMPTS_LIMITED'
      this.setData({ phase: 'CODE_ERROR', submitting: false, pickupCode: '', errorMessage: limited ? '错误次数过多，请稍后再试' : '取餐码错误' })
    })
  },
  executeAuthorization() {
    this.stopDoorPolling()
    this.setData({ phase: 'OPENING', submitting: true, errorMessage: '' })
    this.startDoorPolling('OPEN')
    unlockExecutionService.executeAuthorization({ authorizationId: this.data.authorizationId, currentCabinetId: this.data.cabinetId })
      .then(result => {
        this.setData({ phase: 'SUCCESS', submitting: false, pickedTime: this.formatTime(result.record.pickedAt), doorStatus: 'OPEN' })
        this.startDoorPolling('CLOSED')
      })
      .catch(error => {
        this.stopDoorPolling()
        const requiresOnsite = error.issue && error.issue.status === 'REQUIRES_ONSITE_MAINTENANCE'
        const rawCount = error.issue && (error.issue.consecutiveUnlockFailures !== undefined ? error.issue.consecutiveUnlockFailures : error.issue.failedAttempts)
        const failureCount = Number(rawCount)
        if (Number.isFinite(failureCount) && failureCount > 0) {
          const serverRemaining = Number(error.issue.remainingAttempts)
          const remainingAttempts = Number.isFinite(serverRemaining) ? Math.max(0, serverRemaining) : Math.max(0, 3 - failureCount)
          const hasWaitingPickup = Boolean(error.issue.hasWaitingPickup)
          const hint = remainingAttempts > 0
            ? `本柜格还可尝试 ${remainingAttempts} 次，您可继续尝试开柜或更换其他柜格；如多次失败后自动停用，也请不用担心，工作人员会尽快处理。`
            : hasWaitingPickup
              ? '该柜格已自动停用。如您的外卖仍在柜内，请先联系客服，工作人员会尽快处理，请不用担心。'
              : '该柜格已自动停用，工作人员会尽快处理，请暂时选择其他柜格或联系客服。'
          this.setData({ phase: 'OPEN_ERROR', submitting: false, requiresOnsite: remainingAttempts === 0 || requiresOnsite, consecutiveUnlockFailures: failureCount, remainingAttempts, failureHasWaitingPickup: hasWaitingPickup, unlockFailureHint: hint, errorMessage: remainingAttempts === 0 || requiresOnsite ? '该柜格已自动停用' : '开柜失败' })
          return
        }
        this.setData({ phase: 'OPEN_ERROR', submitting: false, requiresOnsite, errorMessage: requiresOnsite ? '多次开锁失败，已转现场维修' : '未检测到柜门成功打开', unlockFailureHint: '' })
      })
  },
  reconnect() {
    this.setData({ phase: 'CONNECTING', submitting: true, errorMessage: '', unlockFailureHint: '' })
    getApp().switchCabinet(this.data.cabinetId).then(() => this.executeAuthorization()).catch(() => this.setData({ phase: 'CONNECTION_ERROR', submitting: false, errorMessage: '蓝牙连接失败' }))
  },
  retryInput() { this.setData({ phase: 'INPUT', pickupCode: '', errorMessage: '', unlockFailureHint: '', remainingAttempts: null, requiresOnsite: false }) },
  retryOpen() {
    if (this.data.pickupCode.length === 4) this.createAndExecuteAuthorization(this.data.authorizedRecordId)
    else this.retryInput()
  },
  contactService() {
    const recordId = this.data.authorizedRecordId ? `&recordId=${encodeURIComponent(this.data.authorizedRecordId)}` : ''
    wx.navigateTo({ url: `/pages/customer-service/customer-service?cabinetId=${encodeURIComponent(this.data.cabinetId)}&lockerId=${this.data.lockerId}${recordId}` })
  },
  finish() {
    this.stopDoorPolling()
    wx.navigateBack({ delta: 2 })
  },
  formatTime(iso) { const date = new Date(iso); return `${String(date.getHours()).padStart(2, '0')}:${String(date.getMinutes()).padStart(2, '0')}` }
})

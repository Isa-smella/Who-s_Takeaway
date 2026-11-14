const bluetoothService = require('../../services/bluetoothService')
const unlockAuthorizationService = require('../../services/unlockAuthorizationService')
const unlockExecutionService = require('../../services/unlockExecutionService')
const doorSensorService = require('../../services/doorSensorService')
const lockerRepository = require('../../repositories/lockerRepository')
const depositRepository = require('../../repositories/depositRepository')
const operationLogService = require('../../services/operationLogService')
const operationEventService = require('../../services/operationEventService')
const EVENT_TYPES = require('../../constants/operationEventTypes')
const permissionGuard = require('../../services/permissionGuard')
const authService = require('../../services/authService')
const ACTIONS = require('../../constants/operationActions')
const { normalizePickupCode, isValidPickupCode } = require('../../services/pickupCodeService')
const { IS_DEVELOPMENT, USE_CLOUD, BLE_TRANSPORT } = require('../../config/env')
const storeFailureService = require('../../services/storeFailureService')

Page({
  data: {
    cabinetId: '',
    lockerId: null,
    lockerNumber: '',
    doorStatus: 'CLOSED',
    bluetoothStatus: 'DISCONNECTED',
    phase: 'OPENING',
    errorMessage: '',
    unlockFailureHint: '',
    consecutiveUnlockFailures: 0,
    remainingAttempts: null,
    failureHasWaitingPickup: false,
    record: null,
    storedTime: '',
    isDevelopment: IS_DEVELOPMENT,
    isMockTransport: BLE_TRANSPORT === 'MOCK',
    confirming: false,
    reportingFailure: false,
    canRetryLocker: false,
    pickupCode: '',
    redepositMode: false,
    recordId: ''
  },

  onLoad(options) {
    try { permissionGuard.assertRole(permissionGuard.STORE_ROLES) } catch (error) {
      permissionGuard.requireAccess({ roles: permissionGuard.STORE_ROLES }).catch(() => {})
      return
    }
    const cabinetId = options.cabinetId ? decodeURIComponent(options.cabinetId) : getApp().globalData.currentCabinetId
    const lockerId = Number(options.lockerId)
    const redepositMode = options.mode === 'REDEPOSIT'
    const recordId = options.recordId ? decodeURIComponent(options.recordId) : ''
    if (redepositMode) {
      if (!recordId) {
        wx.showModal({ title: '无法再次存入', content: '存入记录参数缺失，请返回后重试。', showCancel: false, success: () => wx.navigateBack() })
        return
      }
      this.setData({ cabinetId, lockerId, lockerNumber: String(lockerId).padStart(2, '0'), redepositMode: true, recordId, phase: 'CONNECTING' })
      if (wx.setNavigationBarTitle) wx.setNavigationBarTitle({ title: '再次存入' })
      Promise.resolve(getApp().switchCabinet(cabinetId))
        .then(() => this.initializeLockerFlow(cabinetId, lockerId, true, recordId))
        .catch(error => {
          if (!getApp().showCabinetUnavailable || !getApp().showCabinetUnavailable(error, cabinetId)) {
            this.setData({ phase: 'CONNECTION_ERROR', errorMessage: '柜体连接失败' })
          }
        })
      return
    }
    this.initializeLockerFlow(cabinetId, lockerId, false, '')
  },

  initializeLockerFlow(cabinetId, lockerId, redepositMode, recordId) {
    const locker = lockerRepository.getLocker(cabinetId, lockerId)
    if (locker && (locker.status === 'MAINTENANCE' || locker.faultActive)) {
      this.setData({ cabinetId, lockerId, lockerNumber: String(lockerId).padStart(2, '0'), doorStatus: locker.doorStatus, redepositMode, recordId, phase: 'LOCKER_MAINTENANCE', errorMessage: '该柜格正在维修中' })
      return
    }
    const lockerReady = redepositMode
      ? locker && locker.status === 'OCCUPIED' && locker.currentRecordId === recordId
      : locker && locker.status === 'EMPTY'
    if (!lockerReady) {
      wx.showModal({
        title: redepositMode ? '无法再次存入' : '柜格不可用',
        content: redepositMode ? '该柜格的未取餐记录已经变化，请返回存入记录刷新后重试。' : '请选择其他空闲柜格。',
        showCancel: false,
        success: () => wx.navigateBack()
      })
      return
    }
    const applyDoorStatus = doorStatus => {
      if (!doorStatus) return
      this.setData({ cabinetId, lockerId, lockerNumber: String(lockerId).padStart(2, '0'), doorStatus, redepositMode, recordId })
      this.unsubscribeDoor = doorSensorService.subscribeDoorStatus(cabinetId, lockerId, status => this.handleDoorStatus(status))
      this.unsubscribeBluetooth = bluetoothService.subscribeConnectionStatus(state => {
        if (state.cabinetId === cabinetId || !state.cabinetId) this.setData({ bluetoothStatus: state.status })
      })
      // 上一位用户未关门时，空闲柜格无需重复开锁，可直接放入并等待关门。
      if (doorStatus === 'OPEN') this.handleDoorStatus('OPEN')
      else this.startOpenFlow()
    }
    if (BLE_TRANSPORT !== 'HM10_TEXT') {
      applyDoorStatus(doorSensorService.getDoorStatus(cabinetId, lockerId))
      return
    }
    const doorStatusRequest = doorSensorService.refreshDoorStatus
      ? doorSensorService.refreshDoorStatus(cabinetId, lockerId)
      : Promise.resolve(doorSensorService.getDoorStatus(cabinetId, lockerId))
    Promise.resolve(doorStatusRequest).catch(error => {
      this.setData({ phase: 'CONNECTION_ERROR', errorMessage: error.message === 'BLE_NOT_IDENTIFIED' ? '柜体身份尚未验证' : '暂时无法读取柜门状态' })
      return null
    }).then(applyDoorStatus)
  },

  onUnload() {
    this.stopDoorPolling()
    if (this.unsubscribeDoor) this.unsubscribeDoor()
    if (this.unsubscribeBluetooth) this.unsubscribeBluetooth()
  },

  onHide() { this.stopDoorPolling() },

  onShow() {
    if (BLE_TRANSPORT !== 'HM10_TEXT' || !this.data.cabinetId || this.data.lockerId === null) return
    if (!bluetoothService.isConnectedTo(this.data.cabinetId)) return
    if (this.data.phase === 'OPENING') this.startDoorPolling('OPEN')
    if (this.data.phase === 'WAITING_CLOSE') this.startDoorPolling('CLOSED')
  },

  startDoorPolling(targetStatus) {
    if (BLE_TRANSPORT !== 'HM10_TEXT') return
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

  startOpenFlow() {
    this.stopDoorPolling()
    const bluetoothStatus = bluetoothService.getConnectionStatus(this.data.cabinetId)
    this.setData({ bluetoothStatus, errorMessage: '' })
    if (bluetoothStatus !== 'CONNECTED') {
      this.setData({ phase: 'CONNECTION_ERROR', errorMessage: '暂未连接柜体' })
      return
    }
    this.setData({ phase: 'OPENING', errorMessage: '', unlockFailureHint: '', remainingAttempts: null })
    this.startDoorPolling('OPEN')
    try {
      const authorization = unlockAuthorizationService.requestUnlockAuthorization({
        source: this.data.redepositMode ? 'STORE_REOPEN' : 'STORE',
        cabinetId: this.data.cabinetId,
        lockerId: this.data.lockerId,
        recordId: this.data.redepositMode ? this.data.recordId : null
      })
      Promise.resolve(authorization)
        .catch(error => { error.storeFlowStage = 'CREATE_AUTHORIZATION'; throw error })
        .then(item => unlockExecutionService.executeAuthorization({ authorizationId: item.id, currentCabinetId: this.data.cabinetId })
          .catch(error => { error.storeFlowStage = 'EXECUTE_AUTHORIZATION'; throw error }))
        .then(() => this.handleDoorStatus('OPEN'))
        .catch(error => { console.error('store unlock failed', error); this.handleOpenError(error) })
    } catch (error) {
      this.handleOpenError(error)
    }
  },

  handleOpenError(error) {
    this.stopDoorPolling()
    const code = error && error.message
    const issue = error && error.issue
    const rawCount = issue && (issue.consecutiveUnlockFailures !== undefined ? issue.consecutiveUnlockFailures : issue.failedAttempts)
    const failureCount = Number(rawCount)
    if (Number.isFinite(failureCount) && failureCount > 0) {
      const serverRemaining = Number(issue.remainingAttempts)
      const remainingAttempts = Number.isFinite(serverRemaining) ? Math.max(0, serverRemaining) : Math.max(0, 3 - failureCount)
      const hasWaitingPickup = Boolean(issue.hasWaitingPickup)
      const hint = remainingAttempts > 0
        ? `本柜格还可尝试 ${remainingAttempts} 次，您可继续尝试开柜或更换其他柜格；如多次失败后自动停用，也请不用担心，工作人员会尽快处理。`
        : hasWaitingPickup
          ? '该柜格已自动停用。如您的外卖仍在柜内，请先联系客服，工作人员会尽快处理，请不用担心。'
          : '该柜格已自动停用，工作人员会尽快处理，请暂时选择其他柜格或联系客服。'
      const patch = { consecutiveUnlockFailures: failureCount, remainingAttempts, failureHasWaitingPickup: hasWaitingPickup, unlockFailureHint: hint }
      if (remainingAttempts === 0 || issue.status === 'REQUIRES_ONSITE_MAINTENANCE') {
        this.setData({ ...patch, phase: 'LOCKER_MAINTENANCE', errorMessage: '该柜格已自动停用' })
      } else {
        this.setData({ ...patch, phase: 'OPEN_ERROR', errorMessage: '开柜失败' })
      }
      return
    }
    if (this.data.redepositMode) {
      const cloudVersion = error && error.cloudDetail && error.cloudDetail.functionVersion || ''
      const oldCloudFunction = ['LOCKER_OCCUPIED', 'LOCKER_NOT_AVAILABLE_FOR_STORE'].includes(code) && cloudVersion !== '2026-09-02-store-auth-v4'
      const displayCode = oldCloudFunction ? 'STORE_REOPEN_CLOUD_FUNCTION_OUTDATED' : code
      const messages = {
        STORE_REOPEN_EXPIRED: '重新开柜时间已超过10分钟',
        STORE_REOPEN_NOT_ALLOWED: '当前账号不能再次存入这条记录',
        STORE_REOPEN_RECORD_MISMATCH: '柜格记录已经变化，不能再次存入',
        LOCKER_IN_MAINTENANCE: '该柜格正在维修中',
        LOCKER_DISABLED: '该柜格正在维修中',
        STORE_REOPEN_CLOUD_FUNCTION_OUTDATED: IS_DEVELOPMENT ? '云端重新开柜函数尚未更新，请重新部署 createStoreUnlockAuthorization' : '重新开柜服务暂未更新，请联系管理员',
        BLUETOOTH_NOT_CONNECTED_TO_CABINET: '暂未连接对应柜体',
        DOOR_NOT_OPEN: '柜门未能打开'
      }
      if (displayCode === 'LOCKER_IN_MAINTENANCE' || displayCode === 'LOCKER_DISABLED' || (error && error.issue && error.issue.status === 'REQUIRES_ONSITE_MAINTENANCE')) {
        this.setData({ phase: 'LOCKER_MAINTENANCE', errorMessage: messages[displayCode] || '连续开锁失败，该柜格已转为维修中' })
        return
      }
      this.setData({ phase: 'OPEN_ERROR', errorMessage: messages[displayCode] || `再次存入开柜失败（${displayCode || 'UNKNOWN'}）` })
      return
    }
    if (code === 'LOCKER_IN_MAINTENANCE' || (error && error.issue && error.issue.status === 'REQUIRES_ONSITE_MAINTENANCE')) {
      this.setData({ phase: 'LOCKER_MAINTENANCE', errorMessage: code === 'LOCKER_IN_MAINTENANCE' ? '该柜格正在维修中' : '该柜格已自动停用', unlockFailureHint: code === 'LOCKER_IN_MAINTENANCE' ? '请联系客服或选择其他柜格。' : '系统已通知工作人员处理。' })
      return
    }
    if (code === 'LOCKER_OCCUPIED') {
      this.setData({ phase: 'LOCKER_NOT_READY', errorMessage: '该柜格仍绑定未取餐记录', canRetryLocker: false })
      return
    }
    if (code === 'LOCKER_DISABLED') {
      this.setData({ phase: 'LOCKER_NOT_READY', errorMessage: '该柜格维修中', canRetryLocker: false })
      return
    }
    if (code === 'LOCKER_NOT_AVAILABLE_FOR_STORE') {
      const doorStatus = doorSensorService.getDoorStatus(this.data.cabinetId, this.data.lockerId)
      const cloudVersion = error && error.cloudDetail && error.cloudDetail.functionVersion
      if (!cloudVersion && error.storeFlowStage === 'CREATE_AUTHORIZATION') {
        this.setData({ phase: 'OPEN_ERROR', errorMessage: '云端存餐授权函数尚未更新' })
        return
      }
      const cloudLocker = error.cloudDetail && error.cloudDetail.detail
      if (cloudLocker) {
        const recordText = cloudLocker.currentRecordId ? '，仍绑定业务记录' : ''
        this.setData({ phase: 'LOCKER_NOT_READY', errorMessage: `云端柜格状态异常：${cloudLocker.status || 'UNKNOWN'}${recordText}`, canRetryLocker: false })
        return
      }
      this.setData({
        doorStatus,
        phase: 'LOCKER_NOT_READY',
        errorMessage: doorStatus === 'OPEN' ? '柜门当前未关闭' : '该柜格当前不可存入',
        canRetryLocker: doorStatus === 'OPEN'
      })
      return
    }
    this.setData({ phase: 'OPEN_ERROR', errorMessage: code === 'DOOR_NOT_OPEN' ? '柜门未能打开' : '柜门打开失败' })
  },

  retryOpen() { this.startOpenFlow() },

  handleDoorStatus(status) {
    if (!status) return
    const phase = this.data.phase
    if (phase === 'SUCCESS') {
      this.setData({ doorStatus: status })
      return
    }
    if (status === 'OPEN') {
      this.setData({ doorStatus: status })
      if (['OPENING', 'WAITING_CLOSE', 'WAITING_CONFIRM'].includes(phase)) {
        this.setData({ phase: 'WAITING_CLOSE' })
        this.startDoorPolling('CLOSED')
      }
      return
    }
    if (status === 'CLOSED') {
      this.stopDoorPolling()
      if (phase === 'OPENING') {
        this.setData({ doorStatus: status })
        return
      }
      if (['WAITING_CLOSE', 'WAITING_CONFIRM'].includes(phase)) {
        this.setData({ doorStatus: status, phase: 'WAITING_CONFIRM' })
        return
      }
      this.setData({ doorStatus: status })
    }
  },

  reconnect() {
    this.stopDoorPolling()
    this.setData({ phase: 'CONNECTING', errorMessage: '', unlockFailureHint: '' })
    getApp().switchCabinet(this.data.cabinetId)
      .then(() => this.startOpenFlow())
      .catch(() => this.setData({ phase: 'CONNECTION_ERROR', errorMessage: '蓝牙连接失败' }))
  },

  reopen() {
    operationLogService.log(ACTIONS.USER_REOPEN_STORE_LOCK, { cabinetId: this.data.cabinetId, lockerId: this.data.lockerId })
    this.startOpenFlow()
  },

  inputPickupCode(event) { this.setData({ pickupCode: normalizePickupCode(event.detail.value) }) },

  confirmDeposit() {
    if (this.data.confirming) return
    if (!isValidPickupCode(this.data.pickupCode)) {
      wx.showToast({ title: '请输入手机号后4位', icon: 'none' })
      return
    }
    this.setData({ confirming: true })
    const readStatus = Promise.resolve().then(() => doorSensorService.refreshDoorStatus
      ? doorSensorService.refreshDoorStatus(this.data.cabinetId, this.data.lockerId)
      : doorSensorService.getDoorStatus(this.data.cabinetId, this.data.lockerId)
    ).catch(error => {
      const statusError = new Error('DOOR_STATUS_UNAVAILABLE')
      statusError.cause = error
      throw statusError
    })
    readStatus.then(currentDoorStatus => {
      if (currentDoorStatus !== 'CLOSED') {
        this.setData({ confirming: false })
        this.handleDoorStatus('OPEN')
        wx.showToast({ title: '请先关闭柜门', icon: 'none' })
        return null
      }
      return depositRepository.confirmDeposit({
        cabinetId: this.data.cabinetId,
        lockerId: this.data.lockerId,
        depositorUserId: authService.getCurrentUser().id,
        doorClosed: true,
        pickupCode: this.data.pickupCode,
        recordId: this.data.redepositMode ? this.data.recordId : null
      })
    }).then(record => {
      if (!record) return
        storeFailureService.clear(this.data.cabinetId, this.data.lockerId)
        operationEventService.recordEvent(EVENT_TYPES.DEPOSIT_CREATED, { cabinetId: this.data.cabinetId, lockerId: this.data.lockerId, recordId: record.id, success: true })
        if (!USE_CLOUD) operationLogService.log(ACTIONS.USER_CONFIRM_DEPOSIT, {
          cabinetId: this.data.cabinetId, lockerId: this.data.lockerId, recordId: record.id
        })
        this.stopDoorPolling()
        this.setData({ record, storedTime: this.formatTime(record.storedAt), phase: 'SUCCESS', confirming: false })
    }).catch(error => this.handleDepositError(error))
  },

  handleDepositError(error) {
    if (!USE_CLOUD) operationLogService.log(ACTIONS.USER_CONFIRM_DEPOSIT, {
      cabinetId: this.data.cabinetId, lockerId: this.data.lockerId,
      result: 'FAILED', detail: { reason: error.message }
    })
    this.setData({ confirming: false })
    const code = error && error.message || 'STORE_CONFIRM_FAILED'
    if (code === 'DOOR_STATUS_UNAVAILABLE') {
      this.setData({ phase: 'CONNECTION_ERROR', errorMessage: '暂时无法读取柜门状态，请重试' })
      return
    }
    if (this.data.redepositMode) {
      const cloudVersion = error && error.cloudDetail && error.cloudDetail.functionVersion || ''
      const messages = {
        REDEPOSIT_RECORD_MISMATCH: '柜格记录已经变化，不能再次存入',
        REDEPOSIT_NOT_ALLOWED: '当前账号不能再次存入这条记录',
        LOCKER_IN_MAINTENANCE: '该柜格正在维修中',
        DOOR_NOT_CLOSED: '请先关闭柜门',
        PICKUP_CODE_INVALID: '请输入手机号后4位'
      }
      const outdated = code === 'LOCKER_NOT_EMPTY' && cloudVersion !== '2026-09-02-create-deposit-v2'
      const content = outdated
        ? (IS_DEVELOPMENT ? '云端再次存入功能尚未更新，请重新部署 createDeposit' : '再次存入服务暂未更新，请联系管理员')
        : (messages[code] || '再次存入尚未完成，原取餐码和未取餐记录保持不变，请重试。')
      wx.showModal({ title: '再次存入失败', content, showCancel: false })
      return
    }
    if (code === 'LOCKER_NOT_EMPTY' || code === 'LOCKER_NO_LONGER_EMPTY') {
      wx.showModal({ title: '该柜格已不可用', content: '请返回并选择其他空闲柜格。', showCancel: false })
      return
    }
    if (this.data.reportingFailure) return
    this.setData({ reportingFailure: true })
    storeFailureService.report(this.data.cabinetId, this.data.lockerId, code).then(issue => {
      this.setData({ reportingFailure: false })
      if (issue && issue.status === 'REQUIRES_ONSITE_MAINTENANCE') {
        this.setData({ phase: 'LOCKER_MAINTENANCE', errorMessage: '该柜格已转为维修中' })
        return
      }
      wx.showModal({ title: '暂未成功存入', content: '请重新确认柜门已关闭并再试一次；这不是实体开锁失败，不会计入柜格开锁故障次数。', showCancel: false })
    }).catch(reportError => {
      this.setData({ reportingFailure: false })
      console.error('store deposit failure report failed', reportError)
      wx.showToast({ title: '存入失败，请再试一次', icon: 'none' })
    })
  },

  simulateDepositFailure() {
    if (BLE_TRANSPORT !== 'MOCK') return
    if (this.data.confirming || this.data.reportingFailure || this.data.phase !== 'WAITING_CONFIRM') return
    this.handleDepositError(new Error('MOCK_STORE_CONFIRM_FAILED'))
  },

  copyPickupInfo() {
    const text = `您的外卖已存入湖's Takeaway ${this.data.cabinetId} 柜体 ${this.data.lockerNumber}号柜。\n\n取餐码：${this.data.record.pickupCode}\n存入时间：${this.data.storedTime}`
    wx.setClipboardData({ data: text })
    operationLogService.log(ACTIONS.USER_COPY_PICKUP_INFO, {
      cabinetId: this.data.cabinetId, lockerId: this.data.lockerId,
      recordId: this.data.record && this.data.record.id
    })
  },

  mockCloseDoor() {
    if (BLE_TRANSPORT !== 'MOCK') return
    doorSensorService.mockSetDoorStatus(this.data.cabinetId, this.data.lockerId, 'CLOSED')
  },
  contactService() {
    const recordId = this.data.record ? `&recordId=${encodeURIComponent(this.data.record.id)}` : ''
    wx.navigateTo({ url: `/pages/customer-service/customer-service?cabinetId=${encodeURIComponent(this.data.cabinetId)}&lockerId=${this.data.lockerId}${recordId}` })
  },
  finish() {
    this.stopDoorPolling()
    wx.navigateBack({ delta: this.data.redepositMode ? 1 : 2 })
  },
  formatTime(iso) {
    const date = new Date(iso)
    return `${String(date.getHours()).padStart(2, '0')}:${String(date.getMinutes()).padStart(2, '0')}`
  }
})

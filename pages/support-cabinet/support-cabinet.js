const permissionGuard = require('../../services/permissionGuard')
const emergencyUnlockService = require('../../services/emergencyUnlockService')
const customerServiceUnlockAuthorizationService = require('../../services/customerServiceUnlockAuthorizationService')
const doorSensorService = require('../../services/doorSensorService')
const bluetoothService = require('../../services/bluetoothService')
const cabinetBleStatusService = require('../../services/cabinetBleStatusService')
const { normalizeLockerId } = require('../../utils/idNormalizer')
const { isDoorStatus, formatDoorStatus } = require('../../utils/doorStatusFormatter')
const { BLE_TRANSPORT } = require('../../config/env')

Page({
  data: {
    authorized: false, cabinetId: '', cabinet: null, lockers: [], selectedLocker: null,
    customerPickupCode: '', customerUserId: '', customerUserLocked: false, prefillLockerId: null, supportRequestId: '', codeVerified: false,
    reason: '用户正常取餐失败，客服核验后授权重新开锁', issuing: false, issuedAuthorization: null,
    bleConnected: false, bleStatusText: '未连接', bleLastSeenLabel: '暂无通信记录', lastBleSeenAt: null
  },
  onLoad(options) {
    const cabinetId = options.cabinetId ? decodeURIComponent(options.cabinetId) : ''
    const customerUserId = options.customerUserId ? decodeURIComponent(options.customerUserId) : ''
    const supportRequestId = options.supportRequestId ? decodeURIComponent(options.supportRequestId) : ''
    const prefillLockerId = options.lockerId ? Number(options.lockerId) : null
    this.unsubscribeBluetooth = cabinetBleStatusService.subscribe(() => this.refreshBleDisplay())
    permissionGuard.requireAccess({ roles: permissionGuard.CUSTOMER_SERVICE_ROLES }).then(() => {
      this.setData({ authorized: true, cabinetId, customerUserId, customerUserLocked: Boolean(supportRequestId && customerUserId), supportRequestId, prefillLockerId })
      this.loadCabinet(true)
    }).catch(() => {})
  },
  onUnload() { if (this.unsubscribeBluetooth) this.unsubscribeBluetooth() },
  onShow() { if (this.data.authorized) this.loadCabinet() },
  refreshBleDisplay() {
    if (!this.data.cabinetId) return
    this.setData(cabinetBleStatusService.getDisplay(this.data.cabinetId, this.data.lastBleSeenAt))
  },
  refreshLiveDoorStatuses(lockers) {
    if (BLE_TRANSPORT !== 'HM10_TEXT' || !bluetoothService.isConnectedTo(this.data.cabinetId) || !lockers.length) return Promise.resolve({})
    return doorSensorService.refreshDoorStatuses(this.data.cabinetId, lockers.map(item => item.id))
      .then(results => results.reduce((statuses, item) => {
        if (item && item.ok !== false && isDoorStatus(item.doorStatus)) statuses[normalizeLockerId(item.lockerId)] = item.doorStatus
        return statuses
      }, {}))
      .catch(() => ({}))
  },
  loadCabinet(audit = false) {
    let request
    try {
      request = emergencyUnlockService.getCabinetLockerOverview(this.data.cabinetId, { audit })
    } catch (error) { request = Promise.reject(error) }
    Promise.resolve(request).then(overview => {
      const lockers = overview.lockers.map(item => ({
        ...item,
        number: String(item.id).padStart(2, '0'),
        statusText: item.status === 'EMPTY' ? '空闲' : item.status === 'OCCUPIED' ? '占用' : '维修中',
        doorText: formatDoorStatus(item.doorStatus)
      }))
      return this.refreshLiveDoorStatuses(lockers).then(statuses => {
        const mergedLockers = lockers.map(item => {
          const doorStatus = statuses[normalizeLockerId(item.id)]
          return doorStatus ? { ...item, doorStatus, doorText: `实时：${formatDoorStatus(doorStatus)}` } : item
        })
        let selectedLocker = this.data.selectedLocker ? mergedLockers.find(item => Number(item.id) === Number(this.data.selectedLocker.id)) || null : null
        if (!selectedLocker && this.data.prefillLockerId) {
          const candidate = mergedLockers.find(item => Number(item.id) === Number(this.data.prefillLockerId))
          selectedLocker = candidate && candidate.canIssueAuthorization ? candidate : null
        }
        this.setData({ cabinet: overview.cabinet, ...cabinetBleStatusService.getDisplay(this.data.cabinetId, overview.cabinet.lastBleSeenAt), lastBleSeenAt: overview.cabinet.lastBleSeenAt || null, lockers: mergedLockers, selectedLocker })
      })
    }).catch(error => {
      wx.showToast({ title: '无法加载柜体', icon: 'none' })
    })
  },
  selectLocker(event) {
    const locker = this.data.lockers.find(item => item.id === Number(event.currentTarget.dataset.id))
    if (!locker) return
    if (!locker.canIssueAuthorization) {
      const message = locker.handlingStatus === 'REQUIRES_ONSITE_MAINTENANCE' ? '该柜格已转现场维修，不能继续电子授权' : locker.enabled === false || locker.status === 'DISABLED' ? '该柜格维修中' : locker.status === 'MAINTENANCE' ? '该柜格没有可核对的待取记录' : '该柜格当前没有待取餐'
      return wx.showToast({ title: message, icon: 'none' })
    }
    this.setData({ selectedLocker: locker, customerPickupCode: '', customerUserId: this.data.customerUserLocked ? this.data.customerUserId : '', codeVerified: false, issuedAuthorization: null })
  },
  inputPickupCode(event) {
    this.setData({ customerPickupCode: String(event.detail.value || '').replace(/\D/g, '').slice(0, 4), codeVerified: false })
  },
  inputCustomerUserId(event) {
    if (this.data.customerUserLocked) return
    this.setData({ customerUserId: String(event.detail.value || '').trim() })
  },
  inputReason(event) { this.setData({ reason: String(event.detail.value || '').slice(0, 200) }) },
  verifyPickupCode() {
    const locker = this.data.selectedLocker
    if (!locker) return
    let request
    try {
      request = emergencyUnlockService.verifyEmergencyPickupCode({
        cabinetId: this.data.cabinetId,
        lockerId: locker.id,
        pickupCode: this.data.customerPickupCode
      })
    } catch (error) { request = Promise.reject(error) }
    Promise.resolve(request).then(() => {
      this.setData({ codeVerified: true })
      wx.showToast({ title: '取餐码核对成功', icon: 'success' })
    }).catch(error => {
      this.setData({ codeVerified: false, customerPickupCode: '' })
      wx.showToast({ title: error.message === 'NO_WAITING_PICKUP_RECORD' ? '待取记录已失效' : '取餐码不一致', icon: 'none' })
      this.loadCabinet()
    })
  },
  issueAuthorization() {
    const locker = this.data.selectedLocker
    if (!locker || !this.data.codeVerified || this.data.issuing) return
    if (!this.data.customerUserId) return wx.showToast({ title: '请输入当前顾客用户ID', icon: 'none' })
    if (this.data.reason.trim().length < 5) return wx.showToast({ title: '请填写授权原因', icon: 'none' })
    wx.showModal({
      title: '确认签发开锁授权',
      content: `将为用户 ${this.data.customerUserId} 签发 ${this.data.cabinetId} · ${locker.number}号柜的一次性短时授权。\n\n客服不会直接连接柜体，用户需在自己的手机上通过 BLE 执行。`,
      confirmText: '确认授权',
      confirmColor: '#C03338',
      success: result => { if (result.confirm) this.createAuthorization() }
    })
  },
  createAuthorization() {
    const locker = this.data.selectedLocker
    this.setData({ issuing: true })
    let request
    try {
      request = customerServiceUnlockAuthorizationService.issueAuthorization({
        customerUserId: this.data.customerUserId,
        cabinetId: this.data.cabinetId,
        lockerId: locker.id,
        recordId: locker.recordId,
        pickupCode: this.data.customerPickupCode,
        reason: this.data.reason,
        supportRequestId: this.data.supportRequestId
      })
    } catch (error) { request = Promise.reject(error) }
    Promise.resolve(request).then(authorization => {
      this.setData({ issuing: false, codeVerified: false, customerPickupCode: '', issuedAuthorization: authorization })
      this.loadCabinet()
      wx.showModal({ title: '授权已发送', content: `一次性授权已签发给用户 ${authorization.userId}。用户登录自己的小程序后可在有效期内点击“重新开锁”。`, showCancel: false })
    }).catch(error => {
      this.setData({ issuing: false, codeVerified: false })
      wx.showToast({ title: error.message === 'REQUIRES_ONSITE_MAINTENANCE' ? '已转现场维修，不能继续授权' : '授权失败，请重新核验', icon: 'none' })
      this.loadCabinet()
    })
  }
})

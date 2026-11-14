const lockerRepository = require('../../repositories/lockerRepository')
const cabinetRepository = require('../../repositories/cabinetRepository')
const doorSensorService = require('../../services/doorSensorService')
const bluetoothService = require('../../services/bluetoothService')
const permissionGuard = require('../../services/permissionGuard')
const operationLogService = require('../../services/operationLogService')
const { normalizeLockerId } = require('../../utils/idNormalizer')
const { isDoorStatus } = require('../../utils/doorStatusFormatter')
const ACTIONS = require('../../constants/operationActions')
const { BLE_TRANSPORT } = require('../../config/env')
function hasWaitingPickup(locker) {
  return Boolean(locker && (locker.hasWaitingPickup === true || locker.currentRecordId || locker.status === 'OCCUPIED'))
}

Page({
  data: { cabinetId: '', lockers: [], mode: 'view', authorized: false },
  onLoad(options) {
    const cabinetId = options.cabinetId ? decodeURIComponent(options.cabinetId) : getApp().globalData.currentCabinetId
    this.setData({
      mode: options.mode || 'view',
      cabinetId: cabinetId || ''
    })
    this.doorStatusOverrides = {}
    if (!cabinetId) wx.showModal({ title: '未识别柜体', content: '请扫描柜体二维码后再操作。', showCancel: false, success: () => wx.navigateBack() })
    if (cabinetId) {
      try {
        const cabinet = cabinetRepository.getCabinet(cabinetId)
        if (cabinet.status !== 'ACTIVE') {
          const error = new Error(cabinet.status === 'DISABLED' ? 'CABINET_DISABLED' : 'CABINET_MAINTENANCE')
          getApp().showCabinetUnavailable(error, cabinetId)
          return
        }
      } catch (error) {
        getApp().showCabinetUnavailable(error, cabinetId)
        return
      }
      const roles = options.mode === 'store' ? permissionGuard.STORE_ROLES : options.mode === 'pickup' ? permissionGuard.PICKUP_ROLES : permissionGuard.CABINET_ACCESS_ROLES
      permissionGuard.requireAccess({ roles }).then(() => {
        this.setData({ authorized: true })
        this.loadLockers()
        this.ensureDoorSubscription()
        this.refreshDoorStatuses()
      }).catch(() => {})
    }
  },
  onShow() {
    if (!this.data.cabinetId || !this.data.authorized) return
    this.loadLockers()
    this.ensureDoorSubscription()
    this.refreshDoorStatuses()
  },
  onUnload() { if (this.unsubscribe) this.unsubscribe() },
  ensureDoorSubscription() {
    if (!this.unsubscribe) this.unsubscribe = doorSensorService.subscribeAll(this.data.cabinetId, payload => this.applyDoorStatusUpdate(payload))
  },
  applyDoorStatusUpdate(payload) {
    if (!payload || payload.cabinetId !== this.data.cabinetId || !isDoorStatus(payload.doorStatus)) {
      this.loadLockers()
      return
    }
    this.doorStatusOverrides[normalizeLockerId(payload.id)] = payload.doorStatus
    const source = this.data.lockers.length ? this.data.lockers : this.readLockerData()
    this.setData({ lockers: source.map(item => this.toLockerView(item)) })
  },
  readLockerData() {
    if (!this.data.cabinetId) return []
    return lockerRepository.getLockers(this.data.cabinetId)
  },
  toLockerView(item) {
    const override = (this.doorStatusOverrides || {})[normalizeLockerId(item.id)]
    return {
      ...item,
      doorStatus: isDoorStatus(override) ? override : item.doorStatus,
      hasWaitingPickup: hasWaitingPickup(item),
      number: String(item.id).padStart(2, '0'),
      statusText: item.status === 'EMPTY' ? '空闲' : item.status === 'OCCUPIED' ? '占用' : '维修中',
      timeText: item.storedAt ? new Date(item.storedAt).toTimeString().slice(0, 5) : ''
    }
  },
  refreshDoorStatuses() {
    if (BLE_TRANSPORT !== 'HM10_TEXT' || !bluetoothService.isConnectedTo(this.data.cabinetId) || this.refreshingDoorStatuses) return
    let lockerData
    try { lockerData = this.data.lockers.length ? this.data.lockers : this.readLockerData() } catch (error) { lockerData = [] }
    const lockerIds = lockerData.map(item => item.id)
    if (!lockerIds.length) return
    this.refreshingDoorStatuses = true
    doorSensorService.refreshDoorStatuses(this.data.cabinetId, lockerIds)
      .then(results => {
        results.filter(item => item && item.ok !== false && isDoorStatus(item.doorStatus)).forEach(item => {
          this.doorStatusOverrides[normalizeLockerId(item.lockerId)] = item.doorStatus
        })
        const source = this.data.lockers.length ? this.data.lockers : lockerData
        this.setData({ lockers: source.map(item => this.toLockerView(item)) })
      })
      .catch(() => {})
      .then(() => { this.refreshingDoorStatuses = false })
  },
  loadLockers() {
    if (!this.data.cabinetId) return
    this.setData({ lockers: this.readLockerData().map(item => this.toLockerView(item)) })
  },
  selectLocker(event) {
    const locker = lockerRepository.getLocker(this.data.cabinetId, event.currentTarget.dataset.id)
    if (locker.enabled === false) {
      if (this.data.mode === 'pickup') return this.showPickupMaintenance(locker)
      wx.showModal({ title: '柜格维修中', content: '该柜格暂不提供服务，请选择其他柜格。', showCancel: false })
      return
    }
    if (this.data.mode === 'store') {
      if (locker.status === 'MAINTENANCE') {
        wx.showModal({ title: '柜格维修中', content: '该柜格暂时不能存餐，请选择其他空闲柜格。', cancelText: '返回', confirmText: '联系客服', success: result => { if (result.confirm) this.contactLockerService(locker.id) } })
        return
      }
      if (locker.status !== 'EMPTY') {
        wx.showToast({ title: '请选择空闲柜格', icon: 'none' })
        return
      }
    operationLogService.log(ACTIONS.USER_SELECT_STORE_LOCKER, { cabinetId: this.data.cabinetId, lockerId: locker.id })
      wx.navigateTo({ url: `/pages/rider-store/rider-store?cabinetId=${encodeURIComponent(this.data.cabinetId)}&lockerId=${locker.id}` })
      return
    }
    if (this.data.mode === 'pickup') {
      if (locker.status === 'MAINTENANCE' || locker.status === 'DISABLED') return this.showPickupMaintenance(locker)
      if (locker.status !== 'OCCUPIED') {
        wx.showToast({ title: '请选择占用柜格', icon: 'none' })
        return
      }
      wx.navigateTo({ url: `/pages/pickup/pickup?cabinetId=${encodeURIComponent(this.data.cabinetId)}&lockerId=${locker.id}` })
      return
    }
    wx.showModal({ title: `${String(locker.id).padStart(2, '0')}号柜`, content: `业务状态：${locker.status}\n门状态：${locker.doorStatus}`, showCancel: false })
  },
  showPickupMaintenance(locker) {
    const content = hasWaitingPickup(locker)
      ? '该柜格暂时无法自助取餐。如您的外卖仍在柜内，请先联系客服，工作人员会尽快处理。'
      : '该柜格暂时无法取餐，请联系客服处理。'
    wx.showModal({ title: '柜格维修中', content, cancelText: '返回', confirmText: '联系客服', success: result => { if (result.confirm) this.contactLockerService(locker.id) } })
  },
  contactLockerService(lockerId) {
    wx.navigateTo({ url: `/pages/customer-service/customer-service?cabinetId=${encodeURIComponent(this.data.cabinetId)}&lockerId=${lockerId}` })
  }
})

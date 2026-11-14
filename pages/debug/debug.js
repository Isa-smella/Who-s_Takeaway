const bluetoothService = require('../../services/bluetoothService')
const lockerRepository = require('../../repositories/lockerRepository')
const cabinetRepository = require('../../repositories/cabinetRepository')
const deviceRepository = require('../../repositories/deviceRepository')
const deviceHealthService = require('../../services/deviceHealthService')
const doorSensorService = require('../../services/doorSensorService')
const permissionGuard = require('../../services/permissionGuard')
const { USER_ROLE } = require('../../constants/status')
const operationLogService = require('../../services/operationLogService')
const ACTIONS = require('../../constants/operationActions')
const lockService = require('../../services/lockService')
const mockDataResetService = require('../../services/mockDataResetService')
const { USE_CLOUD } = require('../../config/env')

Page({
  data: { authorized: false, cabinetId: '', mockCabinetId: '', bluetoothStatus: '', connectedCabinetId: '', lockerId: 5, locker: null, telemetry: null, pendingUnlockFailure: '', useCloud: USE_CLOUD },
  onLoad() {
    permissionGuard.requireAccess({ roles: [USER_ROLE.DEVELOPER] }).then(() => {
      this.setData({ authorized: true })
      this.startAuthorizedView()
    }).catch(() => {})
  },
  onShow() {
    if (!this.data.authorized) return
    this.startAuthorizedView()
  },
  startAuthorizedView() {
    const cabinetId = getApp().globalData.currentCabinetId || ''
    this.setData({ cabinetId, mockCabinetId: cabinetId })
    this.refresh()
    if (!this.unsubscribe) this.unsubscribe = bluetoothService.subscribeConnectionStatus(() => this.refresh())
  },
  onUnload() { if (this.unsubscribe) this.unsubscribe() },
  refresh() {
    const state = bluetoothService.getConnectionState()
    this.setData({
      bluetoothStatus: this.data.cabinetId ? bluetoothService.getConnectionStatus(this.data.cabinetId) : 'DISCONNECTED',
      connectedCabinetId: state.cabinetId || '无',
      locker: this.data.cabinetId ? lockerRepository.getLocker(this.data.cabinetId, this.data.lockerId) : null,
      telemetry: this.data.cabinetId ? deviceRepository.getTelemetry(this.data.cabinetId) : null,
      pendingUnlockFailure: this.data.cabinetId ? lockService.getPendingMockFailure(this.data.cabinetId, this.data.lockerId) : ''
    })
  },
  setBluetooth(event) {
    const status = event.currentTarget.dataset.status
    bluetoothService.mockSetConnectionStatus(status, this.data.cabinetId)
    this.refresh()
    wx.showToast({ title: `BLE：${status}`, icon: 'none' })
  },
  onCabinetInput(event) { this.setData({ mockCabinetId: String(event.detail.value || '').trim() }) },
  switchCabinet() {
    if (!this.data.mockCabinetId) return wx.showToast({ title: '请输入 cabinetId', icon: 'none' })
    getApp().switchCabinet(this.data.mockCabinetId).then(() => {
      this.setData({ cabinetId: getApp().globalData.currentCabinetId })
      this.refresh()
      wx.showToast({ title: '柜体已切换', icon: 'success' })
    }).catch(error => {
      if (!getApp().showCabinetUnavailable(error, this.data.mockCabinetId)) {
        wx.showToast({ title: '切换柜体失败', icon: 'none' })
      }
    })
  },
  chooseLocker(event) { this.setData({ lockerId: Number(event.detail.value) + 1 }); this.refresh() },
  setDoor(event) {
    if (!this.data.cabinetId) return
    const status = event.currentTarget.dataset.status
    doorSensorService.mockSetDoorStatus(this.data.cabinetId, this.data.lockerId, status)
    this.refresh()
    wx.showToast({ title: `柜门状态：${status}`, icon: 'none' })
  },
  async setBusinessStatus(event) {
    if (this.data.cabinetId) {
      const status = event.currentTarget.dataset.status
      if (USE_CLOUD) {
        wx.showModal({
          title: '云端业务状态不能直接伪造',
          content: status === 'MAINTENANCE' ? '请在柜体管理中设置维修，或使用硬件故障上报。' : '空闲/占用状态由云端存取记录决定，请在柜体管理和维修工单中处理。',
          showCancel: false
        })
        try { await cabinetRepository.loadCabinet(this.data.cabinetId) } catch (error) {}
        this.refresh()
        return
      }
      try {
        lockerRepository.updateLocker(this.data.cabinetId, this.data.lockerId, { status })
        if (status === 'MAINTENANCE') operationLogService.log(ACTIONS.LOCKER_SET_MAINTENANCE, { cabinetId: this.data.cabinetId, lockerId: this.data.lockerId })
        if (status === 'EMPTY') operationLogService.log(ACTIONS.LOCKER_RESTORE, { cabinetId: this.data.cabinetId, lockerId: this.data.lockerId })
      } catch (error) {
        wx.showToast({ title: '状态设置失败', icon: 'none' })
      }
    }
    this.refresh()
  },
  async setBattery(event) {
    if (!this.data.cabinetId) return
    const batteryPercent = Number(event.currentTarget.dataset.percent)
    const onlineStatus = event.currentTarget.dataset.online || 'ONLINE'
    const voltage = batteryPercent <= 10 ? 3.35 : batteryPercent <= 25 ? 3.55 : 4.03
    try {
      await deviceHealthService.reportTelemetry(this.data.cabinetId, { batteryPercent, voltage, onlineStatus, firmwareVersion: 'mock-0.1.0' })
      deviceRepository.mockReportTelemetry(this.data.cabinetId, { batteryPercent, voltage, onlineStatus })
      if (onlineStatus === 'OFFLINE') {
        await deviceHealthService.reportCabinetFault(this.data.cabinetId, 'CONTROLLER_OFFLINE')
        getApp().deactivateCurrentCabinet(this.data.cabinetId)
      }
      this.refresh()
      wx.showToast({ title: onlineStatus === 'OFFLINE' ? '已上报离线故障' : `电量已上报 ${batteryPercent}%`, icon: 'none' })
    } catch (error) {
      console.error('debug telemetry failed', error)
      wx.showToast({ title: '电量上报失败', icon: 'none' })
    }
  },
  async reportLockerFault(event) {
    if (!this.data.cabinetId) return
    try {
      await deviceHealthService.reportLockerFault(this.data.cabinetId, this.data.lockerId, event.currentTarget.dataset.code)
      await cabinetRepository.loadCabinet(this.data.cabinetId)
      this.refresh()
      wx.showToast({ title: '柜格故障已上报', icon: 'success' })
    } catch (error) {
      console.error('debug locker fault failed', error)
      wx.showToast({ title: '故障上报失败', icon: 'none' })
    }
  },
  async passHealthCheck() {
    if (!this.data.cabinetId) return
    try {
      await deviceHealthService.reportHealthCheckPassed(this.data.cabinetId, this.data.lockerId)
      await cabinetRepository.loadCabinet(this.data.cabinetId)
      this.refresh()
      wx.showToast({ title: '设备自检已通过', icon: 'success' })
    } catch (error) {
      console.error('debug health check failed', error)
      const title = error.message === 'MAINTENANCE_ORDER_NOT_FOUND' ? '当前没有待处理维修工单' : '自检上报失败'
      wx.showToast({ title, icon: 'none' })
    }
  },
  async passCabinetHealthCheck() {
    if (!this.data.cabinetId) return
    try {
      await deviceHealthService.reportCabinetHealthCheckPassed(this.data.cabinetId)
      this.refresh()
      wx.showToast({ title: '整柜自检已通过', icon: 'success' })
    } catch (error) {
      console.error('debug cabinet health check failed', error)
      const title = error.message === 'MAINTENANCE_ORDER_NOT_FOUND' ? '当前没有整柜维修工单' : '整柜自检上报失败'
      wx.showToast({ title, icon: 'none' })
    }
  },
  failNextUnlock(event) {
    if (!this.data.cabinetId) return
    const failureCode = event.currentTarget.dataset.code
    lockService.mockFailNextOpen(this.data.cabinetId, this.data.lockerId, failureCode)
    this.refresh()
    const lockerLabel = String(this.data.lockerId).padStart(2, '0')
    wx.showToast({ title: `${lockerLabel}号柜故障已布置`, icon: 'none' })
  },
  resetData() {
    if (!this.data.cabinetId) return wx.showToast({ title: '请先输入 cabinetId', icon: 'none' })
    if (USE_CLOUD) return wx.showModal({ title: '云端数据不可一键重置', content: '为保护存取记录、审计日志和维修工单，云端模式不提供重置按钮。请通过对应业务流程处理测试数据。', showCancel: false })
    wx.showModal({
      title: '重置当前柜体 Mock 数据',
      content: '将清空当前柜体的存取、反馈、客服授权、故障和维修工单 Mock 数据。审计日志不会删除。',
      confirmText: '确认重置', confirmColor: '#C03338',
      success: result => {
        if (!result.confirm) return
        try { mockDataResetService.resetCabinet(this.data.cabinetId); this.refresh(); wx.showToast({ title: '当前柜体已重置' }) }
        catch (error) { wx.showToast({ title: '重置失败', icon: 'none' }) }
      }
    })
  }
})

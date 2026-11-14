const cabinetRepository = require('../../repositories/cabinetRepository')
const lockerRepository = require('../../repositories/lockerRepository')
const cabinetManagementService = require('../../services/cabinetManagementService')
const deviceHealthService = require('../../services/deviceHealthService')
const permissionGuard = require('../../services/permissionGuard')
const unlockIssueService = require('../../services/unlockIssueService')
const maintenanceWorkOrderService = require('../../services/maintenanceWorkOrderService')
const cabinetConsistencyService = require('../../services/cabinetConsistencyService')
const occupiedLockerClearService = require('../../services/occupiedLockerClearService')
const doorSensorService = require('../../services/doorSensorService')
const bluetoothService = require('../../services/bluetoothService')
const cabinetBleStatusService = require('../../services/cabinetBleStatusService')
const { normalizeLockerId } = require('../../utils/idNormalizer')
const { isDoorStatus, formatDoorStatus } = require('../../utils/doorStatusFormatter')
const { USE_CLOUD, BLE_TRANSPORT } = require('../../config/env')

const STATUS_LABELS = { ACTIVE: '正常', MAINTENANCE: '整柜维修中', DISABLED: '整柜维修中' }

Page({
  data: { authorized: false, cabinetId: '', cabinet: null, cabinetOrder: null, lockers: [], waitingPickupCount: 0, dataConsistencyIssues: [], processingLockerId: 0, bleConnected: false, bleStatusText: '未连接', bleLastSeenLabel: '暂无通信记录', lastBleSeenAt: null },
  onLoad(options) {
    const cabinetId = options.cabinetId ? decodeURIComponent(options.cabinetId) : ''
    this.setData({ cabinetId })
    this.unsubscribeBluetooth = cabinetBleStatusService.subscribe(() => this.refreshBleDisplay())
    permissionGuard.requireAccess({ roles: permissionGuard.MANAGEMENT_ROLES }).then(() => {
      this.setData({ authorized: true })
      this.loadCabinet()
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
  mergeLiveDoorStatuses(lockers, statuses) {
    return lockers.map(item => {
      const doorStatus = statuses[normalizeLockerId(item.id)]
      const resolvedStatus = doorStatus || item.doorStatus
      return { ...item, ...(doorStatus ? { doorStatus } : {}), doorText: formatDoorStatus(resolvedStatus, '柜门关闭') }
    })
  },
  loadCabinet() {
    if (USE_CLOUD) {
      return cabinetManagementService.getCabinetDetail(this.data.cabinetId).then(result => {
        const legacyTargets = []
        if (result.cabinet.status === 'DISABLED') legacyTargets.push(null)
        ;(result.lockers || []).filter(item => item.enabled === false || item.status === 'DISABLED').forEach(item => legacyTargets.push(item.id))
        if (legacyTargets.length && !this.normalizingLegacyDisabled) {
          this.normalizingLegacyDisabled = true
          return legacyTargets.reduce((chain, lockerId) => chain.then(() => Promise.resolve(cabinetManagementService.normalizeLegacyDisabled(this.data.cabinetId, lockerId))), Promise.resolve())
            .then(() => { this.normalizingLegacyDisabled = false; return this.loadCabinet() })
            .catch(error => { this.normalizingLegacyDisabled = false; throw error })
        }
        const lockers = result.lockers.map(item => ({ ...item, number: String(item.id).padStart(2, '0'), statusLabel: item.status === 'EMPTY' ? '空闲' : item.status === 'OCCUPIED' ? '占用' : '维修中', doorText: formatDoorStatus(item.doorStatus, '柜门关闭'), selfCheckPassed: Boolean(item.maintenanceOrder && item.maintenanceOrder.selfCheckPassedAt) }))
        return this.refreshLiveDoorStatuses(lockers).then(statuses => {
          const mergedLockers = this.mergeLiveDoorStatuses(lockers, statuses)
          this.setData({ cabinet: { ...result.cabinet, statusLabel: STATUS_LABELS[result.cabinet.status] || result.cabinet.status }, ...cabinetBleStatusService.getDisplay(this.data.cabinetId, result.cabinet.lastBleSeenAt), lastBleSeenAt: result.cabinet.lastBleSeenAt || null, cabinetOrder: result.cabinetOrder, lockers: mergedLockers, waitingPickupCount: result.waitingPickupCount, dataConsistencyIssues: result.dataConsistencyIssues || [] })
        })
      }).catch(() => wx.showToast({ title: '柜体不存在', icon: 'none' }))
    }
    try {
      const cabinet = cabinetRepository.getCabinet(this.data.cabinetId)
      const legacyLockers = lockerRepository.getLockers(this.data.cabinetId).filter(item => item.enabled === false || item.status === 'DISABLED')
      if ((cabinet.status === 'DISABLED' || legacyLockers.length) && !this.normalizingLegacyDisabled) {
        this.normalizingLegacyDisabled = true
        if (cabinet.status === 'DISABLED') cabinetManagementService.normalizeLegacyDisabled(this.data.cabinetId)
        legacyLockers.forEach(item => cabinetManagementService.normalizeLegacyDisabled(this.data.cabinetId, item.id))
        this.normalizingLegacyDisabled = false
        return this.loadCabinet()
      }
      const issues = unlockIssueService.getIssuesForCabinet(this.data.cabinetId)
      const maintenanceOrders = maintenanceWorkOrderService.listForManager('ACTIVE').filter(order => order.cabinetId === this.data.cabinetId)
      const lockers = lockerRepository.getLockers(this.data.cabinetId).map(item => ({
        ...item,
        number: String(item.id).padStart(2, '0'),
        statusLabel: item.status === 'EMPTY' ? '空闲' : item.status === 'OCCUPIED' ? '占用' : '维修中',
        doorText: formatDoorStatus(item.doorStatus, '柜门关闭'),
        issue: issues.find(issue => issue.lockerId === item.id && issue.status === 'REQUIRES_ONSITE_MAINTENANCE') || null,
        maintenanceOrder: maintenanceOrders.find(order => Number(order.lockerId) === item.id) || null,
        selfCheckPassed: Boolean(maintenanceOrders.find(order => Number(order.lockerId) === item.id && order.selfCheckPassedAt))
      }))
      return this.refreshLiveDoorStatuses(lockers).then(statuses => this.setData({
        cabinet: { ...cabinet, statusLabel: STATUS_LABELS[cabinet.status] || cabinet.status },
        ...cabinetBleStatusService.getDisplay(this.data.cabinetId, cabinet.lastBleSeenAt),
        lastBleSeenAt: cabinet.lastBleSeenAt || null,
        cabinetOrder: maintenanceOrders.find(order => order.type === 'CABINET') || null,
        lockers: this.mergeLiveDoorStatuses(lockers, statuses),
        waitingPickupCount: cabinetRepository.getWaitingPickupCount(this.data.cabinetId),
        dataConsistencyIssues: cabinetConsistencyService.inspect(lockers, cabinetRepository.getRecords(this.data.cabinetId))
      }))
    } catch (error) { wx.showToast({ title: '柜体不存在', icon: 'none' }) }
  },
  copyScene() {
    wx.setClipboardData({ data: this.data.cabinetId })
  },
  setMaintenance() {
    wx.showModal({
      title: '设置整柜维修',
      content: '设置后用户扫码将无法进入业务，也不会连接BLE；之后必须等待整柜设备自检成功，管理员才能恢复使用。确认继续吗？',
      success: result => {
        if (!result.confirm) return
        let operation
        try { operation = cabinetManagementService.setMaintenance(this.data.cabinetId) } catch (error) { operation = Promise.reject(error) }
        Promise.resolve(operation).then(() => { getApp().deactivateCurrentCabinet(this.data.cabinetId); this.loadCabinet() }).catch(() => wx.showToast({ title: '操作失败', icon: 'none' }))
      }
    })
  },
  restoreCabinet() {
    let operation
    try { operation = cabinetManagementService.restoreCabinet(this.data.cabinetId) } catch (error) { operation = Promise.reject(error) }
    Promise.resolve(operation).then(() => { this.loadCabinet(); wx.showToast({ title: '柜体已恢复', icon: 'success' }) }).catch(error => {
      const title = {
        CABINET_HARDWARE_FAULT_ACTIVE: '整柜维修尚未完成',
        MAINTENANCE_SELF_CHECK_REQUIRED: 'ESP自检尚未通过',
        MAINTENANCE_INSPECTION_REQUIRED: '现场四项检查未通过',
        CABINET_DISABLED: '旧状态正在转换，请刷新后重试'
      }[error.message] || '暂时无法恢复'
      wx.showToast({ title, icon: 'none' })
    })
  },
  setLockerMaintenance(event) {
    const lockerId = Number(event.currentTarget.dataset.id)
    wx.showModal({
      title: `设置 ${String(lockerId).padStart(2, '0')}号柜维修`,
      content: '设置后该柜格不能进行新的存取操作；之后必须等待设备自检成功，管理员才能恢复使用。确认继续吗？',
      success: result => {
        if (!result.confirm) return
        let operation
        try { operation = deviceHealthService.setManualMaintenance(this.data.cabinetId, lockerId) } catch (error) { operation = Promise.reject(error) }
        Promise.resolve(operation).then(() => this.loadCabinet()).catch(error => {
          wx.showToast({ title: error.message === 'LOCKER_OCCUPIED' ? '占用柜格不能维修' : '操作失败', icon: 'none' })
        })
      }
    })
  },
  restoreLocker(event) {
    const lockerId = Number(event.currentTarget.dataset.id)
    let operation
    try {
      const lockerBeforeRestore = this.data.lockers.find(item => item.id === lockerId)
      operation = deviceHealthService.restoreLocker(this.data.cabinetId, lockerId)
      if (!USE_CLOUD && lockerBeforeRestore && lockerBeforeRestore.issue) unlockIssueService.resolve(lockerBeforeRestore.issue.recordId)
    } catch (error) { operation = Promise.reject(error) }
    Promise.resolve(operation).then(() => {
      this.loadCabinet()
      wx.showToast({ title: '柜格已恢复', icon: 'success' })
    }).catch(error => {
      const title = {
        HARDWARE_FAULT_ACTIVE: '维修尚未完成',
        MAINTENANCE_SELF_CHECK_REQUIRED: 'ESP自检尚未通过',
        MAINTENANCE_INSPECTION_REQUIRED: '现场四项检查未通过'
      }[error.message] || '恢复失败'
      wx.showToast({ title, icon: 'none' })
    })
  },
  correctLockerStatus(event) {
    const lockerId = Number(event.currentTarget.dataset.id)
    const targetStatus = String(event.currentTarget.dataset.status || '').toUpperCase()
    const targetLabel = targetStatus === 'EMPTY' ? '空闲' : '占用'
    const content = targetStatus === 'EMPTY'
      ? '仅当该柜格没有未取餐记录时才会成功，并会清理残留的订单关联。确认校正吗？'
      : '仅当该柜格存在真实未取餐记录时才会成功，并自动重新绑定该记录。确认校正吗？'
    wx.showModal({
      title: `校正 ${String(lockerId).padStart(2, '0')}号柜为${targetLabel}`,
      content,
      confirmText: '确认校正',
      confirmColor: '#C03338',
      success: result => {
        if (!result.confirm) return
        let operation
        try { operation = cabinetManagementService.correctLockerBusinessStatus(this.data.cabinetId, lockerId, targetStatus) } catch (error) { operation = Promise.reject(error) }
        Promise.resolve(operation).then(() => {
          this.loadCabinet()
          wx.showToast({ title: `已校正为${targetLabel}`, icon: 'success' })
        }).catch(error => {
          const messages = {
            LOCKER_HAS_WAITING_PICKUP: '仍有未取餐记录，不能设为空闲',
            LOCKER_WAITING_RECORD_REQUIRED: '没有未取餐记录，不能设为占用',
            LOCKER_MULTIPLE_WAITING_RECORDS: '存在多条未取餐记录，请先核查',
            LOCKER_IN_MAINTENANCE: '维修中的柜格请先完成恢复'
          }
          wx.showToast({ title: messages[error.message] || '状态校正失败', icon: 'none' })
        })
      }
    })
  },
  inspectOccupiedLocker(event) {
    if (this.data.processingLockerId) return
    if (!this.data.cabinet || this.data.cabinet.status !== 'ACTIVE') return wx.showToast({ title: '整柜当前不可操作', icon: 'none' })
    const lockerId = Number(event.currentTarget.dataset.id)
    const locker = this.data.lockers.find(item => Number(item.id) === lockerId)
    if (!locker || locker.status !== 'OCCUPIED') return wx.showToast({ title: '该柜格已不是占用状态', icon: 'none' })
    wx.showModal({
      title: `开柜核查 ${locker.number}号柜`,
      content: '系统将先打开占用柜格。请管理员现场检查柜内是否确实为空；如果仍有物品，必须保持占用，不得设为空闲。',
      confirmText: '确认开柜',
      confirmColor: '#C03338',
      success: result => {
        if (!result.confirm) return
        this.setData({ processingLockerId: lockerId })
        occupiedLockerClearService.openForInspection(this.data.cabinetId, lockerId).then(openResult => {
          this.setData({ processingLockerId: 0 })
          wx.showModal({
            title: `${locker.number}号柜已打开`,
            content: '请现场检查柜内。只有确认柜内完全没有外卖或其他物品时，才能设为空闲。',
            cancelText: '仍有物品',
            confirmText: '确认空柜',
            confirmColor: '#C03338',
            success: confirmation => {
              if (!confirmation.confirm) {
                wx.showModal({ title: '继续保持占用', content: '系统未修改柜格和未取餐记录，请关好柜门。', showCancel: false })
                return
              }
              this.setData({ processingLockerId: lockerId })
              occupiedLockerClearService.confirmPhysicallyEmpty(this.data.cabinetId, lockerId, openResult.authorizationId).then(() => {
                this.setData({ processingLockerId: 0 })
                return this.loadCabinet()
              }).then(() => wx.showModal({ title: '已设为空闲', content: '原未取餐记录已标记为“管理员核空”。请确认柜门已经关好。', showCancel: false }))
                .catch(error => {
                  this.setData({ processingLockerId: 0 })
                  wx.showModal({ title: '设置空闲失败', content: occupiedLockerClearService.getErrorMessage(error), showCancel: false })
                })
            }
          })
        }).catch(error => {
          this.setData({ processingLockerId: 0 })
          wx.showModal({ title: '开柜失败', content: occupiedLockerClearService.getErrorMessage(error), showCancel: false })
        })
      }
    })
  },
  viewLockerMaintenanceOrder(event) {
    const lockerId = Number(event.currentTarget.dataset.id)
    const locker = this.data.lockers.find(item => item.id === lockerId)
    if (!locker || !locker.maintenanceOrder) return wx.showToast({ title: '未找到维修工单', icon: 'none' })
    wx.navigateTo({ url: `/pages/maintenance-order-detail/maintenance-order-detail?orderId=${encodeURIComponent(locker.maintenanceOrder.id)}` })
  },
  viewCabinetMaintenanceOrder() {
    if (!this.data.cabinetOrder) return
    wx.navigateTo({ url: `/pages/maintenance-order-detail/maintenance-order-detail?orderId=${encodeURIComponent(this.data.cabinetOrder.id)}` })
  },
  viewWaitingRecords() { wx.navigateTo({ url: `/pages/deposit-records/deposit-records?status=WAITING_PICKUP&cabinetId=${encodeURIComponent(this.data.cabinetId)}` }) },
  viewLogs() { wx.navigateTo({ url: `/pages/operation-logs/operation-logs?cabinetId=${encodeURIComponent(this.data.cabinetId)}` }) }
})

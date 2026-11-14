const permissionGuard = require('../../services/permissionGuard')
const maintenanceWorkOrderService = require('../../services/maintenanceWorkOrderService')
const unlockIssueService = require('../../services/unlockIssueService')
const deviceHealthService = require('../../services/deviceHealthService')
const cabinetManagementService = require('../../services/cabinetManagementService')
const maintenanceDiagnosticService = require('../../services/maintenanceDiagnosticService')
const { CHECK_ITEM_LABELS } = require('../../constants/maintenanceChecks')
const { formatMonthDayTime } = require('../../utils/dateFormatter')

const CHECK_VALUES = ['NOT_CHECKED', 'NORMAL', 'ABNORMAL']
const CHECK_LABELS = ['未检查', '正常', '异常']
const STATUS_LABELS = { PENDING: '待接单', IN_PROGRESS: '处理中', ONSITE: '已到场', MANUAL_UNLOCK_COMPLETED: '已机械开锁', SELF_CHECK_PASSED: '自检通过', RESOLVED: '已完成' }

Page({
  data: {
    authorized: false, orderId: '', order: null, checkLabels: CHECK_LABELS, checkItemLabels: CHECK_ITEM_LABELS,
    inspection: {}, inspectionIndexes: {}, inspectionNotes: '', canInspect: false, canRestore: false, restoreHint: '', selfCheckRunning: false
  },
  onLoad(options) {
    this.setData({ orderId: options.orderId ? decodeURIComponent(options.orderId) : '' })
    permissionGuard.requireAccess({ roles: permissionGuard.MANAGEMENT_ROLES }).then(() => { this.setData({ authorized: true }); this.loadOrder() }).catch(() => {})
  },
  onShow() { if (this.data.authorized) this.loadOrder() },
  async loadOrder() {
    try {
      const raw = await maintenanceWorkOrderService.getForManager(this.data.orderId)
      const inspection = raw.inspection || {}
      const inspectionIndexes = {}
      maintenanceWorkOrderService.CHECK_KEYS.forEach(key => { inspectionIndexes[key] = Math.max(0, CHECK_VALUES.indexOf(inspection[key])) })
      const inspectionPassed = maintenanceWorkOrderService.inspectionPassed(raw)
      const workflowReady = raw.status !== 'RESOLVED' && raw.status !== 'PENDING'
      const selfCheckPassed = Boolean(raw.selfCheckPassedAt)
      const inspectionRequired = raw.requiresInspection === true
      const handoverCompleted = !raw.recordId || !raw.issueId || Boolean(raw.manualUnlockCompletedAt)
      const canRestore = workflowReady && selfCheckPassed && (!inspectionRequired || inspectionPassed) && handoverCompleted
      const missingConditions = []
      if (!workflowReady) missingConditions.push('请先开始处理工单')
      if (!selfCheckPassed) missingConditions.push('等待设备自检通过')
      if (inspectionRequired && !inspectionPassed) missingConditions.push('请将现场四项检查全部设为正常并保存')
      if (!handoverCompleted) missingConditions.push('请先记录现场应急开锁并完成外卖交付')
      this.setData({
        order: {
          ...raw,
          inspectionRequired,
          targetLabel: raw.type === 'CABINET' ? '整台柜体' : `${String(raw.lockerId).padStart(2, '0')}号柜`,
          statusLabel: STATUS_LABELS[raw.status] || raw.status,
          createdTime: this.formatDateTime(raw.createdAt), startedTime: this.formatDateTime(raw.startedAt), arrivedTime: this.formatDateTime(raw.arrivedAt),
          manualUnlockTime: this.formatDateTime(raw.manualUnlockCompletedAt), selfCheckTime: this.formatDateTime(raw.selfCheckPassedAt), resolvedTime: this.formatDateTime(raw.resolvedAt)
        },
        inspection, inspectionIndexes, inspectionNotes: raw.inspectionNotes || '',
        canInspect: ['ONSITE', 'MANUAL_UNLOCK_COMPLETED', 'SELF_CHECK_PASSED'].includes(raw.status),
        canRestore,
        restoreHint: missingConditions.join('；')
      })
    } catch (error) { wx.showToast({ title: '维修工单不存在', icon: 'none' }) }
  },
  async startOrder() { try { await maintenanceWorkOrderService.start(this.data.orderId); await this.loadOrder(); wx.showToast({ title: '已开始处理', icon: 'success' }) } catch (error) { wx.showToast({ title: '无法接单', icon: 'none' }) } },
  async arriveOnsite() { try { await maintenanceWorkOrderService.arrive(this.data.orderId); await this.loadOrder(); wx.showToast({ title: '已记录到场', icon: 'success' }) } catch (error) { wx.showToast({ title: '无法记录到场', icon: 'none' }) } },
  chooseInspection(event) {
    const key = event.currentTarget.dataset.key
    const index = Number(event.detail.value)
    this.setData({ [`inspection.${key}`]: CHECK_VALUES[index], [`inspectionIndexes.${key}`]: index })
  },
  inputNotes(event) { this.setData({ inspectionNotes: String(event.detail.value || '').slice(0, 500) }) },
  async saveInspection() {
    try { await maintenanceWorkOrderService.saveInspection(this.data.orderId, this.data.inspection, this.data.inspectionNotes); await this.loadOrder(); wx.showToast({ title: '检查结果已保存', icon: 'success' }) }
    catch (error) { wx.showToast({ title: '保存失败', icon: 'none' }) }
  },
  async runSelfCheck() {
    if (this.data.selfCheckRunning || !this.data.order) return
    this.setData({ selfCheckRunning: true })
    wx.showLoading({ title: '设备自检中', mask: true })
    try {
      await maintenanceDiagnosticService.runLockerSelfCheck(this.data.order.id, {
        onOpened: () => wx.showLoading({ title: '已开锁，请手动关门', mask: true })
      })
      await this.loadOrder()
      wx.showToast({ title: '自检通过，请恢复使用', icon: 'success' })
    } catch (error) {
      const messages = {
        MAINTENANCE_DOOR_MUST_BE_CLOSED: '请先把柜门扣紧后再自检',
        MAINTENANCE_DOOR_STATUS_TIMEOUT: '等待柜门关闭超时',
        MAINTENANCE_OPEN_FEEDBACK_REQUIRED: '未收到电子锁成功反馈',
        MAINTENANCE_DIAGNOSTIC_REQUIRES_BLE: '当前未启用实体 BLE',
        BLE_NOT_IDENTIFIED: '柜体身份验证未通过',
        BLE_NOT_READY: '蓝牙尚未准备好',
        BLE_LOCKER_OPEN_FAILED: '实体锁开锁失败',
        MAINTENANCE_ORDER_NOT_ONSITE: '请先确认维修人员已到场',
        MAINTENANCE_SELF_CHECK_IN_PROGRESS: '自检正在进行中'
      }
      wx.showToast({ title: messages[error.message] || `自检失败：${error.message || '未知错误'}`, icon: 'none', duration: 2600 })
    } finally {
      wx.hideLoading()
      this.setData({ selfCheckRunning: false })
    }
  },
  recordManualUnlock() {
    const order = this.data.order
    wx.showModal({
      title: '确认现场机械开锁完成',
      content: '仅在维修人员已实际打开柜门并将外卖交付给用户后确认。柜格仍会保持维修中。',
      confirmText: '确认完成', confirmColor: '#C03338',
      success: async result => {
        if (!result.confirm) return
        try {
          const { USE_CLOUD } = require('../../config/env')
          if (!USE_CLOUD) unlockIssueService.recordManualEmergencyUnlock(order.cabinetId, order.lockerId)
          await maintenanceWorkOrderService.markManualUnlockCompleted(order.id)
          await this.loadOrder()
          wx.showToast({ title: '已记录机械开锁', icon: 'success' })
        } catch (error) { wx.showToast({ title: '机械开锁记录失败', icon: 'none' }) }
      }
    })
  },
  restoreTarget() {
    const order = this.data.order
    wx.showModal({
      title: '确认恢复使用',
      content: order.inspectionRequired ? '系统将再次检查设备自检和现场四项检查结果。通过后才会恢复使用并完成工单。' : '系统将再次确认设备自检已经通过。通过后才会恢复使用并完成工单。',
      confirmText: '确认恢复', confirmColor: '#C03338',
      success: async result => {
        if (!result.confirm) return
        try {
          if (order.type === 'CABINET') await cabinetManagementService.restoreCabinet(order.cabinetId)
          else await deviceHealthService.restoreLocker(order.cabinetId, order.lockerId)
          if (order.type !== 'CABINET') {
            try { await require('../../repositories/cabinetRepository').loadCabinet(order.cabinetId) } catch (error) {}
          }
          await this.loadOrder()
          wx.showModal({ title: '已恢复使用', content: '设备已恢复，维修工单已完成。', showCancel: false })
        } catch (error) {
          const messages = { MAINTENANCE_SELF_CHECK_REQUIRED: '设备自检尚未通过', MAINTENANCE_INSPECTION_REQUIRED: '四项检查尚未全部正常', EMERGENCY_PICKUP_HANDOVER_REQUIRED: '请先完成现场应急开锁和外卖交付', HARDWARE_FAULT_ACTIVE: '维修尚未完成', CABINET_HARDWARE_FAULT_ACTIVE: '整柜维修尚未完成' }
          wx.showToast({ title: messages[error.message] || '暂时无法恢复', icon: 'none' })
        }
      }
    })
  },
  formatDateTime(iso) {
    return formatMonthDayTime(iso, '—')
  }
})

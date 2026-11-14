const feedbackManagementService = require('../../services/feedbackManagementService')
const emergencyUnlockService = require('../../services/emergencyUnlockService')
const permissionGuard = require('../../services/permissionGuard')
const emergencySupportRequestService = require('../../services/emergencySupportRequestService')
const unlockAuthorizationService = require('../../services/unlockAuthorizationService')
const { USE_CLOUD } = require('../../config/env')

const PROBLEM_LABELS = {
  LOCK_FAILED: '柜门无法打开', CODE_ERROR: '取餐码错误', FOOD_MISSING: '外卖缺失',
  LOCKER_DAMAGED: '柜格损坏', DEVICE_OFFLINE: '设备离线', OTHER: '其他问题'
}
const STATUS_LABELS = { PENDING: '待处理', PROCESSING: '处理中', RESOLVED: '已处理' }

Page({
  data: {
    authorized: false, supportRequests: [], supportFilter: 'ACTIVE', cabinets: [], visibleCabinets: [], cabinetQuery: '',
    bindingRequestId: '', bindingCabinets: [], bindingCabinetLabels: [], bindingCabinetIndex: -1, bindingLockers: [], bindingLockerLabels: [], bindingLockerIndex: -1,
    feedbackList: [], visibleList: [], filter: 'OPEN', openCount: 0, resolvedCount: 0,
    traceUserId: '', traceRegistrationNumber: ''
  },
  onLoad() {
    permissionGuard.requireAccess({ roles: permissionGuard.CUSTOMER_SERVICE_ROLES }).then(() => {
      this.setData({ authorized: true })
      this.loadSupportRequests()
      this.loadCabinets()
      this.loadFeedback()
    }).catch(() => {})
  },
  onShow() { if (this.data.authorized) { this.loadSupportRequests(); this.loadCabinets(); this.loadFeedback() } },
  loadSupportRequests() {
    let result
    try {
      result = emergencySupportRequestService.listForStaff(this.data.supportFilter)
    } catch (error) { result = Promise.reject(error) }
    Promise.resolve(result).then(items => {
      const supportRequests = items.slice().sort((a, b) => new Date(b.updatedAt) - new Date(a.updatedAt)).map(item => ({
        ...item,
        cabinetLabel: item.cabinetId || '未识别柜体',
        lockerLabel: item.lockerId ? `${String(item.lockerId).padStart(2, '0')}号柜` : '待核实',
        activatedTime: this.formatDateTime(item.activatedAt || item.createdAt),
        statusLabel: {
          OPEN: !item.cabinetId || !item.lockerId ? '等待用户信息' : '待核验',
          VERIFYING: '核验中', AUTHORIZED: '已授权', REQUIRES_ONSITE_MAINTENANCE: '转现场维修',
          RESOLVED: '已解决', CANCELLED: '用户已取消', EXPIRED: '已过期'
        }[item.status] || item.status
      }))
      this.setData({ supportRequests })
    }).catch(() => this.setData({ supportRequests: [] }))
  },
  setSupportFilter(event) { this.setData({ supportFilter: event.currentTarget.dataset.filter }); this.loadSupportRequests() },
  handleSupportRequest(event) {
    const request = this.data.supportRequests.find(item => item.id === event.currentTarget.dataset.id)
    if (!request) return
    if (!request.cabinetId) return wx.showToast({ title: '请先让用户提供柜体编号', icon: 'none' })
    const params = [
      `cabinetId=${encodeURIComponent(request.cabinetId)}`,
      `customerUserId=${encodeURIComponent(request.userId)}`,
      `supportRequestId=${encodeURIComponent(request.id)}`
    ]
    if (request.lockerId) params.push(`lockerId=${request.lockerId}`)
    if (request.recordId) params.push(`recordId=${encodeURIComponent(request.recordId)}`)
    let start
    try { start = emergencySupportRequestService.startHandling(request.id) } catch (error) { start = Promise.reject(error) }
    Promise.resolve(start).then(() => wx.navigateTo({ url: `/pages/support-cabinet/support-cabinet?${params.join('&')}` }))
      .catch(() => wx.showToast({ title: '请求状态已变化，请刷新', icon: 'none' }))
  },
  beginBindSupportContext(event) {
    const request = this.data.supportRequests.find(item => item.id === event.currentTarget.dataset.id)
    if (!request) return
    const bindingCabinets = this.data.cabinets.filter(item => item.status !== 'DISABLED')
    let bindingCabinetIndex = request.cabinetId ? bindingCabinets.findIndex(item => item.id === request.cabinetId) : -1
    if (bindingCabinetIndex < 0 && bindingCabinets.length === 1) bindingCabinetIndex = 0
    this.setData({
      bindingRequestId: request.id,
      bindingCabinets,
      bindingCabinetLabels: bindingCabinets.map(item => `${item.id} · ${item.name}`),
      bindingCabinetIndex,
      bindingLockerIndex: -1,
      bindingLockers: [],
      bindingLockerLabels: []
    })
    if (bindingCabinetIndex >= 0) this.loadBindingLockers(bindingCabinets[bindingCabinetIndex].id, request.lockerId)
  },
  chooseBindingCabinet(event) {
    const bindingCabinetIndex = Number(event.detail.value)
    const cabinet = this.data.bindingCabinets[bindingCabinetIndex]
    this.setData({ bindingCabinetIndex, bindingLockerIndex: -1, bindingLockers: [], bindingLockerLabels: [] })
    if (cabinet) this.loadBindingLockers(cabinet.id)
  },
  loadBindingLockers(cabinetId, preferredLockerId = null) {
    let result
    try {
      result = emergencyUnlockService.getCabinetLockerOverview(cabinetId, { audit: false })
    } catch (error) { result = Promise.reject(error) }
    Promise.resolve(result).then(overview => {
      const bindingLockers = overview.lockers.filter(item => item.enabled !== false)
      const preferredIndex = preferredLockerId ? bindingLockers.findIndex(item => Number(item.id) === Number(preferredLockerId)) : -1
      this.setData({
        bindingLockers,
        bindingLockerLabels: bindingLockers.map(item => `${String(item.id).padStart(2, '0')}号柜${item.recordId ? ' · 有待取记录' : ''}`),
        bindingLockerIndex: preferredIndex
      })
    }).catch(() => wx.showToast({ title: '无法加载柜格', icon: 'none' }))
  },
  chooseBindingLocker(event) { this.setData({ bindingLockerIndex: Number(event.detail.value) }) },
  cancelBindSupportContext() { this.setData({ bindingRequestId: '', bindingCabinetIndex: -1, bindingLockerIndex: -1, bindingLockers: [], bindingLockerLabels: [] }) },
  confirmBindSupportContext() {
    const cabinet = this.data.bindingCabinets[this.data.bindingCabinetIndex]
    const locker = this.data.bindingLockers[this.data.bindingLockerIndex]
    if (!cabinet) return wx.showToast({ title: '请选择柜体', icon: 'none' })
    if (!locker) return wx.showToast({ title: '请选择柜格', icon: 'none' })
    let result
    try { result = emergencySupportRequestService.bindContextByStaff(this.data.bindingRequestId, { cabinetId: cabinet.id, lockerId: locker.id }) } catch (error) { result = Promise.reject(error) }
    Promise.resolve(result).then(request => {
      this.cancelBindSupportContext()
      this.loadSupportRequests()
      wx.showToast({ title: request.recordId ? '已关联待取记录' : '柜体信息已补录', icon: 'success' })
    }).catch(() => wx.showToast({ title: '补录失败，请重新选择', icon: 'none' }))
  },
  revokeSupportAuthorization(event) {
    const request = this.data.supportRequests.find(item => item.id === event.currentTarget.dataset.id)
    if (!request || !request.authorizationId) return
    wx.showModal({
      title: '撤销一次性授权',
      content: '撤销后用户不能再使用该授权，请重新核验后再签发。',
      confirmText: '确认撤销', confirmColor: '#C03338',
      success: modalResult => {
        if (!modalResult.confirm) return
        let operation
        try {
          if (!USE_CLOUD) unlockAuthorizationService.revokeByStaff(request.authorizationId, 'STAFF_RECHECK_REQUIRED')
          operation = emergencySupportRequestService.reopenAfterStaffRevocation(request.id)
        } catch (error) { operation = Promise.reject(error) }
        Promise.resolve(operation).then(() => {
          this.loadSupportRequests()
          wx.showToast({ title: '授权已撤销', icon: 'success' })
        }).catch(() => wx.showToast({ title: '授权无法撤销', icon: 'none' }))
      }
    })
  },
  closeSupportRequest(event) {
    const request = this.data.supportRequests.find(item => item.id === event.currentTarget.dataset.id)
    if (!request) return
    wx.showModal({
      title: '确认关闭紧急请求',
      content: '仅在问题已经解决或确认不再需要处理时关闭；尚未使用的开锁授权会同时撤销。',
      confirmText: '确认关闭', confirmColor: '#C03338',
      success: result => {
        if (!result.confirm) return
        let close
        try { close = emergencySupportRequestService.closeByStaff(request.id) } catch (error) { close = Promise.reject(error) }
        Promise.resolve(close).then(() => { this.loadSupportRequests(); wx.showToast({ title: '请求已关闭', icon: 'success' }) })
          .catch(() => wx.showToast({ title: '关闭失败', icon: 'none' }))
      }
    })
  },
  loadCabinets() {
    let result
    try {
      result = emergencyUnlockService.getSupportCabinets()
    } catch (error) { result = Promise.reject(error) }
    Promise.resolve(result).then(cabinets => {
      this.setData({ cabinets })
      this.applyCabinetSearch()
    }).catch(() => wx.showToast({ title: '无法加载柜体', icon: 'none' }))
  },
  inputCabinetQuery(event) {
    this.setData({ cabinetQuery: String(event.detail.value || '').trim() })
    this.applyCabinetSearch()
  },
  clearCabinetQuery() { this.setData({ cabinetQuery: '' }); this.applyCabinetSearch() },
  applyCabinetSearch() {
    const query = this.data.cabinetQuery.toLowerCase()
    const visibleCabinets = this.data.cabinets.filter(item => !query || [item.id, item.name, item.locationName].some(value => String(value || '').toLowerCase().includes(query)))
    this.setData({ visibleCabinets })
  },
  loadFeedback() {
    let result
    try {
      result = feedbackManagementService.getFeedbackList()
    } catch (error) { result = Promise.reject(error) }
    Promise.resolve(result).then(items => {
      const feedbackList = items
        .slice()
        .sort((a, b) => new Date(b.createdAt) - new Date(a.createdAt))
        .map(item => ({
          ...item,
          problemLabel: PROBLEM_LABELS[item.problemType] || '其他问题',
          statusLabel: STATUS_LABELS[item.status] || item.status,
          lockerLabel: item.lockerId ? `${String(item.lockerId).padStart(2, '0')}号柜` : '未填写',
          descriptionText: item.description || '未填写问题描述',
          createdTime: this.formatDateTime(item.createdAt)
        }))
      this.setData({
        feedbackList,
        openCount: feedbackList.filter(item => item.status !== 'RESOLVED').length,
        resolvedCount: feedbackList.filter(item => item.status === 'RESOLVED').length
      })
      this.applyFilter()
    }).catch(() => wx.showToast({ title: '当前账号无查看权限', icon: 'none' }))
  },
  setFilter(event) { this.setData({ filter: event.currentTarget.dataset.filter }); this.applyFilter() },
  applyFilter() {
    const visibleList = this.data.feedbackList.filter(item => {
      if (this.data.filter === 'OPEN') return item.status !== 'RESOLVED'
      if (this.data.filter === 'RESOLVED') return item.status === 'RESOLVED'
      return true
    })
    this.setData({ visibleList })
  },
  updateStatus(event) {
    const feedbackId = event.currentTarget.dataset.id
    const status = event.currentTarget.dataset.status
    let result
    try { result = feedbackManagementService.updateStatus(feedbackId, status) } catch (error) { result = Promise.reject(error) }
    Promise.resolve(result).then(() => {
      this.loadFeedback()
      wx.showToast({ title: status === 'PROCESSING' ? '已开始处理' : '已标记处理完成', icon: 'success' })
    }).catch(() => wx.showToast({ title: '更新失败', icon: 'none' }))
  },
  viewCabinet(event) { wx.navigateTo({ url: `/pages/support-cabinet/support-cabinet?cabinetId=${encodeURIComponent(event.currentTarget.dataset.id)}` }) },
  inputTraceUserId(event) { this.setData({ traceUserId: String(event.detail.value || '').trim() }) },
  inputTraceRegistrationNumber(event) { this.setData({ traceRegistrationNumber: String(event.detail.value || '').replace(/\D/g, '').slice(0, 20) }) },
  viewUserOperationTrace() {
    const userId = this.data.traceUserId
    const registrationNumber = this.data.traceRegistrationNumber
    if (!userId && !registrationNumber) return wx.showToast({ title: '请填写用户 ID 或注册编号', icon: 'none' })
    const params = []
    if (userId) params.push(`userId=${encodeURIComponent(userId)}`)
    if (registrationNumber) params.push(`registrationNumber=${encodeURIComponent(registrationNumber)}`)
    wx.navigateTo({ url: `/pages/operation-logs/operation-logs?${params.join('&')}` })
  },
  viewOperationTrace(event) {
    const feedback = this.data.feedbackList.find(item => item.id === event.currentTarget.dataset.id)
    if (!feedback) return
    const params = [`userId=${encodeURIComponent(feedback.userId)}`, `cabinetId=${encodeURIComponent(feedback.cabinetId)}`]
    if (feedback.lockerId) params.push(`lockerId=${feedback.lockerId}`)
    wx.navigateTo({ url: `/pages/operation-logs/operation-logs?${params.join('&')}` })
  },
  formatDateTime(iso) {
    const date = new Date(iso)
    return `${String(date.getMonth() + 1).padStart(2, '0')}-${String(date.getDate()).padStart(2, '0')} ${String(date.getHours()).padStart(2, '0')}:${String(date.getMinutes()).padStart(2, '0')}`
  }
})

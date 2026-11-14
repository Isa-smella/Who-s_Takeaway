const operationLogService = require('../../services/operationLogService')
const ACTIONS = require('../../constants/operationActions')
const cabinetMonitoringService = require('../../services/cabinetMonitoringService')
const permissionGuard = require('../../services/permissionGuard')
const { normalizeCabinetId } = require('../../utils/idNormalizer')

const ACTION_LABELS = {
  LOGIN_SUCCESS: '登录成功',
  LOGIN_FAILED: '登录失败',
  LOGOUT: '退出登录',
  PRIVACY_AGREED: '同意用户协议与隐私政策',
  PROFILE_UPDATED: '修改账号名',
  SCAN_CABINET: '扫描柜体二维码',
  SWITCH_CABINET: '切换柜体',
  BLE_CONNECT_START: '开始连接柜体蓝牙',
  BLE_DISCONNECTED: '断开柜体蓝牙',
  UNLOCK_AUTHORIZATION_CREATED: '签发一次性开锁授权',
  UNLOCK_AUTHORIZATION_REJECTED: '拒绝开锁授权',
  LOCKER_FAULT_DETECTED: '检测到硬件故障',
  LOCKER_HEALTH_CHECK_PASSED: '设备自检通过',
  LOCKER_RESTORE_REJECTED: '恢复使用被拒绝',
  LOCKER_SET_MAINTENANCE: '设置维修状态',
  LOCKER_RESTORE: '恢复柜格使用',
  DOOR_OPEN: '柜门打开',
  DOOR_CLOSED: '柜门关闭',
  BLE_CONNECT_SUCCESS: '蓝牙连接成功',
  BLE_CONNECT_FAILED: '蓝牙连接失败',
  USER_SELECT_STORE_LOCKER: '用户选择存餐柜格',
  USER_OPEN_STORE_LOCK: '存餐开柜',
  USER_REOPEN_STORE_LOCK: '存入后重新开柜',
  USER_CONFIRM_DEPOSIT: '用户确认存入',
  USER_COPY_PICKUP_INFO: '用户复制取餐信息',
  USER_ENTER_PICKUP_CODE: '用户输入取餐码',
  USER_PICKUP_VERIFY_SUCCESS: '用户取餐码验证成功',
  USER_PICKUP_VERIFY_FAILED: '用户取餐码验证失败',
  USER_OPEN_PICKUP_LOCK: '用户取餐开柜',
  USER_PICKUP_SUCCESS: '用户取餐成功',
  STORE_CONFIRM_RETRY_REQUIRED: '存餐确认需要重试',
  STORE_CONFIRM_REQUIRES_MAINTENANCE: '存餐确认转维修',
  EMERGENCY_UNLOCK_CONNECT: '紧急开柜连接柜体',
  EMERGENCY_PICKUP_CODES_VIEWED: '客服查看柜格取餐码',
  EMERGENCY_PICKUP_CODE_VERIFIED: '客服取餐码核对成功',
  EMERGENCY_PICKUP_CODE_FAILED: '客服取餐码核对失败',
  EMERGENCY_UNLOCK_REQUESTED: '发起紧急开柜',
  EMERGENCY_UNLOCK_SUCCESS: '紧急开柜成功',
  EMERGENCY_UNLOCK_FAILED: '紧急开柜失败',
  EMERGENCY_PICKUP_COMPLETED: '客服协助取餐完成',
  EMERGENCY_PICKUP_COMPLETE_FAILED: '客服协助取餐状态更新失败',
  RIDER_SELECT_LOCKER: '骑手选择存餐柜格（历史操作）',
  RIDER_OPEN_LOCK: '骑手存餐开柜（历史操作）',
  RIDER_REOPEN_LOCK: '骑手重新开柜（历史操作）',
  RIDER_CONFIRM_DEPOSIT: '确认存入',
  RIDER_COPY_PICKUP_INFO: '骑手复制取餐信息（历史操作）',
  CUSTOMER_ENTER_PICKUP_CODE: '取餐用户输入取餐码（历史操作）',
  CUSTOMER_PICKUP_VERIFY_SUCCESS: '取餐码验证成功（历史操作）',
  CUSTOMER_PICKUP_VERIFY_FAILED: '取餐码验证失败（历史操作）',
  CUSTOMER_OPEN_LOCK: '取餐用户开柜（历史操作）',
  CUSTOMER_PICKUP_SUCCESS: '取餐成功',
  CUSTOMER_SERVICE_UNLOCK_AUTH_CREATED: '客服签发一次性开锁授权',
  CUSTOMER_SERVICE_UNLOCK_ATTEMPT: '用户执行客服开锁授权',
  CUSTOMER_SERVICE_UNLOCK_SUCCESS: '客服授权开锁成功',
  CUSTOMER_SERVICE_UNLOCK_FAILED: '客服授权开锁失败',
  UNLOCK_REQUIRES_ONSITE_MAINTENANCE: '转为现场维修处理',
  MANUAL_EMERGENCY_UNLOCK: '现场机械应急开锁完成',
  EMERGENCY_SUPPORT_REQUEST_OPENED: '用户发起紧急客服请求',
  EMERGENCY_SUPPORT_REQUEST_AUTHORIZED: '紧急客服请求已授权',
  EMERGENCY_SUPPORT_REQUEST_PROCESSING: '客服开始核验请求',
  EMERGENCY_SUPPORT_REQUEST_CANCELLED: '用户取消紧急请求',
  EMERGENCY_SUPPORT_REQUEST_RESOLVED: '紧急客服请求已解决',
  EMERGENCY_SUPPORT_REQUEST_ONSITE: '紧急请求转现场维修',
  EMERGENCY_SUPPORT_REQUEST_CONTEXT_UPDATED: '补充紧急请求柜体信息',
  UNLOCK_AUTHORIZATION_REVOKED_BY_USER: '用户放弃一次性授权',
  UNLOCK_AUTHORIZATION_REVOKED_BY_STAFF: '客服撤销一次性授权',
  UNLOCK_AUTHORIZATION_AUTO_REVOKED: '一次性授权自动失效',
  MAINTENANCE_ORDER_CREATED: '创建维修工单',
  MAINTENANCE_ORDER_STARTED: '维修工单开始处理',
  MAINTENANCE_ORDER_ARRIVED: '维修人员到场',
  MAINTENANCE_ORDER_INSPECTION_SAVED: '保存现场检查结果',
  MAINTENANCE_ORDER_MANUAL_UNLOCK: '工单记录机械开锁',
  MAINTENANCE_ORDER_SELF_CHECK_PASSED: '工单设备自检通过',
  MAINTENANCE_ORDER_RESOLVED: '维修工单完成',
  LOCK_OPEN_SUCCESS: '柜锁打开成功',
  LOCK_OPEN_FAILED: '柜锁打开失败',
  FEEDBACK_CREATED: '提交问题反馈',
  FEEDBACK_UPDATED: '更新问题反馈',
  CABINET_CREATED: '新增柜体',
  CABINET_UPDATED: '修改柜体',
  CABINET_SET_MAINTENANCE: '设置整柜维修',
  CABINET_RESTORED: '恢复整柜使用',
  CABINET_DISABLED: '设为整柜维修（历史操作）',
  CABINET_REENABLED: '转入整柜维修（历史操作）',
  CABINET_FAULT_DETECTED: '检测到整柜故障',
  CABINET_HEALTH_CHECK_PASSED: '整柜控制器自检通过',
  CABINET_RESTORE_REJECTED: '整柜恢复被拒绝',
  LOCKER_ADDED: '新增柜格',
  LOCKER_DISABLED: '设为维修（历史操作）',
  LOCKER_REENABLED: '转入维修（历史操作）',
  LOCKER_BUSINESS_STATUS_CORRECTED: '校正柜格状态',
  ADMIN_OPEN_OCCUPIED_LOCKER: '管理员开柜核空',
  ADMIN_CLEAR_OCCUPIED_LOCKER: '管理员确认空柜并设为空闲',
  ANNOUNCEMENT_CREATED: '创建公告',
  ANNOUNCEMENT_UPDATED: '修改公告',
  ANNOUNCEMENT_STATUS_CHANGED: '变更公告状态',
  ANNOUNCEMENT_DELETED: '删除公告'
}
const ACTION_OPTIONS = [{ value: '', label: '全部操作' }].concat(Object.values(ACTIONS).map(value => ({ value, label: ACTION_LABELS[value] || '其他操作' })))
const RESULT_OPTIONS = [{ value: '', label: '全部结果' }, { value: 'SUCCESS', label: '成功' }, { value: 'FAILED', label: '失败' }]

Page({
  data: {
    authorized: false, currentCabinetId: '', selectedCabinetId: '', userId: '', registrationNumber: '', lockerId: '', scope: 'ALL', logs: [],
    canSelectCabinets: false, cabinetOptions: [{ id: '', label: '全部柜体' }], cabinetIndex: 0, cabinetOptionsLoaded: false, cabinetOptionsLoading: false,
    actionOptions: ACTION_OPTIONS, actionIndex: 0, resultOptions: RESULT_OPTIONS, resultIndex: 0,
    startDate: '', endDate: '', showActionSelector: false, actionKeyword: '', filteredActionOptions: ACTION_OPTIONS
  },
  onLoad(options = {}) {
    this.unloaded = false
    this.routeCabinetId = normalizeCabinetId(options.cabinetId ? decodeURIComponent(options.cabinetId) : '')
    const canSelectCabinets = this.canQueryAllCabinets()
    this.setData({
      currentCabinetId: this.getContextCabinetId(),
      canSelectCabinets,
      userId: options.userId ? decodeURIComponent(options.userId) : '',
      registrationNumber: options.registrationNumber ? decodeURIComponent(options.registrationNumber) : '',
      lockerId: options.lockerId ? String(options.lockerId).replace(/\D/g, '') : '',
      scope: this.routeCabinetId ? 'CABINET' : 'ALL'
    })
    if (this.data.scope === 'ALL' && canSelectCabinets) this.loadCabinetOptions()
    return this.loadLogs()
  },
  onShow() {
    if (!this.data.authorized) return
    const canSelectCabinets = this.canQueryAllCabinets()
    this.setData({ currentCabinetId: this.getContextCabinetId(), canSelectCabinets })
    if (this.data.scope === 'ALL' && canSelectCabinets) this.loadCabinetOptions()
    return this.loadLogs()
  },
  onUnload() { this.unloaded = true; this.logsRequestId = (this.logsRequestId || 0) + 1 },
  getContextCabinetId() {
    const app = getApp()
    // 详情页传入的柜体仍是该页上下文；未传入时才使用已激活柜体。
    return this.routeCabinetId || normalizeCabinetId(app && app.globalData && app.globalData.currentCabinetId)
  },
  canQueryAllCabinets() {
    try { permissionGuard.assertRole(permissionGuard.MANAGEMENT_ROLES); return true } catch (error) { return false }
  },
  loadCabinetOptions() {
    if (!this.canQueryAllCabinets()) return Promise.resolve([])
    if (this.data.cabinetOptionsLoaded) return Promise.resolve(this.data.cabinetOptions)
    if (this.cabinetOptionsPromise) return this.cabinetOptionsPromise
    this.setData({ cabinetOptionsLoading: true })
    this.cabinetOptionsPromise = Promise.resolve().then(() => cabinetMonitoringService.getCabinetOverview()).then(overview => {
      if (this.unloaded) return []
      const ids = [...new Set((overview.cabinets || []).map(item => normalizeCabinetId(item && (item.id || item._id))).filter(Boolean))].sort()
      const cabinetOptions = [{ id: '', label: '全部柜体' }].concat(ids.map(id => ({ id, label: id })))
      const cabinetIndex = Math.max(0, cabinetOptions.findIndex(item => item.id === this.data.selectedCabinetId))
      this.setData({ cabinetOptions, cabinetIndex, selectedCabinetId: cabinetOptions[cabinetIndex].id, cabinetOptionsLoaded: true })
      return cabinetOptions
    }).catch(() => {
      if (!this.unloaded) wx.showToast({ title: '柜体列表加载失败，请重试', icon: 'none' })
      return []
    }).finally(() => {
      this.cabinetOptionsPromise = null
      if (!this.unloaded) this.setData({ cabinetOptionsLoading: false })
    })
    return this.cabinetOptionsPromise
  },
  setScope(event) {
    if (!this.canQueryAllCabinets()) return
    const scope = event.currentTarget.dataset.scope
    if (!['CABINET', 'ALL'].includes(scope) || scope === this.data.scope) return
    this.setData({ scope, currentCabinetId: this.getContextCabinetId(), selectedCabinetId: '', cabinetIndex: 0 })
    if (scope === 'ALL') this.loadCabinetOptions()
    return this.loadLogs()
  },
  chooseCabinet(event) {
    if (this.data.scope !== 'ALL' || !this.canQueryAllCabinets()) return
    const cabinetIndex = Number(event.detail.value)
    if (!Number.isInteger(cabinetIndex) || !this.data.cabinetOptions[cabinetIndex]) return
    this.setData({ cabinetIndex, selectedCabinetId: this.data.cabinetOptions[cabinetIndex].id })
  },
  inputUser(event) { this.setData({ userId: String(event.detail.value || '').trim() }) },
  inputRegistrationNumber(event) { this.setData({ registrationNumber: String(event.detail.value || '').replace(/\D/g, '').slice(0, 20) }) },
  inputLocker(event) { this.setData({ lockerId: String(event.detail.value || '').replace(/\D/g, '').slice(0, 3) }) },
  openActionSelector() {
    this.setData({ showActionSelector: true, actionKeyword: '', filteredActionOptions: this.data.actionOptions })
  },
  closeActionSelector() { this.setData({ showActionSelector: false, actionKeyword: '' }) },
  blockSelectorEvent() {},
  inputActionKeyword(event) {
    const actionKeyword = String(event.detail.value || '').trim()
    const filteredActionOptions = this.data.actionOptions.filter(item => !actionKeyword || item.label.includes(actionKeyword))
    this.setData({ actionKeyword, filteredActionOptions })
  },
  selectAction(event) {
    const value = event.currentTarget.dataset.value || ''
    const actionIndex = this.data.actionOptions.findIndex(item => item.value === value)
    this.setData({ actionIndex: actionIndex < 0 ? 0 : actionIndex, showActionSelector: false, actionKeyword: '' })
  },
  chooseResult(event) { this.setData({ resultIndex: Number(event.detail.value) }) },
  chooseStartDate(event) { this.setData({ startDate: event.detail.value }) },
  chooseEndDate(event) { this.setData({ endDate: event.detail.value }) },
  search() { this.loadLogs() },
  resetFilters() {
    this.setData({ currentCabinetId: this.getContextCabinetId(), selectedCabinetId: '', cabinetIndex: 0, userId: '', registrationNumber: '', lockerId: '', actionIndex: 0, resultIndex: 0, startDate: '', endDate: '' })
    return this.loadLogs()
  },
  buildFilters() {
    const filters = {}
    const cabinetId = this.data.scope === 'CABINET' ? this.data.currentCabinetId : this.data.selectedCabinetId
    if (cabinetId) filters.cabinetId = cabinetId
    if (this.data.userId) filters.userId = this.data.userId
    if (this.data.registrationNumber) filters.registrationNumber = this.data.registrationNumber
    if (this.data.lockerId) filters.lockerId = Number(this.data.lockerId)
    const action = this.data.actionOptions[this.data.actionIndex].value
    const result = this.data.resultOptions[this.data.resultIndex].value
    if (action) filters.action = action
    if (result) filters.result = result
    if (this.data.startDate) filters.startAt = new Date(`${this.data.startDate}T00:00:00`).toISOString()
    if (this.data.endDate) filters.endAt = new Date(`${this.data.endDate}T23:59:59.999`).toISOString()
    return filters
  },
  loadLogs() {
    const requestId = (this.logsRequestId || 0) + 1
    this.logsRequestId = requestId
    this.setData({ currentCabinetId: this.getContextCabinetId() })
    if (this.data.scope === 'CABINET' && !this.data.currentCabinetId) {
      this.setData({ authorized: true, logs: [] })
      wx.showToast({ title: '请先进入一个柜体', icon: 'none' })
      return Promise.resolve([])
    }
    const filters = this.buildFilters()
    return operationLogService.queryForAuthorizedStaff(filters).then(logs => {
      if (this.unloaded || requestId !== this.logsRequestId) return []
      this.setData({
        authorized: true,
        logs: logs.slice().sort((a, b) => new Date(b.createdAt) - new Date(a.createdAt)).map(item => ({
          ...item,
          actionLabel: ACTION_LABELS[item.action] || '其他操作',
          resultLabel: item.result === 'SUCCESS' ? '成功' : '失败',
          lockerLabel: item.lockerId ? `${String(item.lockerId).padStart(2, '0')}号柜` : '—',
          operatorLabel: item.userId ? `${item.userId} · ${item.role || 'SYSTEM'}` : '设备 · SYSTEM',
          registrationLabel: item.registrationNumber || '无注册编号',
          createdTime: this.formatDateTime(item.createdAt)
        }))
      })
      return logs
    }).catch(error => {
      if (this.unloaded || requestId !== this.logsRequestId) return []
      this.setData({ authorized: true, logs: [] })
      if (error.message === 'LOG_QUERY_SCOPE_REQUIRED') wx.showToast({ title: '客服请先填写用户、注册编号或柜体', icon: 'none' })
      else if (error.message === 'USER_NOT_FOUND') wx.showToast({ title: '没有找到该注册编号对应的用户', icon: 'none' })
      else if (error.message === 'REGISTRATION_NUMBER_INVALID') wx.showToast({ title: '注册编号至少需要5位数字', icon: 'none' })
      else if (error.message === 'USER_SCOPE_MISMATCH') wx.showToast({ title: '用户 ID 与注册编号不匹配', icon: 'none' })
    })
  },
  formatDateTime(iso) {
    const date = new Date(iso)
    return `${String(date.getMonth() + 1).padStart(2, '0')}-${String(date.getDate()).padStart(2, '0')} ${String(date.getHours()).padStart(2, '0')}:${String(date.getMinutes()).padStart(2, '0')}`
  }
})

const depositRepository = require('../../repositories/depositRepository')
const permissionGuard = require('../../services/permissionGuard')
const authService = require('../../services/authService')
const { STORE_REOPEN_WINDOW_MS } = require('../../config/env')

Page({
  data: {
    records: [],
    statusFilter: '',
    cabinetId: '',
    authorized: false,
    reopeningRecordId: ''
  },
  onLoad(options) {
    const statusFilter = options.status || ''
    const cabinetId = options.cabinetId ? decodeURIComponent(options.cabinetId) : ''
    this.setData({ statusFilter, cabinetId })
    permissionGuard.requireAccess().then(() => {
      this.setData({ authorized: true })
      this.loadRecords()
    }).catch(() => {})
  },
  onShow() {
    this.setData({ reopeningRecordId: '' })
    if (this.data.authorized) this.loadRecords()
  },
  setFilter(event) {
    this.setData({ statusFilter: event.currentTarget.dataset.status || '' })
    this.loadRecords()
  },
  loadRecords() {
    const user = authService.getCurrentUser()
    const isStaffCabinetQuery = Boolean(this.data.cabinetId) && permissionGuard.CUSTOMER_SERVICE_ROLES.includes(user.role)
    const sourceRecords = isStaffCabinetQuery ? depositRepository.getRecordsAccessibleByUser(user) : depositRepository.getDepositRecordsForUser(user.id)
    Promise.resolve(sourceRecords).then(source => {
    const now = Date.now()
    const records = source
      .slice()
      .filter(item => !this.data.cabinetId || item.cabinetId === this.data.cabinetId)
      .filter(item => !this.data.statusFilter || item.status === this.data.statusFilter)
      .sort((a, b) => new Date(b.storedAt).getTime() - new Date(a.storedAt).getTime())
      .map(item => ({
        ...item,
        cabinetName: item.cabinetId || '未知柜体',
        lockerNumber: String(item.lockerId).padStart(2, '0'),
        storedTime: this.formatDateTime(item.storedAt),
        pickedTime: item.pickedAt ? this.formatDateTime(item.pickedAt) : '',
        adminClearedTime: item.adminClearedAt ? this.formatDateTime(item.adminClearedAt) : '',
        pickupMethodText: { CUSTOMER_SERVICE_AUTHORIZED: '客服授权取餐', MANUAL_EMERGENCY: '现场应急取餐', USER_SELF_SERVICE: '用户自助取餐' }[item.pickupMethod] || '',
        statusText: item.status === 'PICKED_UP' ? '已取餐' : item.status === 'ADMIN_CLEARED' ? '管理员核空' : '未取餐',
        canReopen: !isStaffCabinetQuery && permissionGuard.STORE_ROLES.includes(user.role) && (item.depositorUserId || item.riderId) === user.id && item.status === 'WAITING_PICKUP' && this.isWithinReopenWindow(item.storedAt, now)
      }))
    this.setData({ records })
    }).catch(() => wx.showToast({ title: '记录加载失败', icon: 'none' }))
  },
  copyPickupInfo(event) {
    const record = this.data.records.find(item => item.id === event.currentTarget.dataset.id)
    if (!record) return
    const text = `您的外卖已存入湖's Takeaway ${record.cabinetId} 柜体 ${record.lockerNumber}号柜。\n\n取餐码：${record.pickupCode}\n存入时间：${record.storedTime}`
    wx.setClipboardData({ data: text })
  },
  reopenDeposit(event) {
    if (this.data.reopeningRecordId) return
    const record = this.data.records.find(item => item.id === event.currentTarget.dataset.id)
    if (!record || !record.canReopen) {
      wx.showToast({ title: '该记录当前不能重新开柜', icon: 'none' })
      return
    }
    this.setData({ reopeningRecordId: record.id })
    const url = `/pages/rider-store/rider-store?mode=REDEPOSIT&cabinetId=${encodeURIComponent(record.cabinetId)}&lockerId=${record.lockerId}&recordId=${encodeURIComponent(record.id)}`
    wx.navigateTo({ url, fail: () => this.setData({ reopeningRecordId: '' }) })
  },
  isWithinReopenWindow(storedAt, now = Date.now()) {
    const time = new Date(storedAt).getTime()
    return Number.isFinite(time) && time <= now + 60 * 1000 && now - time <= STORE_REOPEN_WINDOW_MS
  },
  formatDateTime(iso) {
    const date = new Date(iso)
    const month = String(date.getMonth() + 1).padStart(2, '0')
    const day = String(date.getDate()).padStart(2, '0')
    const hour = String(date.getHours()).padStart(2, '0')
    const minute = String(date.getMinutes()).padStart(2, '0')
    return `${month}-${day} ${hour}:${minute}`
  }
})

const depositRepository = require('../../repositories/depositRepository')
const permissionGuard = require('../../services/permissionGuard')
const authService = require('../../services/authService')

Page({
  data: { records: [], authorized: false },
  onLoad() {
    permissionGuard.requireAccess().then(() => {
      this.setData({ authorized: true })
      this.loadRecords()
    }).catch(() => {})
  },
  onShow() { if (this.data.authorized) this.loadRecords() },
  loadRecords() {
    // 用户取餐记录只接收业务上已经成功完成的记录。
    Promise.resolve(depositRepository.getPickupRecordsForUser(authService.getCurrentUser().id)).then(source => {
    const records = source
      .slice()
      .sort((a, b) => new Date(b.pickedAt).getTime() - new Date(a.pickedAt).getTime())
      .map(item => ({
        ...item,
        lockerNumber: String(item.lockerId).padStart(2, '0'),
        storedTime: item.storedAt ? this.formatDateTime(item.storedAt) : '—',
        pickupMethodText: { CUSTOMER_SERVICE_AUTHORIZED: '客服授权取餐', MANUAL_EMERGENCY: '现场应急取餐', USER_SELF_SERVICE: '用户自助取餐' }[item.pickupMethod] || '用户自助取餐',
        pickedTime: this.formatDateTime(item.pickedAt)
      }))
    this.setData({ records })
    }).catch(() => wx.showToast({ title: '记录加载失败', icon: 'none' }))
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

const feedbackRepository = require('../../repositories/feedbackRepository')
const permissionGuard = require('../../services/permissionGuard')
const authService = require('../../services/authService')

const PROBLEM_LABELS = {
  LOCK_FAILED: '柜门无法打开',
  CODE_ERROR: '取餐码错误',
  FOOD_MISSING: '外卖缺失',
  LOCKER_DAMAGED: '柜格损坏',
  DEVICE_OFFLINE: '设备离线',
  OTHER: '其他问题'
}

Page({
  data: { feedbackList: [], authorized: false },
  onLoad() {
    permissionGuard.requireAccess().then(() => {
      this.setData({ authorized: true })
      this.loadFeedback()
    }).catch(() => {})
  },
  onShow() {
    if (this.data.authorized) this.loadFeedback()
  },
  loadFeedback() {
    const user = authService.getCurrentUser()
    Promise.resolve(feedbackRepository.getFeedbackForUser(user.id)).then(source => {
    const feedbackList = source
      .slice()
      .sort((a, b) => new Date(b.createdAt).getTime() - new Date(a.createdAt).getTime())
      .map(item => ({
        ...item,
        problemLabel: PROBLEM_LABELS[item.problemType] || '其他问题',
        lockerLabel: item.lockerId ? `${String(item.lockerId).padStart(2, '0')}号柜` : '未填写',
        createdTime: this.formatDateTime(item.createdAt),
        descriptionText: item.description || '未填写问题描述'
      }))
    this.setData({ feedbackList })
    }).catch(() => wx.showToast({ title: '反馈记录加载失败', icon: 'none' }))
  },
  createFeedback() {
    const cabinetId = getApp().globalData.currentCabinetId || ''
    const query = cabinetId ? `?cabinetId=${encodeURIComponent(cabinetId)}` : ''
    wx.navigateTo({ url: `/pages/feedback/feedback${query}` })
  },
  formatDateTime(iso) {
    const date = new Date(iso)
    const year = date.getFullYear()
    const month = String(date.getMonth() + 1).padStart(2, '0')
    const day = String(date.getDate()).padStart(2, '0')
    const hour = String(date.getHours()).padStart(2, '0')
    const minute = String(date.getMinutes()).padStart(2, '0')
    return `${year}-${month}-${day} ${hour}:${minute}`
  }
})

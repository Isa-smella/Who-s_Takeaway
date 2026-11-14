const feedbackSubmissionService = require('../../services/feedbackSubmissionService')
const permissionGuard = require('../../services/permissionGuard')

Page({
  data: {
    authorized: false,
    problemTypes: ['LOCK_FAILED', 'CODE_ERROR', 'FOOD_MISSING', 'LOCKER_DAMAGED', 'DEVICE_OFFLINE', 'OTHER'],
    problemLabels: ['柜门无法打开', '取餐码错误', '外卖缺失', '柜格损坏', '设备离线', '其他问题'],
    problemIndex: -1,
    cabinetId: '', lockerId: '', description: '', submitting: false
  },
  onLoad(options) {
    this.setData({
      cabinetId: options.cabinetId ? decodeURIComponent(options.cabinetId) : (getApp().globalData.currentCabinetId || ''),
      lockerId: options.lockerId || ''
    })
    permissionGuard.requireAccess().then(() => {
      this.setData({ authorized: true })
    }).catch(() => {})
  },
  chooseProblem(event) { this.setData({ problemIndex: Number(event.detail.value) }) },
  inputCabinet(event) { this.setData({ cabinetId: String(event.detail.value || '').trim() }) },
  inputLocker(event) { this.setData({ lockerId: String(event.detail.value || '').replace(/\D/g, '').slice(0, 3) }) },
  inputDescription(event) { this.setData({ description: String(event.detail.value || '').slice(0, 500) }) },
  submitFeedback() {
    if (!this.data.authorized || this.data.submitting) return
    if (this.data.problemIndex < 0) return wx.showToast({ title: '请选择问题类型', icon: 'none' })
    if (!this.data.cabinetId) return wx.showToast({ title: '请输入柜体编号', icon: 'none' })

    this.setData({ submitting: true })
    try {
      const result = feedbackSubmissionService.submit({
        cabinetId: this.data.cabinetId,
        lockerId: this.data.lockerId ? Number(this.data.lockerId) : null,
        problemType: this.data.problemTypes[this.data.problemIndex],
        description: this.data.description
      })
      Promise.resolve(result).then(() => wx.showModal({ title: '反馈已提交', content: '我们已收到您的问题，如遇紧急情况请联系在线客服。', showCancel: false, success: () => wx.navigateBack() }))
        .catch(error => this.handleSubmitError(error))
    } catch (error) {
      this.handleSubmitError(error)
    }
  },
  handleSubmitError(error) {
    this.setData({ submitting: false })
    const title = error.message === 'CABINET_NOT_FOUND' ? '柜体编号不存在' : error.message === 'LOCKER_NOT_FOUND' ? '柜格编号不存在' : '提交失败，请稍后重试'
    wx.showToast({ title, icon: 'none' })
  }
})

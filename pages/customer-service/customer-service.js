const permissionGuard = require('../../services/permissionGuard')
const authService = require('../../services/authService')
const unlockAuthorizationService = require('../../services/unlockAuthorizationService')
const cabinetScanService = require('../../services/cabinetScanService')
const cabinetRepository = require('../../repositories/cabinetRepository')
const lockerRepository = require('../../repositories/lockerRepository')
const depositRepository = require('../../repositories/depositRepository')
const emergencySupportRequestService = require('../../services/emergencySupportRequestService')
const { USE_CLOUD } = require('../../config/env')

Page({
  data: {
    authorized: false, userId: '', cabinetId: '', lockerId: '', recordId: '', serviceSession: '{}', openIndex: -1, scanningCabinet: false,
    unlockAuthorization: null, supportRequestId: '', supportRequestStatus: '', manualCabinetId: '', manualLockerId: '', savingContext: false,
    questions: [
  { title: '取餐码错误怎么办？', answer: '请先核对存餐人员发送的柜体编号、柜格编号和手机号后4位取餐码。多次确认仍错误时，请直接联系在线客服核验业务记录。错误尝试不会开锁，也不会生成取餐成功记录。' },
      { title: '柜门打不开怎么办？', answer: '请靠近柜体，确认手机蓝牙已开启并允许微信使用蓝牙。重新连接后再尝试；仍无法开门时请联系客服，不要用力撬门。' },
      { title: '蓝牙连接失败怎么办？', answer: '请靠近当前柜体，打开手机蓝牙并检查微信蓝牙权限。确认首页显示的 cabinetId 与现场柜体一致，然后点击“重新连接”。' },
      { title: '柜门已经打开但外卖不在怎么办？', answer: '请不要移动其他柜格物品，立即记录柜体和柜格编号并提交“外卖丢失”反馈。客服会结合存入记录、取餐记录和操作日志进行核查。' },
      { title: '柜格显示维修中怎么办？', answer: '维修中的柜格不能存餐、取餐或开锁。请选择其他可用柜格；如果外卖记录关联该柜格，请联系客服处理。' },
      { title: '存餐后忘记复制取餐信息怎么办？', answer: '进入“个人中心 → 我的存入记录”，找到状态为“未取餐”的记录，可再次复制柜体、柜格、取餐码和存入时间。' },
      { title: '存餐后需要重新开柜怎么办？', answer: '请在存入后10分钟内进入“个人中心 → 我的存入记录”，找到对应的“未取餐”记录并点击“重新开柜”。页面会返回存餐流程并打开原柜格；请重新放好外卖、关闭柜门，再次输入用户手机号后4位并确认存入。本次输入的4位数字会替换原取餐码，但不会生成重复记录，柜格仍保持占用和待取餐状态。' },
      { title: '用户取餐后没有关门怎么办？', answer: '取餐在柜门成功打开时已经完成，未关门不会把柜格恢复为占用。任何人之后关门只更新柜门状态，不会创建新的业务记录。' }
    ]
  },
  onLoad(options) {
    const cabinetId = options.cabinetId ? decodeURIComponent(options.cabinetId) : ''
    const lockerId = options.lockerId || ''
    const recordId = options.recordId ? decodeURIComponent(options.recordId) : ''
    permissionGuard.requireLogin().then(() => {
      const user = authService.getCurrentUser()
      this.setData({
        authorized: true,
        userId: user.id,
        cabinetId,
        lockerId,
        recordId,
        manualCabinetId: cabinetId,
        manualLockerId: lockerId,
        serviceSession: JSON.stringify({ source: 'emergency-customer-service', userId: user.id, cabinetId, lockerId, recordId })
      }, () => {
        this.prepareSupportRequest()
        this.refreshUnlockAuthorization()
      })
    }).catch(() => {})
  },
  onShow() {
    if (!this.data.authorized) return
    this.refreshSupportRequest()
    this.refreshUnlockAuthorization()
  },
  refreshSupportRequest() {
    if (!this.data.supportRequestId) return
    let result
    try { result = emergencySupportRequestService.listForCurrentUser() } catch (error) { result = Promise.reject(error) }
    Promise.resolve(result).then(items => {
      const request = items.find(item => item.id === this.data.supportRequestId)
      this.setData({ supportRequestStatus: request ? request.status : '' })
    }).catch(() => {})
  },
  updateServiceContext(patch = {}) {
    const context = {
      userId: patch.userId !== undefined ? patch.userId : this.data.userId,
      cabinetId: patch.cabinetId !== undefined ? patch.cabinetId : this.data.cabinetId,
      lockerId: patch.lockerId !== undefined ? patch.lockerId : this.data.lockerId,
      recordId: patch.recordId !== undefined ? patch.recordId : this.data.recordId
    }
    let supportRequestId = this.data.supportRequestId
    let update = Promise.resolve(null)
    if (supportRequestId) {
      try { update = Promise.resolve(emergencySupportRequestService.updateContext(supportRequestId, context)) } catch (error) { update = Promise.reject(error) }
    }
    return update.then(request => {
      const resolved = request ? { ...context, cabinetId: request.cabinetId || '', lockerId: request.lockerId || '', recordId: request.recordId || '' } : context
      this.setData({
        ...resolved,
        manualCabinetId: resolved.cabinetId || '',
        manualLockerId: resolved.lockerId ? String(resolved.lockerId) : '',
        supportRequestId,
        supportRequestStatus: request ? request.status : this.data.supportRequestStatus,
        serviceSession: JSON.stringify({ source: 'emergency-customer-service', supportRequestId, ...resolved })
      })
      return request || resolved
    }).catch(error => {
      if (USE_CLOUD) throw error
      this.setData({ supportRequestId: '' })
      throw error
    })
  },
  prepareSupportRequest() {
    let result
    try { result = emergencySupportRequestService.prepare({ cabinetId: this.data.cabinetId, lockerId: this.data.lockerId, recordId: this.data.recordId }) } catch (error) { result = Promise.reject(error) }
    Promise.resolve(result).then(request => {
      this.setData({
        supportRequestId: request.id,
        supportRequestStatus: request.status,
        serviceSession: JSON.stringify({ source: 'emergency-customer-service', supportRequestId: request.id, userId: request.userId, cabinetId: request.cabinetId || '', lockerId: request.lockerId || '', recordId: request.recordId || '' })
      })
    }).catch(() => {})
  },
  activateEmergencyContact() {
    if (!this.data.supportRequestId) return
    let result
    try { result = emergencySupportRequestService.activate(this.data.supportRequestId) } catch (error) { result = Promise.reject(error) }
    Promise.resolve(result).then(request => {
      this.setData({ supportRequestStatus: request.status })
    }).catch(() => {})
  },
  cancelEmergencyRequest() {
    if (!this.data.supportRequestId) return
    wx.showModal({
      title: '取消紧急客服请求',
      content: '取消后客服将停止处理，尚未使用的一次性开锁授权也会失效。',
      confirmText: '确认取消', confirmColor: '#C03338',
      success: result => {
        if (!result.confirm) return
        let request
        try { request = emergencySupportRequestService.cancelByUser(this.data.supportRequestId) } catch (error) { request = Promise.reject(error) }
        Promise.resolve(request).then(() => {
          this.setData({ supportRequestStatus: 'CANCELLED', unlockAuthorization: null })
          wx.showToast({ title: '请求已取消', icon: 'success' })
        }).catch(() => wx.showToast({ title: '当前请求无法取消', icon: 'none' }))
      }
    })
  },
  scanCabinetForService() {
    if (this.data.scanningCabinet || this.data.lockerId || this.data.recordId) return
    this.setData({ scanningCabinet: true })
    cabinetScanService.scanCabinetId().then(cabinetId => {
      if (!USE_CLOUD) cabinetRepository.getCabinet(cabinetId)
      return this.updateServiceContext({ cabinetId }).then(() => cabinetId)
    }).then(cabinetId => {
      this.setData({ scanningCabinet: false })
      this.refreshUnlockAuthorization()
      wx.showToast({ title: `已识别 ${cabinetId}`, icon: 'success' })
    }).catch(error => {
      this.setData({ scanningCabinet: false })
      if (String(error.errMsg || '').includes('cancel')) return
      wx.showToast({ title: cabinetScanService.getCabinetErrorMessage(error), icon: 'none' })
    })
  },
  inputManualCabinet(event) { this.setData({ manualCabinetId: String(event.detail.value || '').trim() }) },
  inputManualLocker(event) { this.setData({ manualLockerId: String(event.detail.value || '').replace(/\D/g, '').slice(0, 3) }) },
  submitManualContext() {
    if (this.data.savingContext) return
    const cabinetId = this.data.manualCabinetId.trim()
    const lockerId = Number(this.data.manualLockerId)
    if (!cabinetId) return wx.showToast({ title: '请输入柜体编号', icon: 'none' })
    if (!Number.isInteger(lockerId) || lockerId < 1) return wx.showToast({ title: '请输入柜格编号', icon: 'none' })
    this.setData({ savingContext: true })
    if (USE_CLOUD) {
      return this.updateServiceContext({ cabinetId, lockerId, recordId: '' }).then(updated => {
        this.setData({ savingContext: false, manualCabinetId: cabinetId, manualLockerId: String(lockerId) })
        wx.showToast({ title: updated.recordId ? '已关联待取记录' : '柜体信息已保存', icon: 'success' })
      }).catch(() => { this.setData({ savingContext: false }); wx.showToast({ title: '柜体或柜格信息无效', icon: 'none' }) })
    }
    try {
      const cabinet = cabinetRepository.getCabinet(cabinetId)
      if (cabinet.status === 'DISABLED') throw new Error('CABINET_DISABLED')
      const locker = lockerRepository.getLocker(cabinetId, lockerId)
      if (!locker || locker.enabled === false) throw new Error('LOCKER_NOT_AVAILABLE')
      const record = depositRepository.getActiveRecord(cabinetId, lockerId)
      this.updateServiceContext({ cabinetId, lockerId, recordId: record ? record.id : '' })
      this.setData({ savingContext: false, manualCabinetId: cabinetId, manualLockerId: String(lockerId) })
      wx.showToast({ title: record ? '已关联待取记录' : '柜体信息已保存', icon: 'success' })
    } catch (error) {
      this.setData({ savingContext: false })
      const title = error.message === 'CABINET_DISABLED' ? '该柜体维修中' : error.message === 'CABINET_NOT_FOUND' ? '柜体编号不存在' : '柜格编号不存在或维修中'
      wx.showToast({ title, icon: 'none' })
    }
  },
  refreshUnlockAuthorization() {
    let request
    try {
      request = unlockAuthorizationService.getActiveForCurrentUser()
      Promise.resolve(request).then(authorizations => {
      const matched = authorizations.find(item =>
        (!this.data.recordId || item.recordId === this.data.recordId) &&
        (!this.data.cabinetId || item.cabinetId === this.data.cabinetId) &&
        (!this.data.lockerId || Number(item.lockerId) === Number(this.data.lockerId))
      ) || null
      this.setData({ unlockAuthorization: matched ? { ...matched, lockerNumber: String(matched.lockerId).padStart(2, '0') } : null })
      }).catch(() => this.setData({ unlockAuthorization: null }))
    } catch (error) { this.setData({ unlockAuthorization: null }) }
  },
  goUnlockAuthorization() { wx.navigateTo({ url: '/pages/unlock-authorizations/unlock-authorizations' }) },
  toggleQuestion(event) {
    const index = Number(event.currentTarget.dataset.index)
    this.setData({ openIndex: this.data.openIndex === index ? -1 : index })
  },
  goFeedback() {
    if (!this.data.authorized) return
    const cabinetId = this.data.cabinetId || getApp().globalData.currentCabinetId || ''
    const params = []
    if (cabinetId) params.push(`cabinetId=${encodeURIComponent(cabinetId)}`)
    if (this.data.lockerId) params.push(`lockerId=${this.data.lockerId}`)
    if (this.data.recordId) params.push(`recordId=${encodeURIComponent(this.data.recordId)}`)
    wx.navigateTo({ url: `/pages/feedback/feedback${params.length ? `?${params.join('&')}` : ''}` })
  }
})

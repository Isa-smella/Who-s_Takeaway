const announcementService = require('../../services/announcementService')
const announcementImageService = require('../../services/announcementImageService')
const permissionGuard = require('../../services/permissionGuard')

const TYPES = ['NOTICE', 'ADVERTISEMENT', 'MAINTENANCE']
const TYPE_LABELS = ['普通公告', '广告内容', '维护通知']
const DEFAULT_LABELS = ['公告', '广告', '维护通知']
const STATUSES = ['DRAFT', 'PUBLISHED', 'DISABLED']
const STATUS_LABELS = ['草稿', '已发布', '已停用']
const ERROR_MESSAGES = {
  ANNOUNCEMENT_TITLE_REQUIRED: '请填写公告标题',
  ANNOUNCEMENT_SUMMARY_REQUIRED: '请填写首页摘要',
  ANNOUNCEMENT_TIME_INVALID: '公告时间格式不正确',
  ANNOUNCEMENT_TIME_RANGE_INVALID: '结束时间必须晚于开始时间',
  ANNOUNCEMENT_NOT_FOUND: '公告不存在或已删除',
  ROLE_FORBIDDEN: '无公告管理权限'
}

function pad(value) { return String(value).padStart(2, '0') }
function localParts(value, fallbackDate, fallbackTime) {
  if (!value) return { date: fallbackDate, time: fallbackTime }
  const date = new Date(value)
  if (Number.isNaN(date.getTime())) return { date: fallbackDate, time: fallbackTime }
  return { date: `${date.getFullYear()}-${pad(date.getMonth() + 1)}-${pad(date.getDate())}`, time: `${pad(date.getHours())}:${pad(date.getMinutes())}` }
}
function toIso(date, time) {
  const value = new Date(`${date}T${time}:00+08:00`)
  return Number.isNaN(value.getTime()) ? null : value.toISOString()
}
function getSaveErrorMessage(error) {
  const code = String((error && error.message) || '')
  const detail = String((error && error.errMsg) || '')
  const raw = `${code} ${detail}`
  if (/-501000|FunctionName.*not.*found|FUNCTION_NOT_FOUND|function.*not.*exist/i.test(raw)) return '尚未找到 manageAnnouncement 云函数。请在 cloudfunctions 目录右键该函数，选择“上传并部署：云端安装依赖”。'
  if (/collection.*not.*exist|DATABASE_COLLECTION_NOT_EXIST|announcements.*not.*exist/i.test(raw)) return '云数据库中尚未创建 announcements 集合。请先创建集合，并将权限设为“所有用户不可读写”。'
  if (/ROLE_FORBIDDEN/.test(raw)) return '当前账号不是 ADMIN 或 DEVELOPER，不能编辑公告。'
  if (/PRIVACY_CONSENT_REQUIRED/.test(raw)) return '当前账号尚未同意最新版用户协议和隐私政策。'
  if (/ANNOUNCEMENT_TIME_RANGE_INVALID/.test(raw)) return '结束时间必须晚于开始时间。'
  if (/ANNOUNCEMENT_TITLE_REQUIRED/.test(raw)) return '请填写公告标题。'
  if (/ANNOUNCEMENT_SUMMARY_REQUIRED/.test(raw)) return '请填写首页摘要。'
  return raw.trim() ? `云端返回：${raw.trim()}` : '未取得具体错误信息，请检查 manageAnnouncement 云函数日志。'
}

Page({
  data: {
    authorized: false, editing: false, submitting: false, imageUploading: false, announcementId: '',
    typeLabels: TYPE_LABELS, typeIndex: 0, label: DEFAULT_LABELS[0], title: '', summary: '', content: '', imageUrl: '', imageUrls: [], targetUrl: '', priority: '0',
    statusLabels: STATUS_LABELS, statusIndex: 1,
    immediateStart: true, neverExpire: true, startDate: '', startTime: '00:00', endDate: '', endTime: '23:59'
  },
  onLoad(options) {
    const announcementId = options.announcementId ? decodeURIComponent(options.announcementId) : ''
    const now = new Date()
    const today = `${now.getFullYear()}-${pad(now.getMonth() + 1)}-${pad(now.getDate())}`
    const tomorrow = new Date(now.getTime() + 24 * 60 * 60 * 1000)
    const tomorrowText = `${tomorrow.getFullYear()}-${pad(tomorrow.getMonth() + 1)}-${pad(tomorrow.getDate())}`
    this.setData({ announcementId, editing: Boolean(announcementId), startDate: today, endDate: tomorrowText })
    permissionGuard.requireAccess({ roles: permissionGuard.MANAGEMENT_ROLES }).then(() => {
      this.setData({ authorized: true })
      if (announcementId) this.loadAnnouncement(announcementId)
    }).catch(() => {})
  },
  loadAnnouncement(id) {
    announcementService.listForManagement().then(items => {
      const item = items.find(entry => entry.id === id)
      if (!item) throw new Error('ANNOUNCEMENT_NOT_FOUND')
      const start = localParts(item.startsAt, this.data.startDate, this.data.startTime)
      const end = localParts(item.endsAt, this.data.endDate, this.data.endTime)
      this.setData({
        typeIndex: Math.max(0, TYPES.indexOf(item.type)), label: item.label || '', title: item.title || '', summary: item.summary || '', content: item.content || '',
        imageUrl: item.imageUrl || '', imageUrls: Array.isArray(item.imageUrls) ? item.imageUrls : (item.imageUrl ? [item.imageUrl] : []), targetUrl: item.targetUrl || '', priority: String(Number(item.priority) || 0), statusIndex: Math.max(0, STATUSES.indexOf(item.status)),
        immediateStart: !item.startsAt, neverExpire: !item.endsAt, startDate: start.date, startTime: start.time, endDate: end.date, endTime: end.time
      })
    }).catch(error => wx.showToast({ title: ERROR_MESSAGES[error.message] || '公告加载失败', icon: 'none' }))
  },
  chooseType(event) {
    const typeIndex = Number(event.detail.value)
    const previousDefault = DEFAULT_LABELS[this.data.typeIndex]
    const label = !this.data.label || this.data.label === previousDefault ? DEFAULT_LABELS[typeIndex] : this.data.label
    this.setData({ typeIndex, label })
  },
  chooseStatus(event) { this.setData({ statusIndex: Number(event.detail.value) }) },
  inputLabel(event) { this.setData({ label: String(event.detail.value || '').slice(0, 12) }) },
  inputTitle(event) { this.setData({ title: String(event.detail.value || '').slice(0, 60) }) },
  inputSummary(event) { this.setData({ summary: String(event.detail.value || '').slice(0, 120) }) },
  inputContent(event) { this.setData({ content: String(event.detail.value || '').slice(0, 2000) }) },
  inputTargetUrl(event) { this.setData({ targetUrl: String(event.detail.value || '').trim().slice(0, 500) }) },
  inputPriority(event) { this.setData({ priority: String(event.detail.value || '').replace(/\D/g, '').slice(0, 3) }) },
  toggleImmediateStart(event) { this.setData({ immediateStart: Boolean(event.detail.value) }) },
  toggleNeverExpire(event) { this.setData({ neverExpire: Boolean(event.detail.value) }) },
  chooseStartDate(event) { this.setData({ startDate: event.detail.value }) },
  chooseStartTime(event) { this.setData({ startTime: event.detail.value }) },
  chooseEndDate(event) { this.setData({ endDate: event.detail.value }) },
  chooseEndTime(event) { this.setData({ endTime: event.detail.value }) },
  chooseAnnouncementImage() {
    if (!this.data.authorized || this.data.imageUploading) return
    const remaining = 9 - this.data.imageUrls.length
    if (remaining <= 0) return wx.showToast({ title: '最多添加 9 张照片', icon: 'none' })
    this.setData({ imageUploading: true })
    announcementImageService.chooseAndUpload(remaining).then(fileIDs => {
      const imageUrls = this.data.imageUrls.concat(fileIDs).slice(0, 9)
      this.pendingUploadedImages = (this.pendingUploadedImages || []).concat(fileIDs)
      this.setData({ imageUrls, imageUrl: imageUrls[0] || '', imageUploading: false })
    }).catch(error => {
      this.setData({ imageUploading: false })
      if (error && error.message === 'ANNOUNCEMENT_IMAGE_CHOOSE_CANCELLED') return
      const messages = {
        ANNOUNCEMENT_IMAGE_TOO_LARGE: '图片不能超过 10MB',
        ANNOUNCEMENT_IMAGE_UPLOAD_FAILED: '照片上传失败，请检查云存储后重试',
        WECHAT_CLOUD_NOT_AVAILABLE: '当前环境无法使用微信云存储'
      }
      console.error('upload announcement image failed', error)
      const raw = `${String(error && error.message || '')} ${String(error && error.errMsg || '')}`
      const content = /ECONNRESET|ETIMEDOUT|timeout|network/i.test(raw)
        ? '与微信云存储的网络连接中断，系统已自动重试 3 次。请检查网络后重新添加照片。'
        : (messages[error && error.message] || '照片处理或上传失败，请稍后重试。')
      wx.showModal({ title: '添加照片失败', content, showCancel: false })
    })
  },
  previewAnnouncementImage(event) {
    const index = Number(event.currentTarget.dataset.index) || 0
    const urls = this.data.imageUrls
    if (urls.length) wx.previewImage({ current: urls[index] || urls[0], urls })
  },
  removeAnnouncementImage(event) {
    const index = Number(event.currentTarget.dataset.index)
    if (!Number.isInteger(index) || index < 0 || index >= this.data.imageUrls.length) return
    const removed = this.data.imageUrls[index]
    const imageUrls = this.data.imageUrls.filter((item, itemIndex) => itemIndex !== index)
    this.setData({ imageUrls, imageUrl: imageUrls[0] || '' })
    const pending = this.pendingUploadedImages || []
    if (pending.includes(removed)) {
      this.pendingUploadedImages = pending.filter(fileID => fileID !== removed)
      announcementImageService.deleteUploadedFile(removed)
    }
  },
  submit() {
    if (!this.data.authorized || this.data.submitting) return
    if (!this.data.title.trim()) return wx.showToast({ title: '请填写公告标题', icon: 'none' })
    if (!this.data.summary.trim()) return wx.showToast({ title: '请填写首页摘要', icon: 'none' })
    if (this.data.imageUploading) return wx.showToast({ title: '照片正在上传', icon: 'none' })
    const startsAt = this.data.immediateStart ? null : toIso(this.data.startDate, this.data.startTime)
    const endsAt = this.data.neverExpire ? null : toIso(this.data.endDate, this.data.endTime)
    if ((!this.data.immediateStart && !startsAt) || (!this.data.neverExpire && !endsAt)) return wx.showToast({ title: '公告时间格式不正确', icon: 'none' })
    if (startsAt && endsAt && new Date(endsAt).getTime() <= new Date(startsAt).getTime()) return wx.showToast({ title: '结束时间必须晚于开始时间', icon: 'none' })
    const data = {
      id: this.data.announcementId || undefined,
      type: TYPES[this.data.typeIndex], label: this.data.label.trim(), title: this.data.title.trim(), summary: this.data.summary.trim(), content: this.data.content.trim(),
      imageUrl: this.data.imageUrls[0] || '', imageUrls: this.data.imageUrls.slice(0, 9), targetUrl: this.data.targetUrl, priority: Number(this.data.priority) || 0, status: STATUSES[this.data.statusIndex], startsAt, endsAt
    }
    this.setData({ submitting: true })
    Promise.resolve(announcementService.saveAnnouncement(data)).then(() => {
      this.pendingUploadedImages = []
      wx.showToast({ title: this.data.editing ? '公告已更新' : '公告已创建', icon: 'success' })
      setTimeout(() => wx.navigateBack(), 500)
    }).catch(error => {
      this.setData({ submitting: false })
      console.error('save announcement failed', error)
      wx.showModal({ title: '公告保存失败', content: ERROR_MESSAGES[error.message] || getSaveErrorMessage(error), showCancel: false })
    })
  },
  onUnload() {
    ;(this.pendingUploadedImages || []).forEach(fileID => announcementImageService.deleteUploadedFile(fileID))
  }
})

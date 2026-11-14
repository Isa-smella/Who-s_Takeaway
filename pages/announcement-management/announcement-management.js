const announcementService = require('../../services/announcementService')
const permissionGuard = require('../../services/permissionGuard')

const TYPE_TEXT = { NOTICE: '公告', ADVERTISEMENT: '广告', MAINTENANCE: '维护通知' }
const STATUS_TEXT = { DRAFT: '草稿', PUBLISHED: '已发布', DISABLED: '已停用' }

Page({
  data: { authorized: false, loading: false, items: [] },
  onLoad() {
    permissionGuard.requireAccess({ roles: permissionGuard.MANAGEMENT_ROLES }).then(() => {
      this.setData({ authorized: true })
      this.loadItems()
    }).catch(() => {})
  },
  onShow() { if (this.data.authorized) this.loadItems() },
  loadItems() {
    this.setData({ loading: true })
    announcementService.listForManagement().then(items => {
      this.setData({ loading: false, items: items.map(item => ({
        ...item,
        priority: Number(item.priority) || 0,
        typeText: TYPE_TEXT[item.type] || item.type,
        statusText: STATUS_TEXT[item.status] || item.status,
        startText: this.formatDateTime(item.startsAt, '立即'),
        endText: this.formatDateTime(item.endsAt, '长期')
      })) })
    }).catch(error => {
      this.setData({ loading: false, items: [] })
      console.error('load announcements failed', error)
      const raw = `${String(error.message || '')} ${String(error.errMsg || '')}`
      const title = /-501000|FunctionName.*not.*found|FUNCTION_NOT_FOUND/i.test(raw) ? '请部署 listAnnouncements 云函数' : /collection.*not.*exist|announcements.*not.*exist/i.test(raw) ? '请先创建 announcements 集合' : error.message === 'ROLE_FORBIDDEN' ? '无公告管理权限' : '公告加载失败，请查看控制台'
      wx.showToast({ title, icon: 'none' })
    })
  },
  addAnnouncement() { wx.navigateTo({ url: '/pages/announcement-form/announcement-form' }) },
  editAnnouncement(event) { wx.navigateTo({ url: `/pages/announcement-form/announcement-form?announcementId=${encodeURIComponent(event.currentTarget.dataset.id)}` }) },
  toggleStatus(event) {
    const id = event.currentTarget.dataset.id
    const nextStatus = event.currentTarget.dataset.status === 'PUBLISHED' ? 'DISABLED' : 'PUBLISHED'
    wx.showModal({
      title: nextStatus === 'PUBLISHED' ? '发布公告' : '停用公告',
      content: nextStatus === 'PUBLISHED' ? '发布后，处于有效期内的用户将在首页看到该内容。' : '停用后，用户首页将不再展示该内容。',
      success: result => {
        if (!result.confirm) return
        announcementService.setAnnouncementStatus(id, nextStatus).then(() => {
          wx.showToast({ title: nextStatus === 'PUBLISHED' ? '已发布' : '已停用', icon: 'success' })
          this.loadItems()
        }).catch(() => wx.showToast({ title: '状态更新失败', icon: 'none' }))
      }
    })
  },
  deleteAnnouncement(event) {
    const id = event.currentTarget.dataset.id
    wx.showModal({
      title: '删除公告',
      content: '确认删除该公告吗？系统将执行软删除并保留操作日志。',
      confirmColor: '#c03338',
      success: result => {
        if (!result.confirm) return
        announcementService.deleteAnnouncement(id).then(() => {
          wx.showToast({ title: '公告已删除', icon: 'success' })
          this.loadItems()
        }).catch(() => wx.showToast({ title: '删除失败', icon: 'none' }))
      }
    })
  },
  formatDateTime(iso, fallback) {
    if (!iso) return fallback
    const date = new Date(iso)
    if (Number.isNaN(date.getTime())) return fallback
    return `${date.getFullYear()}-${String(date.getMonth() + 1).padStart(2, '0')}-${String(date.getDate()).padStart(2, '0')} ${String(date.getHours()).padStart(2, '0')}:${String(date.getMinutes()).padStart(2, '0')}`
  }
})

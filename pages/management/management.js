const permissionGuard = require('../../services/permissionGuard')

Page({
  data: {
    authorized: false
  },
  onLoad() {
    permissionGuard.requireAccess({ roles: permissionGuard.MANAGEMENT_ROLES }).then(() => {
      this.setData({ authorized: true })
    }).catch(() => {})
  },
  
  goCabinetManagement() { wx.navigateTo({ url: '/pages/cabinet-management/cabinet-management' }) },
  goFeedbackManagement() { wx.navigateTo({ url: '/pages/feedback-management/feedback-management' }) },
  goMaintenanceOrders() { wx.navigateTo({ url: '/pages/maintenance-orders/maintenance-orders' }) },
  goAnnouncementManagement() { wx.navigateTo({ url: '/pages/announcement-management/announcement-management' }) },
  goAnalytics() { wx.navigateTo({ url: '/pages/analytics/analytics' }) }
})

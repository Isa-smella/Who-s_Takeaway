const permissionGuard = require('../../services/permissionGuard')
const maintenanceWorkOrderService = require('../../services/maintenanceWorkOrderService')
const { formatMonthDayTime } = require('../../utils/dateFormatter')

const STATUS_LABELS = {
  PENDING: '待接单', IN_PROGRESS: '处理中', ONSITE: '已到场', MANUAL_UNLOCK_COMPLETED: '已机械开锁',
  SELF_CHECK_PASSED: '自检通过', RESOLVED: '已完成'
}

Page({
  data: { authorized: false, filter: 'ACTIVE', orders: [], activeCount: 0, historyCount: 0 },
  onLoad() {
    permissionGuard.requireAccess({ roles: permissionGuard.MANAGEMENT_ROLES }).then(() => {
      this.setData({ authorized: true })
      this.loadOrders()
    }).catch(() => {})
  },
  onShow() { if (this.data.authorized) this.loadOrders() },
  setFilter(event) { this.setData({ filter: event.currentTarget.dataset.filter }); this.loadOrders() },
  async loadOrders() {
    try {
      const [all, filtered] = await Promise.all([maintenanceWorkOrderService.listForManager('ALL'), maintenanceWorkOrderService.listForManager(this.data.filter)])
      const orders = filtered.slice().sort((a, b) => new Date(b.updatedAt) - new Date(a.updatedAt)).map(item => ({
        ...item,
        targetLabel: item.type === 'CABINET' ? '整柜' : `${String(item.lockerId).padStart(2, '0')}号柜`,
        statusLabel: STATUS_LABELS[item.status] || item.status,
        createdTime: this.formatDateTime(item.createdAt),
        faultLabel: item.faultCode || (item.source === 'MANUAL_MAINTENANCE' ? '管理员手动维修' : item.reason)
      }))
      this.setData({ orders, activeCount: all.filter(item => item.status !== 'RESOLVED').length, historyCount: all.filter(item => item.status === 'RESOLVED').length })
    } catch (error) { this.setData({ orders: [] }) }
  },
  viewOrder(event) { wx.navigateTo({ url: `/pages/maintenance-order-detail/maintenance-order-detail?orderId=${encodeURIComponent(event.currentTarget.dataset.id)}` }) },
  formatDateTime(iso) {
    return formatMonthDayTime(iso, '—')
  }
})

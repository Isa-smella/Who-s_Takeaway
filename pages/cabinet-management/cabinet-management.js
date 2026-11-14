const cabinetMonitoringService = require('../../services/cabinetMonitoringService')
const cabinetManagementService = require('../../services/cabinetManagementService')
const permissionGuard = require('../../services/permissionGuard')
const cabinetBleStatusService = require('../../services/cabinetBleStatusService')

function decorateCabinet(item) {
  const cabinet = cabinetBleStatusService.decorateCabinet(item)
  const alertText = String(cabinet.alertText || '').split(' · ').filter(text => text !== '设备离线' && text !== '整柜控制器故障' && !/^\d+格维修$/.test(text) && !/^\d+格硬件故障$/.test(text)).join(' · ')
  return { ...cabinet, alertText }
}

Page({
  data: { authorized: false, cabinets: [], visibleCabinets: [], filter: 'ALL', totalCount: 0, activeCount: 0, attentionCount: 0, maintenanceCount: 0 },
  onLoad() {
    this.unsubscribeBluetooth = cabinetBleStatusService.subscribe(() => this.refreshBleDisplay())
    permissionGuard.requireAccess({ roles: permissionGuard.MANAGEMENT_ROLES }).then(() => {
      this.setData({ authorized: true })
      this.loadCabinets()
    }).catch(() => {})
  },
  onUnload() { if (this.unsubscribeBluetooth) this.unsubscribeBluetooth() },
  onShow() { if (this.data.authorized) this.loadCabinets() },
  loadCabinets() {
    let result
    try { result = cabinetMonitoringService.getCabinetOverview() } catch (error) { result = Promise.reject(error) }
    Promise.resolve(result).then(overview => {
      const legacyDisabled = (overview.cabinets || []).filter(item => item.status === 'DISABLED')
      if (legacyDisabled.length && !this.normalizingLegacyDisabled) {
        this.normalizingLegacyDisabled = true
        return Promise.all(legacyDisabled.map(item => Promise.resolve(cabinetManagementService.normalizeLegacyDisabled(item.id))))
          .then(() => { this.normalizingLegacyDisabled = false; return this.loadCabinets() })
          .catch(error => { this.normalizingLegacyDisabled = false; throw error })
      }
      const cabinets = (overview.cabinets || []).map(decorateCabinet)
      this.setData({ ...overview, cabinets })
      this.applyFilter()
    })
      .catch(() => wx.showToast({ title: '柜体列表加载失败', icon: 'none' }))
  },
  refreshBleDisplay() {
    if (!this.data.cabinets.length) return
    const cabinets = this.data.cabinets.map(decorateCabinet)
    this.setData({ cabinets }, () => this.applyFilter())
  },
  setFilter(event) {
    this.setData({ filter: event.currentTarget.dataset.filter })
    this.applyFilter()
  },
  applyFilter() {
    const visibleCabinets = this.data.cabinets.filter(item => {
      if (this.data.filter === 'ACTIVE') return item.status === 'ACTIVE'
      if (this.data.filter === 'MAINTENANCE') return item.status === 'MAINTENANCE' || item.status === 'DISABLED'
      return true
    })
    this.setData({ visibleCabinets })
  },
  addCabinet() { wx.navigateTo({ url: '/pages/cabinet-form/cabinet-form' }) },
  viewCabinet(event) { wx.navigateTo({ url: `/pages/cabinet-detail/cabinet-detail?cabinetId=${encodeURIComponent(event.currentTarget.dataset.id)}` }) },
  editCabinet(event) { wx.navigateTo({ url: `/pages/cabinet-form/cabinet-form?cabinetId=${encodeURIComponent(event.currentTarget.dataset.id)}` }) }
})

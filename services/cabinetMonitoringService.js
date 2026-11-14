const cabinetRepository = require('../repositories/cabinetRepository')
const lockerRepository = require('../repositories/lockerRepository')
const deviceRepository = require('../repositories/deviceRepository')
const permissionGuard = require('./permissionGuard')
const { USE_CLOUD } = require('../config/env')
const cloudRepository = require('../repositories/cloudCabinetManagementRepository')
const maintenanceWorkOrderService = require('./maintenanceWorkOrderService')

const STATUS_LABELS = { ACTIVE: '正常', MAINTENANCE: '整柜维修', DISABLED: '整柜维修' }

function getCabinetOverview() {
  permissionGuard.assertRole(permissionGuard.MANAGEMENT_ROLES)
  if (USE_CLOUD) return cloudRepository.listOverview()
  const cabinets = cabinetRepository.listCabinets()
    .slice()
    .sort((a, b) => a.id.localeCompare(b.id))
    .map(cabinet => {
      const lockers = lockerRepository.getLockers(cabinet.id)
      const telemetry = deviceRepository.getTelemetry(cabinet.id)
      const faultCount = lockers.filter(item => item.faultActive).length
      const maintenanceLockerCount = lockers.filter(item => item.status === 'MAINTENANCE' || item.status === 'DISABLED' || item.enabled === false).length
      const needsAttention = cabinet.status === 'DISABLED' || cabinet.status === 'MAINTENANCE' || cabinet.faultActive || faultCount > 0 || maintenanceLockerCount > 0
      const alertLabels = []
      if (cabinet.faultActive) alertLabels.push('整柜控制器故障')
      if (faultCount) alertLabels.push(`${faultCount}格硬件故障`)
      if (maintenanceLockerCount) alertLabels.push(`${maintenanceLockerCount}格维修`)
      return {
        ...cabinet,
        statusLabel: STATUS_LABELS[cabinet.status] || cabinet.status,
        batteryPercent: telemetry.batteryPercent,
        onlineStatus: telemetry.onlineStatus,
        faultCount,
        maintenanceLockerCount,
        legacyDisabled: cabinet.status === 'DISABLED',
        needsAttention,
        alertText: alertLabels.join(' · ')
      }
    })
  return {
    cabinets,
    totalCount: cabinets.length,
    activeCount: cabinets.filter(item => item.status === 'ACTIVE').length,
    attentionCount: cabinets.filter(item => item.needsAttention).length,
    maintenanceCount: cabinets.filter(item => item.status === 'MAINTENANCE' || item.status === 'DISABLED').length
  }
}

function getCabinetDetail(cabinetId) {
  permissionGuard.assertRole(permissionGuard.MANAGEMENT_ROLES)
  if (USE_CLOUD) return cloudRepository.getDetail(cabinetId)
  const cabinet = cabinetRepository.getCabinet(cabinetId)
  const orders = maintenanceWorkOrderService.listForManager('ACTIVE').filter(order => order.cabinetId === cabinetId)
  return {
    cabinet,
    telemetry: deviceRepository.getTelemetry(cabinetId),
    lockers: lockerRepository.getLockers(cabinetId).map(locker => ({
      ...locker,
      maintenanceOrder: orders.find(order => order.type === 'LOCKER' && Number(order.lockerId) === Number(locker.id)) || null
    })),
    cabinetOrder: orders.find(order => order.type === 'CABINET') || null
  }
}

module.exports = { getCabinetOverview, getCabinetDetail }

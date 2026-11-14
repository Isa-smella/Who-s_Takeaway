const cloudService = require('../services/cloudService')
const { createCabinet, createLocker, createMaintenanceWorkOrder, createUnlockIssue } = require('../models/index')

function listOverview() { return cloudService.callFunction('listCabinetsForManagement') }
function getDetail(cabinetId) {
  return cloudService.callFunction('getCabinetManagementDetail', { cabinetId }).then(result => ({
    ...result,
    cabinet: createCabinet(result.cabinet),
    lockers: (result.lockers || []).map(item => ({ ...createLocker(item), issue: item.issue ? createUnlockIssue(item.issue) : null, maintenanceOrder: item.maintenanceOrder ? createMaintenanceWorkOrder(item.maintenanceOrder) : null })),
    cabinetOrder: result.cabinetOrder ? createMaintenanceWorkOrder(result.cabinetOrder) : null
  }))
}
function manage(action, data = {}) { return cloudService.callFunction('manageCabinet', { action, ...data }) }

module.exports = { listOverview, getDetail, manage }

const cloudService = require('../services/cloudService')
const { createMaintenanceWorkOrder } = require('../models/index')

function mapOrder(item) { return createMaintenanceWorkOrder(item) }
function list(scope = 'ACTIVE') { return cloudService.callFunction('listMaintenanceWorkOrders', { scope }).then(result => (result || []).map(mapOrder)) }
function getById(orderId) { return cloudService.callFunction('getMaintenanceWorkOrder', { orderId }).then(mapOrder) }
function manage(action, data = {}) { return cloudService.callFunction('manageMaintenanceWorkOrder', { action, ...data }).then(mapOrder) }
function reportDeviceHealth(action, data = {}) { return cloudService.callFunction('reportDeviceHealth', { action, ...data }) }

module.exports = { list, getById, manage, reportDeviceHealth }

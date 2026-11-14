const cabinetRepository = require('../repositories/cabinetRepository')
const deviceRepository = require('../repositories/deviceRepository')
const unlockAuthorizationRepository = require('../repositories/unlockAuthorizationRepository')
const unlockIssueRepository = require('../repositories/unlockIssueRepository')
const emergencySupportRequestRepository = require('../repositories/emergencySupportRequestRepository')
const maintenanceWorkOrderRepository = require('../repositories/maintenanceWorkOrderRepository')
const lockService = require('./lockService')
const doorSensorService = require('./doorSensorService')
const permissionGuard = require('./permissionGuard')
const { USER_ROLE } = require('../constants/status')

function resetCabinet(cabinetId) {
  permissionGuard.assertRole([USER_ROLE.DEVELOPER])
  cabinetRepository.resetCabinet(cabinetId)
  deviceRepository.resetMockTelemetry(cabinetId)
  unlockAuthorizationRepository.clearForCabinet(cabinetId)
  unlockIssueRepository.clearForCabinet(cabinetId)
  emergencySupportRequestRepository.clearForCabinet(cabinetId)
  maintenanceWorkOrderRepository.clearForCabinet(cabinetId)
  lockService.clearMockFailuresForCabinet(cabinetId)
  doorSensorService.clearMockDoorStatesForCabinet(cabinetId)
  return cabinetRepository.getCabinet(cabinetId)
}

module.exports = { resetCabinet }

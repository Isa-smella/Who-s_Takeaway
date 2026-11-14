const cabinetRepository = require('./cabinetRepository')

module.exports = {
  getLockers: cabinetRepository.getLockers,
  getLocker: cabinetRepository.getLocker,
  updateLocker: cabinetRepository.updateLocker,
  setLockerMaintenance: cabinetRepository.setLockerMaintenance,
  reportLockerFault: cabinetRepository.reportLockerFault,
  reportLockerHealthCheckPassed: cabinetRepository.reportLockerHealthCheckPassed,
  restoreLocker: cabinetRepository.restoreLocker,
  disableLocker: cabinetRepository.disableLocker,
  resetCabinet: cabinetRepository.resetCabinet
}

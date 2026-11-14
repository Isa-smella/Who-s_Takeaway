const cabinetRepository = require('../../repositories/cabinetRepository')
const cabinetManagementService = require('../../services/cabinetManagementService')
const permissionGuard = require('../../services/permissionGuard')
const { USE_CLOUD } = require('../../config/env')

const ERROR_MESSAGES = {
  CABINET_ID_INVALID: '柜体编号格式不正确',
  CABINET_ID_EXISTS: '柜体编号已存在',
  CABINET_NAME_REQUIRED: '请填写柜体名称',
  CABINET_LOCATION_REQUIRED: '请填写位置名称',
  BLE_IDENTIFIER_REQUIRED: '请填写BLE控制器标识',
  BLE_IDENTIFIER_EXISTS: 'BLE控制器标识已被使用',
  LOCKER_COUNT_INVALID: '柜格数量应为1至200',
  LOCKER_COUNT_IMMUTABLE: '实体柜体创建后不能修改柜格数量'
}

Page({
  data: {
    authorized: false, editing: false, submitting: false, initialLockerCount: 0,
    cabinetId: '', name: '', locationName: '', lockerCount: '', bleIdentifier: '', notes: ''
  },
  onLoad(options) {
    const cabinetId = options.cabinetId ? decodeURIComponent(options.cabinetId) : ''
    permissionGuard.requireAccess({ roles: permissionGuard.MANAGEMENT_ROLES }).then(() => {
      this.setData({ authorized: true, editing: Boolean(cabinetId) })
      if (cabinetId) this.loadCabinet(cabinetId)
    }).catch(() => {})
  },
  loadCabinet(cabinetId) {
    if (USE_CLOUD) {
      return cabinetManagementService.getCabinetDetail(cabinetId).then(result => this.fillCabinet(result.cabinet)).catch(() => wx.showToast({ title: '柜体不存在', icon: 'none' }))
    }
    try {
      const cabinet = cabinetRepository.getCabinet(cabinetId)
      this.fillCabinet(cabinet)
    } catch (error) { wx.showToast({ title: '柜体不存在', icon: 'none' }) }
  },
  fillCabinet(cabinet) {
    this.setData({
        cabinetId: cabinet.id,
        name: cabinet.name,
        locationName: cabinet.locationName,
        lockerCount: String(cabinet.lockerCount),
        initialLockerCount: cabinet.lockerCount,
        bleIdentifier: cabinet.bleIdentifier,
        notes: cabinet.notes
      })
  },
  inputCabinetId(event) { this.setData({ cabinetId: String(event.detail.value || '').trim().toUpperCase() }) },
  inputName(event) { this.setData({ name: String(event.detail.value || '') }) },
  inputLocation(event) { this.setData({ locationName: String(event.detail.value || '') }) },
  inputLockerCount(event) { this.setData({ lockerCount: String(event.detail.value || '').replace(/\D/g, '').slice(0, 3) }) },
  inputBleIdentifier(event) { this.setData({ bleIdentifier: String(event.detail.value || '').trim() }) },
  inputNotes(event) { this.setData({ notes: String(event.detail.value || '').slice(0, 300) }) },
  submit() {
    if (!this.data.authorized || this.data.submitting) return
    const payload = {
      id: this.data.cabinetId,
      name: this.data.name.trim(),
      locationName: this.data.locationName.trim(),
      lockerCount: Number(this.data.lockerCount),
      bleIdentifier: this.data.bleIdentifier.trim(),
      notes: this.data.notes.trim()
    }
    this.setData({ submitting: true })
    let result
    try { result = this.data.editing ? cabinetManagementService.updateCabinet(this.data.cabinetId, payload) : cabinetManagementService.createCabinet(payload) } catch (error) { result = Promise.reject(error) }
    Promise.resolve(result).then(() => {
      wx.showToast({ title: this.data.editing ? '柜体已更新' : '柜体已创建', icon: 'success' })
      setTimeout(() => wx.navigateBack(), 500)
    }).catch(error => {
      this.setData({ submitting: false })
      wx.showToast({ title: ERROR_MESSAGES[error.message] || '保存失败', icon: 'none' })
    })
  }
})

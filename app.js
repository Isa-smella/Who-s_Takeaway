const cabinetRepository = require('./repositories/cabinetRepository')
const bluetoothService = require('./services/bluetoothService')
// 让已验证 BLE 连接后的柜体遥测同步在页面切换时继续运行。
require('./services/doorSensorService')
const authService = require('./services/authService')
const privacyService = require('./services/privacyService')
const permissionGuard = require('./services/permissionGuard')
const cabinetSessionService = require('./services/cabinetSessionService')
const operationLogService = require('./services/operationLogService')
const eventBus = require('./services/eventBus')
const ACTIONS = require('./constants/operationActions')
const cloudService = require('./services/cloudService')
const { normalizeCabinetId } = require('./utils/idNormalizer')
const { IS_DEVELOPMENT } = require('./config/env')

App({
  globalData: {
    currentUser: null,
    currentCabinetId: null,
    currentCabinet: null
  },

  onLaunch(options) {
    cloudService.initialize()
    const user = authService.initialize()
    privacyService.initialize(user)
    this.globalData.currentUser = user
    this.handleLaunchOptions(options)
  },

  onShow(options) {
    this.handleLaunchOptions(options)
  },

  resolveCabinetId(options = {}) {
    return this.resolveCabinetLaunch(options).cabinetId
  },

  resolveCabinetLaunch(options = {}) {
    const query = options.query || {}
    const queryScene = query.scene !== undefined && query.scene !== null ? String(query.scene) : ''
    const directScene = !queryScene && typeof options.scene === 'string' && !/^\d+$/.test(options.scene.trim()) ? options.scene : ''
    const rawScene = queryScene || directScene
    const rawCabinetId = query.cabinetId !== undefined && query.cabinetId !== null ? String(query.cabinetId) : ''
    const rawValue = rawScene || rawCabinetId
    const hasCabinetParameter = Boolean(queryScene || directScene || query.cabinetId !== undefined)
    if (!rawValue) return { cabinetId: null, hasCabinetParameter, token: '' }

    let value = rawValue.trim()
    try { value = decodeURIComponent(value) } catch (error) {}
    const matched = value.match(/(?:^|[?&])cabinetId=([^&#]+)/i)
    if (matched) {
      try { value = decodeURIComponent(matched[1]) } catch (error) { value = matched[1] }
    }
    const cabinetId = normalizeCabinetId(value)
    return {
      cabinetId: cabinetId || null,
      hasCabinetParameter: true,
      token: `${rawScene ? 'scene' : 'cabinetId'}:${rawValue}`
    }
  },

  handleLaunchOptions(options = {}) {
    const launch = this.resolveCabinetLaunch(options)
    if (!launch.cabinetId) {
      if (launch.hasCabinetParameter) wx.showToast({ title: '无效柜体二维码', icon: 'none' })
      return Promise.resolve(null)
    }

    const isSamePendingLaunch = this.launchCabinetPromise && this.lastHandledLaunchScene === launch.token
    if (isSamePendingLaunch) return this.launchCabinetPromise

    const alreadyConnected = this.globalData.currentCabinetId === launch.cabinetId && bluetoothService.isConnectedTo(launch.cabinetId)
    if (this.lastHandledLaunchScene === launch.token && alreadyConnected) return Promise.resolve(this.globalData.currentCabinet)

    this.lastHandledLaunchScene = launch.token
    const launchPromise = this.handleScannedCabinet(launch.cabinetId)
      .catch(error => {
        if (error.message !== 'AUTH_REQUIRED' && error.message !== 'PRIVACY_CONSENT_REQUIRED') {
          cabinetSessionService.clearPendingCabinetId()
          if (!this.showCabinetUnavailable(error, launch.cabinetId)) wx.showToast({ title: '无效柜体二维码', icon: 'none' })
        }
        return null
      })
      .then(result => {
        if (this.launchCabinetPromise === launchPromise) this.launchCabinetPromise = null
        return result
      })
    this.launchCabinetPromise = launchPromise
    return launchPromise
  },

  handleScannedCabinet(cabinetId) {
    cabinetSessionService.setPendingCabinetId(cabinetId)
    operationLogService.log(ACTIONS.SCAN_CABINET, { cabinetId })
    return this.enterCabinet(cabinetId)
  },

  enterCabinet(cabinetId) {
    const targetCabinetId = String(cabinetId || '').trim()
    if (!targetCabinetId) return Promise.reject(new Error('CABINET_ID_REQUIRED'))
    cabinetSessionService.setPendingCabinetId(targetCabinetId)
    return permissionGuard.requireAccess({ roles: permissionGuard.CABINET_ACCESS_ROLES })
      .then(() => this.activateCabinet(targetCabinetId))
      .then(result => {
        cabinetSessionService.clearPendingCabinetId()
        return result
      })
  },

  switchCabinet(cabinetId) { return this.enterCabinet(cabinetId) },

  resumePendingCabinet() {
    const cabinetId = cabinetSessionService.getPendingCabinetId()
    if (!cabinetId) return Promise.resolve(null)
    return this.enterCabinet(cabinetId)
  },

  activateCabinet(targetCabinetId) {
    const previousCabinetId = this.globalData.currentCabinetId
    return cabinetRepository.loadCabinet(targetCabinetId)
      .then(cabinet => {
        const connection = bluetoothService.getConnectionState()
        const mustDisconnect = Boolean(connection.cabinetId && connection.cabinetId !== targetCabinetId)
        const disconnect = mustDisconnect
          ? bluetoothService.disconnectController().then(() => operationLogService.log(ACTIONS.BLE_DISCONNECTED, { cabinetId: connection.cabinetId }))
          : Promise.resolve()
        return disconnect.then(() => cabinet)
      })
      .then(cabinet => {
        this.globalData.currentCabinetId = cabinet.id
        this.globalData.currentCabinet = cabinet
        eventBus.emit('cabinet:changed', { cabinetId: cabinet.id, cabinet, previousCabinetId })
        if (previousCabinetId && previousCabinetId !== cabinet.id) {
          operationLogService.log(ACTIONS.SWITCH_CABINET, { cabinetId: cabinet.id, detail: { previousCabinetId } })
        }
        if (bluetoothService.isConnectedTo(cabinet.id)) return bluetoothService.getConnectionState()
        const connectionAttemptId = `ble-${Date.now()}-${Math.floor(Math.random() * 1000000)}`
        operationLogService.log(ACTIONS.BLE_CONNECT_START, {
          cabinetId: cabinet.id,
          connectionAttemptId
        })
        // 计时覆盖完整的 autoConnect 链路（扫描、GATT、Notify、IDENTIFY），
        // 不把前置的日志写入时间算入连接耗时。
        const connectionStartedAtMs = Date.now()
        return bluetoothService.autoConnect(cabinet)
          .then(state => {
            const durationMs = Date.now() - connectionStartedAtMs
            if (IS_DEVELOPMENT) console.info('[BLE_CONNECT_TIMING]', { connectionAttemptId, cabinetId: cabinet.id, startedAtMs: connectionStartedAtMs, durationMs, status: 'SUCCESS' })
            operationLogService.log(ACTIONS.BLE_CONNECT_SUCCESS, {
              cabinetId: cabinet.id,
              connectionAttemptId,
              durationMs
            })
            return state
          })
          .catch(error => {
            const durationMs = Date.now() - connectionStartedAtMs
            if (IS_DEVELOPMENT) console.info('[BLE_CONNECT_TIMING]', { connectionAttemptId, cabinetId: cabinet.id, startedAtMs: connectionStartedAtMs, durationMs, status: 'FAILED', errorCode: error && error.message })
            operationLogService.log(ACTIONS.BLE_CONNECT_FAILED, {
              cabinetId: cabinet.id,
              connectionAttemptId,
              durationMs,
              result: 'FAILED',
              detail: { reason: error.message }
            })
            throw error
          })
      })
  },

  deactivateCurrentCabinet(cabinetId) {
    if (this.globalData.currentCabinetId !== cabinetId) return Promise.resolve()
    return bluetoothService.disconnectController().catch(() => {}).then(() => {
      this.globalData.currentCabinetId = null
      this.globalData.currentCabinet = null
      eventBus.emit('cabinet:changed', { cabinetId: '', cabinet: null, previousCabinetId: cabinetId })
    })
  },

  showCabinetUnavailable(error, cabinetId = '') {
    const messages = {
      CABINET_DISABLED: ['该柜体维修中', '请使用附近其他湖\'s Takeaway柜体。如有外卖已存入，请联系客服处理。'],
      CABINET_MAINTENANCE: ['该柜体正在维修', '整台柜体暂时无法存餐或取餐，请使用附近其他柜体。如有外卖已存入，请联系客服处理。'],
      CABINET_PROVISIONING: ['该柜体正在初始化', '柜格数据尚未准备完成，请稍后再试。当前不会连接该柜体 BLE。'],
      CABINET_NOT_ACTIVE: ['该柜体尚未启用', '当前柜体暂不可使用，也不会连接 BLE，请联系客服确认。'],
      CABINET_NOT_FOUND: ['未找到该柜体', '二维码可能已失效，请联系客服确认。']
    }
    const message = messages[error && error.message]
    if (!message) return false
    wx.showModal({
      title: message[0],
      content: message[1],
      showCancel: true,
      cancelText: '知道了',
      confirmText: '联系客服',
      success: result => {
        if (!result.confirm) return
        const query = cabinetId ? `?cabinetId=${encodeURIComponent(cabinetId)}` : ''
        wx.navigateTo({ url: `/pages/customer-service/customer-service${query}` })
      }
    })
    return true
  },

  subscribeCurrentCabinet(callback) { return eventBus.on('cabinet:changed', callback) }
})

const permissionGuard = require('../../services/permissionGuard')
const analyticsService = require('../../services/analyticsService')

const RANGES = [
  { key: 'TODAY', label: '今天' },
  { key: 'LAST_7_DAYS', label: '近7天' },
  { key: 'LAST_30_DAYS', label: '近30天' },
  { key: 'CUSTOM', label: '自定义' }
]
const METRIC_CONFIGS = [
  { key: 'deposits', label: '存餐次数', chartTitle: '存餐次数趋势', yAxisLabel: '次数', unit: '次', type: 'count' },
  { key: 'pickups', label: '取餐次数', chartTitle: '取餐次数趋势', yAxisLabel: '次数', unit: '次', type: 'count' },
  { key: 'unlockRate', label: '开锁成功率', chartTitle: '开锁成功率趋势', yAxisLabel: '成功率（%）', unit: '%', type: 'percentage' },
  { key: 'averageConnectTime', label: '平均连接时间', chartTitle: '平均连接时间趋势', yAxisLabel: '秒', unit: '秒', type: 'durationSeconds' },
  { key: 'maintenance', label: '当前维修柜格数', chartTitle: '维修柜格数趋势', yAxisLabel: '柜格数', unit: '格', type: 'count' },
  { key: 'support', label: '客服介入次数', chartTitle: '客服介入次数趋势', yAxisLabel: '次数', unit: '次', type: 'count' }
]
const METRIC_MAP = METRIC_CONFIGS.reduce((map, item) => { map[item.key] = item; return map }, {})
const TREND_CANVAS_WIDTH = 642
const TREND_CANVAS_HEIGHT = 360
const TREND_STAGE_LEFT_RPX = 54
const TREND_LAYOUT = Object.freeze({ left: 76, right: 42, top: 28, bottom: 76 })
const AXIS_FONT_SIZE = 12
const ANALYTICS_ERRORS = {
  ROLE_FORBIDDEN: '无权查看运营分析',
  ANALYTICS_CUSTOM_DATE_INVALID: '日期格式不正确，请重新选择',
  ANALYTICS_CUSTOM_START_AFTER_END: '开始日期不能晚于结束日期',
  ANALYTICS_CUSTOM_END_IN_FUTURE: '结束日期不能晚于今天'
}

function getXAxisLabelStep(count, granularity) {
  if (granularity === 'HOUR') return 4
  if (count <= 7) return 1
  if (count <= 14) return 2
  if (count <= 31) return 5
  return Math.ceil((count - 1) / 6)
}

function buildNiceYAxis(values, options = {}) {
  if (options.percentage) {
    return { min: 0, max: 100, step: 20, ticks: [0, 20, 40, 60, 80, 100] }
  }

  const numbers = (values || [])
    .filter(value => value !== null && value !== undefined && Number.isFinite(Number(value)))
    .map(value => Number(value))
  const maxValue = Math.max(0, ...numbers)
  if (maxValue === 0) return { min: 0, max: 5, step: 1, ticks: [0, 1, 2, 3, 4, 5] }

  const rawStep = maxValue / 5
  const exponent = Math.floor(Math.log10(rawStep))
  const base = 10 ** exponent
  const fraction = rawStep / base
  const niceFractions = [1, 2, 2.5, 5, 10]
  const fractionChoice = niceFractions.reduce((best, candidate) => (
    Math.abs(candidate - fraction) < Math.abs(best - fraction) ? candidate : best
  ), niceFractions[0])
  let step = fractionChoice * base
  step = Math.max(1, Math.round(step))
  if (maxValue <= 5) step = 1

  let max = Math.ceil(maxValue / step) * step
  const nextNiceStep = value => {
    const nextExponent = Math.floor(Math.log10(value))
    const nextBase = 10 ** nextExponent
    const nextFractions = [1, 2, 2.5, 5, 10]
    const next = nextFractions.map(item => item * nextBase).find(item => item > value + Number.EPSILON)
    return next || 10 ** (nextExponent + 1)
  }
  while (max / step > 6) {
    step = Math.max(1, Math.round(nextNiceStep(step)))
    max = Math.ceil(maxValue / step) * step
  }
  if (max <= 5) { step = 1; max = 5 }
  const ticks = []
  for (let value = 0; value <= max + step / 10; value += step) ticks.push(Math.round(value))
  return { min: 0, max, step, ticks }
}

function buildNiceDurationYAxis(values) {
  const numbers = (values || [])
    .filter(value => value !== null && value !== undefined && Number.isFinite(Number(value)))
    .map(value => Number(value))
  const maxValue = Math.max(0, ...numbers)
  if (maxValue === 0) return { min: 0, max: 1, step: 0.2, ticks: [0, 0.2, 0.4, 0.6, 0.8, 1] }

  const rawStep = maxValue / 5
  const exponent = Math.floor(Math.log10(rawStep))
  const base = 10 ** exponent
  const fraction = rawStep / base
  const niceFractions = [1, 2, 2.5, 5, 10]
  const fractionChoice = niceFractions.find(item => item >= fraction) || 10
  const step = fractionChoice * base
  const max = Math.ceil(maxValue / step) * step
  const ticks = []
  for (let value = 0; value <= max + step / 10; value += step) ticks.push(Number(value.toFixed(6)))
  return { min: 0, max, step, ticks }
}

function formatMetric(item) {
  if (!item || item.value === null || item.value === undefined) return { ...(item || {}), displayValue: '暂无数据' }
  if (item.format === 'percent') return { ...item, displayValue: `${Number(item.value).toFixed(1)}%` }
  if (item.format === 'durationMs') return { ...item, displayValue: `${(Number(item.value) / 1000).toFixed(2)}秒` }
  if (item.format === 'duration') return { ...item, displayValue: item.value < 60 ? `${Math.round(item.value)}秒` : `${(item.value / 60).toFixed(1)}分钟` }
  return { ...item, displayValue: String(item.value) }
}

Page({
  data: {
    authorized: false, loading: false, errorMessage: '', range: 'LAST_7_DAYS', ranges: RANGES,
    rangeText: '近7天', metrics: [], trend: { hasData: false, labels: [], series: [], granularity: 'DAY' },
    customPanelVisible: false, customStartDate: '', customEndDate: '', beijingTodayDate: '',
    appliedCustomStartDate: '', appliedCustomEndDate: '', customRangeText: '', customErrorMessage: '',
    selectedMetric: 'deposits', selectedMetricConfig: METRIC_MAP.deposits, chartHasData: false, selectedPoint: null,
    trendCanvasWidth: TREND_CANVAS_WIDTH, trendCanvasHeight: TREND_CANVAS_HEIGHT
  },
  onLoad() {
    const system = wx.getSystemInfoSync()
    this.trendWindowWidth = Math.max(1, Number(system.windowWidth) || 375)
    this.trendRpxScale = this.trendWindowWidth / 750
    this.trendCanvasWidth = Math.max(1, Math.round(TREND_CANVAS_WIDTH * this.trendRpxScale))
    this.trendCanvasHeight = Math.max(1, Math.round(TREND_CANVAS_HEIGHT * this.trendRpxScale))
    console.info('[ANALYTICS_CANVAS_DIAGNOSTIC]', {
      api: 'legacy CanvasContext',
      windowWidth: this.trendWindowWidth,
      dpr: Number(system.pixelRatio) || 1,
      cssWidthRpx: TREND_CANVAS_WIDTH,
      cssHeightRpx: TREND_CANVAS_HEIGHT,
      cssWidthPx: this.trendCanvasWidth,
      cssHeightPx: this.trendCanvasHeight,
      logicalWidth: this.trendCanvasWidth,
      logicalHeight: this.trendCanvasHeight,
      ctxScaleCalls: 0
    })
    this.setData({
      trendCanvasWidth: this.trendCanvasWidth,
      trendCanvasHeight: this.trendCanvasHeight
    })
    permissionGuard.requireAccess({ roles: permissionGuard.MANAGEMENT_ROLES }).then(() => {
      this.setData({ authorized: true })
      this.loadAnalytics()
    }).catch(() => {})
  },
  onPullDownRefresh() {
    const request = this.data.authorized ? this.loadAnalytics() : Promise.resolve()
    request.finally(() => wx.stopPullDownRefresh())
  },
  chooseRange(event) {
    const range = event.currentTarget.dataset.range
    if (range === 'CUSTOM') {
      this.setData({ customPanelVisible: true, customErrorMessage: '' })
      return
    }
    if (this.loading) return
    const found = RANGES.find(item => item.key === range)
    this.setData({ range, rangeText: found ? found.label : '近7天', customPanelVisible: false, customErrorMessage: '', selectedPoint: null })
    this.loadAnalytics()
  },
  chooseCustomStartDate(event) { this.setData({ customStartDate: event.detail.value, customErrorMessage: '' }) },
  chooseCustomEndDate(event) { this.setData({ customEndDate: event.detail.value, customErrorMessage: '' }) },
  confirmCustomRange() {
    if (this.loading) return
    const { customStartDate: startDate, customEndDate: endDate, beijingTodayDate } = this.data
    let message = ''
    if (!beijingTodayDate) message = '日期信息暂不可用，请刷新重试'
    else if (!/^\d{4}-\d{2}-\d{2}$/.test(startDate) || !/^\d{4}-\d{2}-\d{2}$/.test(endDate)) message = '请选择开始日期和结束日期'
    else if (startDate > endDate) message = '开始日期不能晚于结束日期'
    else if (endDate > beijingTodayDate) message = '结束日期不能晚于今天'
    if (message) {
      this.setData({ customErrorMessage: message })
      wx.showToast({ title: message, icon: 'none' })
      return
    }
    const startLabel = startDate.slice(5).replace('-', '/')
    const endLabel = endDate.slice(5).replace('-', '/')
    this.setData({
      range: 'CUSTOM', rangeText: startDate === endDate ? startLabel : `${startLabel}-${endLabel}`,
      appliedCustomStartDate: startDate, appliedCustomEndDate: endDate,
      customRangeText: `${startDate.replace(/-/g, '/')} - ${endDate.replace(/-/g, '/')}`,
      customPanelVisible: false, customErrorMessage: '', selectedPoint: null
    })
    return this.loadAnalytics()
  },
  selectMetric(event) {
    const key = event.currentTarget.dataset.metric
    const config = METRIC_MAP[key]
    if (!config) return
    this.setData({ selectedMetric: key, selectedMetricConfig: config, selectedPoint: null })
    setTimeout(() => this.drawTrend(this.data.trend), 30)
  },
  loadAnalytics() {
    if (this.loading) return Promise.resolve()
    this.loading = true
    this.setData({ loading: true, errorMessage: '' })
    const query = { tab: 'overview', range: this.data.range }
    if (this.data.range === 'CUSTOM') {
      query.startDate = this.data.appliedCustomStartDate
      query.endDate = this.data.appliedCustomEndDate
    }
    return analyticsService.getAnalytics(query).then(result => {
      const metrics = (result.metrics || []).map(formatMetric)
      const trend = result.trend || { hasData: false, labels: [], series: [], granularity: 'DAY' }
      const dates = result.range || {}
      const datePatch = {}
      if (dates.todayDate) datePatch.beijingTodayDate = dates.todayDate
      if (!this.data.customStartDate && dates.defaultCustomStartDate) datePatch.customStartDate = dates.defaultCustomStartDate
      if (!this.data.customEndDate && dates.defaultCustomEndDate) datePatch.customEndDate = dates.defaultCustomEndDate
      this.setData({ ...datePatch, metrics, trend, loading: false, selectedPoint: null })
      setTimeout(() => this.drawTrend(trend), 50)
      return result
    }).catch(error => {
      this.setData({ loading: false, errorMessage: ANALYTICS_ERRORS[error.message] || '运营数据加载失败' })
      return null
    }).finally(() => { this.loading = false })
  },
  retry() { this.loadAnalytics() },
  getSelectedSeries(trend) { return (trend.series || []).find(item => item.key === this.data.selectedMetric) || null },
  chartValue(value) {
    if (value === null || value === undefined || Number.isNaN(Number(value))) return ''
    const config = this.data.selectedMetricConfig
    if (config.type === 'durationSeconds') return `${Number(value).toFixed(2)}秒`
    return config.type === 'percentage' ? `${Number(value).toFixed(1)}%` : `${Math.round(Number(value))}${config.unit}`
  },
  formatPointLabel(label) {
    const text = String(label || '')
    const date = text.match(/^(\d{1,2})\/(\d{1,2})$/)
    if (date) return `${date[1]}月${date[2]}日`
    return /^\d{2}$/.test(text) ? `${text}:00` : text
  },
  buildTooltipPoint(point) {
    const hasAverageCount = this.data.selectedMetric === 'averageConnectTime' && point.success !== null && point.success !== undefined
    const hasCounts = !hasAverageCount && point.success !== null && point.success !== undefined && point.attempts !== null && point.attempts !== undefined
    const tooltipWidth = 270; const tooltipHeight = hasAverageCount || hasCounts ? 126 : 96; const stageWidth = TREND_CANVAS_WIDTH; const stageHeight = TREND_CANVAS_HEIGHT; const safe = 10
    const scale = this.trendRpxScale || 1
    const pointX = point.x / scale
    const pointY = point.y / scale
    let left = pointX - tooltipWidth / 2
    left = Math.max(safe, Math.min(stageWidth - tooltipWidth - safe, left))
    let top = pointY - tooltipHeight - 24; let placement = 'above'
    if (top < safe) { top = Math.min(stageHeight - tooltipHeight - safe, pointY + 24); placement = 'below' }
    const arrowLeft = Math.max(22, Math.min(tooltipWidth - 34, pointX - left - 12))
    return { ...point, style: `left:${left}rpx;top:${top}rpx;`, arrowStyle: `left:${arrowLeft}rpx;`, placement, displayValue: this.chartValue(point.value), hasCounts, hasAverageCount }
  },
  selectChartPoint(point) {
    if (!point || (this.data.selectedPoint && this.data.selectedPoint.index === point.index)) return
    this.setData({ selectedPoint: this.buildTooltipPoint(point) })
    setTimeout(() => this.drawTrend(this.data.trend), 0)
  },
  drawTrend(trend) {
    const width = this.trendCanvasWidth || Math.max(1, Math.round(TREND_CANVAS_WIDTH * (this.trendRpxScale || 1)))
    const height = this.trendCanvasHeight || Math.max(1, Math.round(TREND_CANVAS_HEIGHT * (this.trendRpxScale || 1)))
    const scale = this.trendRpxScale || width / TREND_CANVAS_WIDTH || 1
    const { left: designLeft, right: designRight, top: designTop, bottom: designBottom } = TREND_LAYOUT
    const left = designLeft * scale; const right = designRight * scale; const top = designTop * scale; const bottom = designBottom * scale
    const series = this.getSelectedSeries(trend)
    const values = series && Array.isArray(series.values) ? series.values : []
    const isDuration = this.data.selectedMetricConfig.type === 'durationSeconds'
    const chartValues = isDuration ? values.map(value => value === null || value === undefined ? null : Number(value) / 1000) : values
    const validValues = chartValues.filter(value => value !== null && value !== undefined && Number.isFinite(Number(value))).map(Number)
    const hasData = validValues.length > 0
    const yAxis = isDuration
      ? buildNiceDurationYAxis(chartValues)
      : buildNiceYAxis(chartValues, { percentage: this.data.selectedMetricConfig.type === 'percentage' })
    this.chartPoints = []
    if (!hasData) {
      this.setData({ chartHasData: false })
      return
    }
    this.setData({ chartHasData: hasData }, () => {
      const ctx = wx.createCanvasContext('analyticsTrend', this)
      ctx.clearRect(0, 0, width, height)
      const plotRect = { left, top, right: width - right, bottom: height - bottom }
      const plotWidth = plotRect.right - plotRect.left; const plotHeight = plotRect.bottom - plotRect.top
      const pointCount = Math.max(1, chartValues.length - 1)
      const axisFontSize = AXIS_FONT_SIZE
      ctx.setStrokeStyle('#eadedf'); ctx.setLineWidth(Math.max(1, scale)); ctx.setFillStyle('#806d6e'); ctx.setFontSize(axisFontSize)
      if (typeof ctx.setTextAlign === 'function') ctx.setTextAlign('right')
      yAxis.ticks.forEach(value => {
        const y = plotRect.top + plotHeight * (1 - (value - yAxis.min) / (yAxis.max - yAxis.min))
        ctx.beginPath(); ctx.moveTo(plotRect.left, y); ctx.lineTo(plotRect.right, y); ctx.stroke()
        ctx.fillText(this.data.selectedMetricConfig.type === 'percentage' ? `${value}%` : String(value), plotRect.left - 10 * scale, y + 4 * scale)
      })
      if (typeof ctx.setTextAlign === 'function') ctx.setTextAlign('left')
      const labels = trend.labels || []
      const labelStep = getXAxisLabelStep(labels.length, trend.granularity)
      labels.forEach((label, index) => {
        if (index % labelStep !== 0 && index !== labels.length - 1) return
        const x = plotRect.left + plotWidth * index / pointCount
        ctx.fillText(String(label), Math.max(plotRect.left - 8 * scale, Math.min(plotRect.right - 35 * scale, x - 15 * scale)), height - 42 * scale)
      })
      ctx.setFillStyle('#806d6e'); ctx.setFontSize(axisFontSize); if (typeof ctx.setTextAlign === 'function') ctx.setTextAlign('left'); ctx.fillText(this.data.selectedMetricConfig.yAxisLabel, 8 * scale, 16 * scale); ctx.fillText(trend.granularity === 'HOUR' ? '时间' : '日期', width / 2 - 18 * scale, height - 12 * scale)
      const points = chartValues.map((value, index) => {
        if (value === null || value === undefined || !Number.isFinite(Number(value))) return null
        const valueTopPadding = Math.min(14 * scale, plotHeight * 0.1)
        const valuePlotHeight = plotHeight - valueTopPadding
        const x = plotRect.left + plotWidth * index / pointCount; const y = plotRect.top + valueTopPadding + valuePlotHeight * (1 - (Number(value) - yAxis.min) / (yAxis.max - yAxis.min))
        return { x, y, index, value: Number(value), label: this.formatPointLabel(labels[index]), success: series.successValues ? series.successValues[index] : null, attempts: series.attemptValues ? series.attemptValues[index] : null }
      })
      this.chartPoints = points
      if (this.data.selectedPoint) {
        const active = points.find(point => point && point.index === this.data.selectedPoint.index)
        if (active) { ctx.beginPath(); ctx.setStrokeStyle('#e8bfc1'); ctx.setLineWidth(Math.max(1, 2 * scale)); ctx.moveTo(active.x, active.y); ctx.lineTo(active.x, plotRect.bottom); ctx.stroke() }
      }
      ctx.setStrokeStyle('#c03338'); ctx.setLineWidth(Math.max(1, 4 * scale)); ctx.beginPath(); let started = false
      points.forEach(point => { if (!point) { started = false; return } if (!started) { ctx.moveTo(point.x, point.y); started = true } else ctx.lineTo(point.x, point.y) })
      ctx.stroke()
      points.filter(Boolean).forEach(point => {
        const selected = this.data.selectedPoint && this.data.selectedPoint.index === point.index
        ctx.beginPath(); ctx.setFillStyle(selected ? '#fff' : '#c03338'); ctx.setStrokeStyle('#c03338'); ctx.setLineWidth(Math.max(1, (selected ? 5 : 2) * scale)); ctx.arc(point.x, point.y, (selected ? 10 : 6) * scale, 0, Math.PI * 2); ctx.fill(); ctx.stroke()
      })
      ctx.draw(false)
    })
  },
  onChartTouch(event) {
    this.updateChartPointFromTouch(event)
  },
  onChartTouchMove(event) {
    this.updateChartPointFromTouch(event)
  },
  updateChartPointFromTouch(event) {
    if (!this.chartPoints || !this.chartPoints.length) return
    const touch = event.touches && event.touches[0]
    if (!touch) return
    const interactivePoints = this.chartPoints.filter(point => {
      if (!point) return false
      if (!Number.isFinite(Number(point.x)) || !Number.isFinite(Number(point.y))) return false
      if (point.value === null || point.value === undefined) return false
      return Number.isFinite(Number(point.value))
    })
    if (!interactivePoints.length) {
      if (this.data.selectedPoint) this.setData({ selectedPoint: null })
      return
    }
    const system = wx.getSystemInfoSync()
    const canvasWidth = this.trendCanvasWidth || Math.max(1, system.windowWidth * TREND_CANVAS_WIDTH / 750)
    const hasLocalX = touch.x !== undefined && touch.x !== null
    const rawX = Number(hasLocalX ? touch.x : (touch.pageX !== undefined ? touch.pageX : touch.clientX))
    if (!Number.isFinite(rawX)) return
    const localCssX = hasLocalX ? rawX : rawX - system.windowWidth * TREND_STAGE_LEFT_RPX / 750
    const x = localCssX
    const point = interactivePoints.reduce((nearest, current) => !nearest || Math.abs(current.x - x) < Math.abs(nearest.x - x) ? current : nearest, null)
    if (!point) return
    this.selectChartPoint(point)
  }
})

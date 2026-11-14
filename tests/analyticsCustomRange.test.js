const test = require('node:test')
const assert = require('node:assert/strict')
const fs = require('node:fs')
const path = require('node:path')
const vm = require('node:vm')
const time = require('../cloudfunctions/getOperationsAnalytics/beijingTime')
const NOW = Date.parse('2026-10-17T15:45:00Z')
const RANGE = { range: 'CUSTOM', startDate: '2026-09-01', endDate: '2026-10-17' }

function createBackend() {
  const days = time.bucketRange(time.dateRange(RANGE, NOW)).starts
  const dataset = {
    users: [{ _id: 'admin-test', role: 'ADMIN' }], privacyConsents: [{}],
    operationEvents: days.flatMap(start => ['BLE_CONNECT_SUCCESS', 'UNLOCK_ATTEMPT', 'UNLOCK_SUCCESS', 'CUSTOMER_SERVICE_UNLOCK'].map(type => ({ type, createdAt: new Date(start + 12 * 3600000).toISOString(), durationMs: 1000 }))),
    operationLogs: [],
    depositRecords: days.map(start => ({ storedAt: new Date(start + 12 * 3600000).toISOString(), pickedAt: new Date(start + 13 * 3600000).toISOString() })),
    maintenanceWorkOrders: [], lockers: [{ status: 'MAINTENANCE' }], cabinets: []
  }
  for (const [createdAt, durationMs] of [['2026-10-17T00:30:00+08:00', 2000], ['2026-10-17T23:30:00+08:00', 3000], ['2026-10-18T00:10:00+08:00', 9000]]) {
    dataset.operationEvents.push({ type: 'BLE_CONNECT_SUCCESS', createdAt, durationMs })
  }
  const reads = []
  const db = { collection(name) {
    reads.push(name)
    let offset = 0; let limit = 100
    const query = {
      where() { return query }, skip(value) { offset = value; return query }, limit(value) { limit = value; return query },
      doc() { return { async get() { return { data: { agreementVersion: 'test', privacyVersion: 'test' } } } } },
      async get() { return { data: (dataset[name] || []).slice(offset, offset + limit) } }
    }
    return query
  } }
  const cloud = { init() {}, database() { return db }, getWXContext() { return { OPENID: 'test' } } }
  const context = { exports: {}, require(name) {
    if (name === 'wx-server-sdk') return cloud
    if (name === './beijingTime') return { ...time, dateRange: input => time.dateRange(input, NOW) }
    throw new Error(`Unexpected module: ${name}`)
  } }
  vm.runInNewContext(fs.readFileSync(path.resolve(__dirname, '../cloudfunctions/getOperationsAnalytics/index.js'), 'utf8'), context)
  return { main: context.exports.main, reads, dataset }
}

test('自定义1/7/17/47个自然日完整分桶；单日保留24小时', () => {
  for (const [startDate, expected, granularity] of [['2026-10-17', 24, 'HOUR'], ['2026-10-11', 7, 'DAY'], ['2026-10-01', 17, 'DAY'], ['2026-09-01', 47, 'DAY']]) {
    const range = time.dateRange({ ...RANGE, startDate }, NOW)
    const buckets = time.bucketRange(range)
    assert.equal(range.granularity, granularity)
    assert.equal(buckets.starts.length, expected)
    assert.equal(buckets.keys.length, expected)
    assert.equal(range.endAt, '2026-10-17T16:00:00.000Z')
    assert.equal(buckets.labels.at(-1), granularity === 'HOUR' ? '23:00' : '10/17')
  }
  assert.equal(time.beijingDateKey(time.toMs('1970-01-01')), '1970-01-01')
  assert.equal(time.dateRange({ range: 'TODAY' }, time.toMs('1970-01-01')).startAt, '1969-12-31T16:00:00.000Z')
})

test('服务端拒绝格式错误、无效日历日期、逆序和未来日期，且不读取统计集合', async () => {
  const backend = createBackend()
  for (const [input, code] of [
    [{ startDate: '2026-10-18', endDate: '2026-10-17' }, 'ANALYTICS_CUSTOM_START_AFTER_END'],
    [{ startDate: '2026-10-17', endDate: '2026-10-18' }, 'ANALYTICS_CUSTOM_END_IN_FUTURE'],
    [{ startDate: '2026-02-30', endDate: '2026-10-17' }, 'ANALYTICS_CUSTOM_DATE_INVALID'],
    [{ startDate: '2026/10/01', endDate: '2026-10-17' }, 'ANALYTICS_CUSTOM_DATE_INVALID'],
    [{ startDate: Date.parse('2026-10-01T00:00:00+08:00'), endDate: '2026-10-17' }, 'ANALYTICS_CUSTOM_DATE_INVALID'],
    [{ startDate: '', endDate: '' }, 'ANALYTICS_CUSTOM_DATE_INVALID']
  ]) {
    const result = await backend.main({ range: 'CUSTOM', ...input })
    assert.equal(result.ok, false)
    assert.equal(result.error.code, code)
  }
  assert.equal(backend.reads.includes('operationEvents'), false)
})

test('analyticsService 原样透传自定义日期字符串，不转换为时间戳', async () => {
  const calls = []
  const moduleObject = { exports: {} }
  vm.runInNewContext(fs.readFileSync(path.resolve(__dirname, '../services/analyticsService.js'), 'utf8'), {
    module: moduleObject,
    require(name) {
      if (name.includes('permissionGuard')) return { assertRole() {}, MANAGEMENT_ROLES: ['ADMIN'] }
      if (name.includes('cloudAnalyticsRepository')) return { getAnalytics(input) { calls.push(input); return Promise.resolve(input) } }
      if (name.includes('config/env')) return { USE_CLOUD: true }
      throw new Error(`Unexpected module: ${name}`)
    }
  })
  await moduleObject.exports.getAnalytics(RANGE)
  assert.equal(calls[0].range, 'CUSTOM')
  assert.equal(calls[0].startDate, '2026-09-01')
  assert.equal(calls[0].endDate, '2026-10-17')
  assert.equal(typeof calls[0].startDate, 'string')
})

test('实际总览接口保留全部日点和六项口径，00:30/23:30落在所选单日内', async () => {
  const backend = createBackend()
  const before = JSON.stringify(backend.dataset)
  for (const [startDate, count, hours] of [['2026-10-17', 1, true], ['2026-10-11', 7, false], ['2026-10-01', 17, false], ['2026-09-01', 47, false]]) {
    const result = await backend.main({ ...RANGE, startDate, tab: 'overview' })
    assert.equal(result.ok, true)
    const metrics = Object.fromEntries(result.data.metrics.map(item => [item.key, item.value]))
    assert.equal(result.data.metrics.length, 6)
    assert.equal(metrics.deposits, count)
    assert.equal(metrics.pickups, count)
    assert.equal(metrics.unlockRate, 100)
    assert.equal(metrics.maintenance, 1)
    assert.equal(metrics.support, count)
    const average = result.data.trend.series.find(item => item.key === 'averageConnectTime')
    assert.equal(average.values.length, hours ? 24 : count)
    assert.equal(result.data.trend.labels.length, hours ? 24 : count)
    if (hours) {
      assert.equal(average.values[0], 2000)
      assert.equal(average.values[7], null)
      assert.equal(average.values[23], 3000)
      assert.equal(metrics.averageConnectTime, 2000)
    }
  }
  assert.equal(JSON.stringify(backend.dataset), before)
})

async function createPage() {
  const backend = createBackend()
  const requests = []; const toasts = []; const timers = []
  let definition
  const canvas = new Proxy({}, { get: () => () => {} })
  const context = {
    Page(value) { definition = value },
    Date: class { constructor() { throw new Error('Page must not parse dates with the device clock') } },
    console: { info() {} }, setTimeout(callback) { timers.push(callback) },
    wx: {
      getSystemInfoSync() { return { windowWidth: 375, pixelRatio: 3 } },
      createCanvasContext() { return canvas }, stopPullDownRefresh() {},
      showToast(options) { toasts.push(options.title) }
    },
    require(name) {
      if (name.includes('permissionGuard')) return { requireAccess: () => Promise.resolve(), MANAGEMENT_ROLES: ['ADMIN', 'DEVELOPER'] }
      if (name.includes('analyticsService')) return { async getAnalytics(input) {
        requests.push({ ...input })
        const result = await backend.main(input)
        if (!result.ok) throw new Error(result.error.code)
        return result.data
      } }
      throw new Error(`Unexpected module: ${name}`)
    }
  }
  vm.runInNewContext(fs.readFileSync(path.resolve(__dirname, '../pages/analytics/analytics.js'), 'utf8'), context)
  const page = { ...definition, data: JSON.parse(JSON.stringify(definition.data)), setData(patch, callback) { Object.assign(this.data, patch); if (callback) callback() } }
  async function settle() {
    await new Promise(setImmediate)
    for (let i = 0; timers.length; i += 1) { assert.ok(i < 100); timers.shift()() }
  }
  page.onLoad()
  await settle()
  return { page, requests, toasts, settle, labelStep: context.getXAxisLabelStep }
}

test('日期编辑不发请求；确认才生效，草稿与已确认范围分开并保留', async () => {
  const { page, requests, settle } = await createPage()
  assert.equal(page.data.beijingTodayDate, '2026-10-17')
  assert.equal(page.data.customStartDate, '2026-10-11')
  assert.equal(page.data.customEndDate, '2026-10-17')
  page.chooseRange({ currentTarget: { dataset: { range: 'CUSTOM' } } })
  page.chooseCustomStartDate({ detail: { value: '2026-10-01' } })
  assert.equal(requests.length, 1)
  await page.confirmCustomRange()
  await settle()
  assert.deepEqual(requests.at(-1), { tab: 'overview', range: 'CUSTOM', startDate: '2026-10-01', endDate: '2026-10-17' })
  assert.equal(page.data.rangeText, '10/01-10/17')
  assert.equal(page.data.customRangeText, '2026/10/01 - 2026/10/17')
  page.chooseRange({ currentTarget: { dataset: { range: 'CUSTOM' } } })
  page.chooseCustomStartDate({ detail: { value: '2026-09-01' } })
  await page.loadAnalytics()
  await settle()
  assert.equal(requests.at(-1).startDate, '2026-10-01')
  assert.equal(page.data.customStartDate, '2026-09-01')
  page.chooseRange({ currentTarget: { dataset: { range: 'LAST_7_DAYS' } } })
  assert.equal(page.data.selectedPoint, null)
  await settle()
  assert.equal(requests.at(-1).range, 'LAST_7_DAYS')
  page.chooseRange({ currentTarget: { dataset: { range: 'CUSTOM' } } })
  assert.equal(page.data.customStartDate, '2026-09-01')
  assert.equal(page.data.customPanelVisible, true)
})

test('前端逆序和未来日期提示明确且不发请求', async () => {
  const { page, requests, toasts } = await createPage()
  for (const [startDate, endDate, message] of [['2026-10-18', '2026-10-17', '开始日期不能晚于结束日期'], ['2026-10-17', '2026-10-18', '结束日期不能晚于今天']]) {
    page.chooseCustomStartDate({ detail: { value: startDate } })
    page.chooseCustomEndDate({ detail: { value: endDate } })
    await page.confirmCustomRange()
    assert.equal(toasts.at(-1), message)
    assert.equal(requests.length, 1)
  }
})

test('47天只抽样标签，最后一天仍可触摸；单日沿用小时和null/0规则', async () => {
  const { page, requests, settle, labelStep } = await createPage()
  page.chooseCustomStartDate({ detail: { value: '2026-09-01' } })
  await page.confirmCustomRange()
  await settle()
  assert.equal(page.chartPoints.length, 47)
  const step = labelStep(47, 'DAY')
  const labelIndices = Array.from({ length: 47 }, (_, index) => index).filter(index => index % step === 0 || index === 46)
  assert.ok(labelIndices.length >= 5 && labelIndices.length <= 7)
  page.onChartTouchMove({ touches: [{ x: page.chartPoints[46].x }] })
  await settle()
  assert.equal(page.data.selectedPoint.index, 46)
  assert.equal(page.data.selectedPoint.label, '10月17日')
  page.chooseCustomStartDate({ detail: { value: '2026-10-17' } })
  await page.confirmCustomRange()
  await settle()
  assert.equal(page.data.rangeText, '10/17')
  assert.equal(page.chartPoints.length, 24)
  page.onChartTouch({ touches: [{ x: page.chartPoints[0].x }] })
  await settle()
  assert.equal(page.data.selectedPoint.value, 0)
  page.selectMetric({ currentTarget: { dataset: { metric: 'averageConnectTime' } } })
  await settle()
  assert.equal(page.chartPoints[7], null)
  page.onChartTouchMove({ touches: [{ x: page.chartPoints[23].x }] })
  await settle()
  assert.equal(page.data.selectedPoint.label, '23:00')
  assert.equal(page.data.selectedPoint.displayValue, '3.00秒')
  assert.equal(labelStep(24, 'HOUR'), 4)
  assert.equal(labelStep(7, 'DAY'), 1)
  assert.equal(labelStep(30, 'DAY'), 5)
  assert.equal(requests.at(-1).startDate, '2026-10-17')
})

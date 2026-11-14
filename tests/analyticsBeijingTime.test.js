const test = require('node:test')
const assert = require('node:assert/strict')
const fs = require('node:fs')
const path = require('node:path')
const vm = require('node:vm')
const { spawnSync } = require('node:child_process')
const timePath = path.resolve(__dirname, '../cloudfunctions/getOperationsAnalytics/beijingTime.js')
const time = require(timePath)
const NOW = Date.parse('2026-10-17T15:45:00Z') // 北京时间23:45

function bucketIndex(buckets, value) {
  const ms = time.toMs(value)
  return buckets.starts.findIndex(start => ms >= start && ms < start + buckets.step)
}

test('Date、时间戳和带时区字符串保留绝对时间；无时区输入固定按北京时间解析', () => {
  const expected = Date.parse('2026-10-17T07:36:51Z')
  for (const value of [new Date(expected), expected, expected / 1000, { _seconds: expected / 1000 }, '2026-10-17T15:36:51+08:00', '2026-10-17 15:36:51 GMT+0800', '2026-10-17 15:36:51']) {
    assert.equal(time.toMs(value), expected)
  }
  assert.equal(time.toMs('2026-10-17'), Date.parse('2026-10-16T16:00:00Z'))
  assert.ok(Number.isNaN(time.toMs('2026-02-30 12:00:00')))
  assert.ok(Number.isNaN(time.toMs(null)))
})

test('今天使用北京时间午夜边界，并固定生成24小时桶', () => {
  const range = time.dateRange({ range: 'TODAY' }, NOW)
  assert.equal(range.startAt, '2026-10-16T16:00:00.000Z')
  assert.equal(range.endAt, '2026-10-17T16:00:00.000Z')
  const buckets = time.bucketRange(range)
  assert.equal(buckets.labels.length, 24)
  assert.equal(buckets.labels[0], '00:00')
  assert.equal(buckets.labels[23], '23:00')
  assert.equal(bucketIndex(buckets, '2026-10-17T15:36:51+08:00'), 15)
  assert.equal(bucketIndex(buckets, '2026-10-17T00:30:00+08:00'), 0)
  assert.equal(bucketIndex(buckets, '2026-10-17T23:30:00+08:00'), 23)
  assert.equal(bucketIndex(buckets, '2026-10-18T00:00:00+08:00'), -1)
  const nextDay = time.bucketRange(time.dateRange({ range: 'TODAY' }, Date.parse('2026-10-18T00:10:00+08:00')))
  assert.equal(bucketIndex(nextDay, '2026-10-18T00:10:00+08:00'), 0)
  assert.equal(nextDay.keys[0], '2026-10-18T00:00:00+08:00')
})

test('近7天和30天按包含今天的北京时间自然日分桶', () => {
  for (const [name, days, first] of [['LAST_7_DAYS', 7, '2026-10-11'], ['LAST_30_DAYS', 30, '2026-09-18']]) {
    const range = time.dateRange({ range: name }, NOW)
    const buckets = time.bucketRange(range)
    assert.equal(buckets.keys.length, days)
    assert.equal(buckets.keys[0], first)
    assert.equal(buckets.keys.at(-1), '2026-10-17')
    assert.equal(bucketIndex(buckets, '2026-10-17T00:30:00+08:00'), days - 1)
    assert.equal(bucketIndex(buckets, '2026-10-16T23:59:59.999+08:00'), days - 2)
  }
})

test('自定义只接受日历日期，包含结束整天并兼容旧日期型参数名', () => {
  const dates = time.dateRange({ range: 'CUSTOM', startAt: '2026-10-16', endAt: '2026-10-17' }, NOW)
  assert.equal(dates.startAt, '2026-10-15T16:00:00.000Z')
  assert.equal(dates.endAt, '2026-10-17T16:00:00.000Z')
  assert.deepEqual(time.bucketRange(dates).keys, ['2026-10-16', '2026-10-17'])
  const current = time.dateRange({ range: 'custom', startDate: '2026-10-16', endDate: '2026-10-17' }, NOW)
  assert.deepEqual(dates, current)
  assert.throws(() => time.dateRange({ range: 'CUSTOM', startAt: '2026-10-17 00:30:00', endAt: '2026-10-17 15:36:00' }, NOW), /ANALYTICS_CUSTOM_DATE_INVALID/)
})

test('UTC、上海、东京和洛杉矶运行环境生成完全一致的范围、标签和明细时间', () => {
  const script = `
    const t = require(${JSON.stringify(timePath)})
    const output = ['TODAY', 'LAST_7_DAYS', 'LAST_30_DAYS'].map(name => {
      const range = t.dateRange({ range: name }, ${NOW})
      return { range, buckets: t.bucketRange(range) }
    })
    output.push(t.formatBeijingDateTime('2026-10-17T00:30:00+08:00'))
    output.push(t.toMs('2026-10-17 15:36:51'))
    for (const startDate of ['2026-10-17', '2026-10-11', '2026-10-01', '2026-09-01']) {
      const range = t.dateRange({ range: 'CUSTOM', startDate, endDate: '2026-10-17' }, ${NOW})
      output.push({ range, buckets: t.bucketRange(range) })
    }
    console.log(JSON.stringify(output))
  `
  let expected
  for (const zone of ['UTC', 'Asia/Shanghai', 'Asia/Tokyo', 'America/Los_Angeles']) {
    const result = spawnSync(process.execPath, ['-e', script], { env: { ...process.env, TZ: zone }, encoding: 'utf8' })
    assert.equal(result.status, 0, result.stderr)
    if (expected === undefined) expected = result.stdout
    assert.equal(result.stdout, expected, zone)
  }
})

test('五个Tab共用同一北京时间范围，趋势进入15时桶，维修明细也按北京时间显示', async () => {
  const eventAt = '2026-10-17T15:36:51+08:00'
  const dataset = {
    users: [{ _id: 'test-admin', role: 'ADMIN' }], privacyConsents: [{}],
    operationEvents: [
      ...[['2026-10-17T00:30:00+08:00', 500], [eventAt, 1500], ['2026-10-17T23:30:00+08:00', 2500], ['2026-10-18T00:10:00+08:00', 3500]].map(([createdAt, durationMs]) => ({ type: 'BLE_CONNECT_SUCCESS', createdAt, durationMs })),
      ...['UNLOCK_ATTEMPT', 'UNLOCK_SUCCESS', 'CUSTOMER_SERVICE_UNLOCK', 'MAINTENANCE_CREATED', 'MAINTENANCE_RESOLVED'].map(type => ({ type, createdAt: eventAt, cabinetId: 'CABINET_001' }))
    ],
    operationLogs: [],
    depositRecords: [{ storedAt: '2026-10-17T00:30:00+08:00', pickedAt: eventAt, cabinetId: 'CABINET_001', lockerId: 1 }],
    maintenanceWorkOrders: [{ _id: 'order-test', cabinetId: 'CABINET_001', lockerId: 1, createdAt: '2026-10-17T00:30:00+08:00', resolvedAt: eventAt, status: 'RESOLVED' }],
    lockers: [], cabinets: []
  }
  const original = JSON.stringify(dataset)
  const db = { collection(name) {
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
    throw new Error(`Unexpected dependency: ${name}`)
  } }
  vm.runInNewContext(fs.readFileSync(path.resolve(__dirname, '../cloudfunctions/getOperationsAnalytics/index.js'), 'utf8'), context)
  const results = {}
  for (const tab of ['overview', 'usage', 'device', 'maintenance', 'support']) {
    const result = await context.exports.main({ tab, range: 'TODAY' })
    assert.equal(result.ok, true, JSON.stringify(result.error))
    assert.equal(result.data.range.startAt, '2026-10-16T16:00:00.000Z')
    assert.equal(result.data.range.timeZone, 'Asia/Shanghai')
    results[tab] = result.data
  }
  const metric = (tab, key) => results[tab].metrics.find(item => item.key === key).value
  const series = results.overview.trend.series.find(item => item.key === 'averageConnectTime')
  assert.equal(series.values.length, 24)
  assert.equal(series.values[0], 500)
  assert.equal(series.values[7], null)
  assert.equal(series.values[15], 1500)
  assert.equal(series.values[23], 2500)
  assert.equal(results.overview.trend.bucketKeys[15], '2026-10-17T15:00:00+08:00')
  assert.equal(metric('overview', 'averageConnectTime'), 1500)
  assert.equal(metric('overview', 'unlockRate'), 100)
  assert.equal(metric('usage', 'deposits'), 1)
  assert.equal(metric('device', 'bleSuccess'), 3)
  assert.equal(metric('support', 'intervention'), 1)
  assert.equal(results.maintenance.orders[0].createdAtText, '2026-10-17 00:30')
  assert.equal(results.maintenance.orders[0].resolvedAtText, '2026-10-17 15:36')
  assert.equal(JSON.stringify(dataset), original)
})

const cloud = require('wx-server-sdk')
cloud.init({ env: cloud.DYNAMIC_CURRENT_ENV })
const db = cloud.database()
const { toMs, dateRange, bucketRange, formatBeijingDateTime } = require('./beijingTime')

const EVENT = Object.freeze({
  QR_SCAN: 'QR_SCAN', BLE_CONNECT_ATTEMPT: 'BLE_CONNECT_ATTEMPT', BLE_CONNECT_SUCCESS: 'BLE_CONNECT_SUCCESS', BLE_CONNECT_FAILED: 'BLE_CONNECT_FAILED', IDENTIFY_SUCCESS: 'IDENTIFY_SUCCESS', IDENTIFY_FAILED: 'IDENTIFY_FAILED', UNLOCK_ATTEMPT: 'UNLOCK_ATTEMPT', UNLOCK_SUCCESS: 'UNLOCK_SUCCESS', UNLOCK_FAILED: 'UNLOCK_FAILED', DEPOSIT_CREATED: 'DEPOSIT_CREATED', PICKUP_COMPLETED: 'PICKUP_COMPLETED', MAINTENANCE_CREATED: 'MAINTENANCE_CREATED', MAINTENANCE_RESOLVED: 'MAINTENANCE_RESOLVED', CUSTOMER_SERVICE_UNLOCK: 'CUSTOMER_SERVICE_UNLOCK'
})
const ACTION = Object.freeze({ BLE_ATTEMPT: 'BLE_CONNECT_START', BLE_SUCCESS: 'BLE_CONNECT_SUCCESS', BLE_FAILED: 'BLE_CONNECT_FAILED', UNLOCK_SUCCESS: 'LOCK_OPEN_SUCCESS', UNLOCK_FAILED: 'LOCK_OPEN_FAILED', DEPOSIT: 'USER_CONFIRM_DEPOSIT', PICKUP: 'USER_PICKUP_SUCCESS', CS: 'CUSTOMER_SERVICE_UNLOCK_AUTH_CREATED', MAINT_CREATED: 'MAINTENANCE_ORDER_CREATED', MAINT_RESOLVED: 'MAINTENANCE_ORDER_RESOLVED' })
const ACTIVE_MAINTENANCE = ['PENDING', 'IN_PROGRESS', 'ONSITE', 'MANUAL_UNLOCK_COMPLETED', 'SELF_CHECK_PASSED']

async function requireManager() {
  const { OPENID } = cloud.getWXContext()
  const result = await db.collection('users').where({ openid: OPENID, status: 'ACTIVE' }).limit(1).get()
  const user = result.data[0]
  if (!user || !['ADMIN', 'DEVELOPER'].includes(user.role)) throw new Error('ROLE_FORBIDDEN')
  const legal = (await db.collection('systemConfig').doc('legal-current').get()).data
  const consent = await db.collection('privacyConsents').where({ userId: user._id, agreementVersion: legal.agreementVersion, privacyVersion: legal.privacyVersion }).limit(1).get()
  if (!consent.data[0]) throw new Error('PRIVACY_CONSENT_REQUIRED')
}

function inRange(value, range) { const time = toMs(value); return Number.isFinite(time) && time >= range.start && time < range.end }
async function readAll(name, max = 5000) {
  const rows = []
  try {
    for (let offset = 0; offset < max; offset += 100) {
      const result = await db.collection(name).skip(offset).limit(Math.min(100, max - offset)).get()
      rows.push(...(result.data || []))
      if (!result.data || result.data.length < 100) break
    }
  } catch (error) { return [] }
  return rows
}
function countBy(list, predicate) { return list.filter(predicate).length }
function rate(success, attempts) { return attempts > 0 ? Math.round(success * 10000 / attempts) / 100 : null }
function bucketCount(list, dateField, buckets, predicate = () => true) { return buckets.starts.map(start => countBy(list, item => predicate(item) && (() => { const time = toMs(item[dateField]); return Number.isFinite(time) && time >= start && time < start + buckets.step })())) }
function bucketRate(successRows, attemptRows, dateField, buckets) { return buckets.starts.map(start => { const inBucket = list => list.filter(item => { const time = toMs(item[dateField] || item.createdAt); return Number.isFinite(time) && time >= start && time < start + buckets.step }).length; return rate(inBucket(successRows), inBucket(attemptRows)) }) }
function bucketEventCount(list, buckets) { return buckets.starts.map(start => list.filter(item => { const time = toMs(item.createdAt); return Number.isFinite(time) && time >= start && time < start + buckets.step }).length) }
function bucketCountOrNull(list, dateField, buckets) { const values = bucketCount(list, dateField, buckets, () => true); return list.length ? values : values.map(() => null) }
function maintenanceTrend(orders, buckets) {
  const values = buckets.starts.map(start => {
    const pointTime = start + buckets.step - 1
    const activeTargets = new Set()
    orders.forEach(order => {
      if (!order.lockerId) return
      const created = toMs(order.createdAt || order.updatedAt)
      const resolved = toMs(order.resolvedAt)
      if (Number.isFinite(created) && created <= pointTime && (!Number.isFinite(resolved) || resolved > pointTime)) activeTargets.add(`${order.cabinetId || ''}:${normalizeLockerId(order.lockerId)}`)
    })
    return activeTargets.size
  })
  const relevant = orders.some(order => {
    const created = toMs(order.createdAt || order.updatedAt); const resolved = toMs(order.resolvedAt)
    return Number.isFinite(created) && created < buckets.starts[buckets.starts.length - 1] + buckets.step && (!Number.isFinite(resolved) || resolved > buckets.starts[0])
  })
  return relevant ? values : values.map(() => null)
}
function eventOrLog(events, logs, type, action, range) {
  const eventRows = events.filter(item => item.type === type && inRange(item.createdAt, range))
  if (eventRows.length) return eventRows
  return logs.filter(item => item.action === action && inRange(item.createdAt, range))
}
function hasValidDuration(row) {
  return Number.isFinite(Number(row && row.durationMs)) && Number(row.durationMs) >= 0
}
function averageDurationMs(rows) {
  const values = rows.filter(hasValidDuration).map(row => Number(row.durationMs))
  return values.length ? values.reduce((total, value) => total + value, 0) / values.length : null
}
function bucketAverageDurationMs(rows, buckets) {
  return buckets.starts.map(start => {
    const values = rows.filter(row => {
      if (!hasValidDuration(row)) return false
      const time = toMs(row.createdAt)
      return Number.isFinite(time) && time >= start && time < start + buckets.step
    }).map(row => Number(row.durationMs))
    return values.length ? values.reduce((total, value) => total + value, 0) / values.length : null
  })
}
function bucketDurationCount(rows, buckets) {
  return buckets.starts.map(start => rows.filter(row => {
    if (!hasValidDuration(row)) return false
    const time = toMs(row.createdAt)
    return Number.isFinite(time) && time >= start && time < start + buckets.step
  }).length)
}
function unlockAttemptRows(events, logs, range) {
  const eventRows = events.filter(item => item.type === EVENT.UNLOCK_ATTEMPT && inRange(item.createdAt, range))
  if (eventRows.length) return eventRows
  const actions = ['USER_OPEN_STORE_LOCK', 'USER_REOPEN_STORE_LOCK', 'USER_OPEN_PICKUP_LOCK', 'CUSTOMER_SERVICE_UNLOCK_ATTEMPT', 'ADMIN_OPEN_OCCUPIED_LOCKER']
  return logs.filter(item => actions.includes(item.action) && inRange(item.createdAt, range))
}
function metric(key, label, value, format = '') { return { key, label, value: value === undefined ? null : value, ...(format ? { format } : {}) } }
function normalizeLockerId(value) { const n = Number(value); return Number.isInteger(n) && n > 0 ? String(n) : String(value || '') }
function prettyOrder(item) { return { id: item._id, cabinetId: item.cabinetId || '', lockerId: item.lockerId ? normalizeLockerId(item.lockerId) : '', faultText: item.faultCode || item.reason || '未分类', statusText: item.status || '', createdAtText: formatBeijingDateTime(item.createdAt), resolvedAtText: formatBeijingDateTime(item.resolvedAt) } }

exports.main = async event => {
  try {
    await requireManager()
    const input = event && typeof event === 'object' ? event : {}
    const range = dateRange(input)
    const [events, logs, deposits, maintenance, lockers, cabinets] = await Promise.all([
      readAll('operationEvents'), readAll('operationLogs'), readAll('depositRecords'), readAll('maintenanceWorkOrders'), readAll('lockers'), readAll('cabinets')
    ])
    const scopedDeposits = deposits.filter(item => inRange(item.storedAt || item.createdAt, range))
    const scopedPickups = deposits.filter(item => inRange(item.pickedAt, range))
    const bleAttempts = eventOrLog(events, logs, EVENT.BLE_CONNECT_ATTEMPT, ACTION.BLE_ATTEMPT, range)
    const bleSuccess = eventOrLog(events, logs, EVENT.BLE_CONNECT_SUCCESS, ACTION.BLE_SUCCESS, range)
    const bleFailed = eventOrLog(events, logs, EVENT.BLE_CONNECT_FAILED, ACTION.BLE_FAILED, range)
    const unlockAttempts = unlockAttemptRows(events, logs, range)
    const unlockSuccess = eventOrLog(events, logs, EVENT.UNLOCK_SUCCESS, ACTION.UNLOCK_SUCCESS, range)
    const unlockFailed = eventOrLog(events, logs, EVENT.UNLOCK_FAILED, ACTION.UNLOCK_FAILED, range)
    const support = eventOrLog(events, logs, EVENT.CUSTOMER_SERVICE_UNLOCK, ACTION.CS, range)
    const maintenanceCreated = eventOrLog(events, logs, EVENT.MAINTENANCE_CREATED, ACTION.MAINT_CREATED, range)
    const maintenanceResolved = eventOrLog(events, logs, EVENT.MAINTENANCE_RESOLVED, ACTION.MAINT_RESOLVED, range)
    const buckets = bucketRange(range)
    const averageConnectDurationMs = averageDurationMs(bleSuccess)
    const tab = String(input.tab || 'overview')
    const base = { range, nextCursor: null }
    if (tab === 'overview') {
      return { ok: true, data: { ...base, metrics: [metric('deposits', '存餐次数', scopedDeposits.length), metric('pickups', '取餐次数', scopedPickups.length), metric('unlockRate', '开锁成功率', rate(unlockSuccess.length, unlockAttempts.length), 'percent'), metric('averageConnectTime', '平均连接时间', averageConnectDurationMs, 'durationMs'), metric('maintenance', '当前维修柜格数', lockers.filter(item => item.status === 'MAINTENANCE').length), metric('support', '客服介入次数', support.length)], trend: { hasData: Boolean(scopedDeposits.length || scopedPickups.length || unlockAttempts.length || bleAttempts.length || maintenanceCreated.length || support.length || averageConnectDurationMs !== null), granularity: range.granularity, labels: buckets.labels, bucketKeys: buckets.keys, series: [{ key: 'deposits', label: '存餐', values: bucketCountOrNull(scopedDeposits, 'storedAt', buckets) }, { key: 'pickups', label: '取餐', values: bucketCountOrNull(scopedPickups, 'pickedAt', buckets) }, { key: 'unlockRate', label: '开锁成功率', values: bucketRate(unlockSuccess, unlockAttempts, 'createdAt', buckets), successValues: bucketEventCount(unlockSuccess, buckets), attemptValues: bucketEventCount(unlockAttempts, buckets) }, { key: 'averageConnectTime', label: '平均连接时间', values: bucketAverageDurationMs(bleSuccess, buckets), successValues: bucketDurationCount(bleSuccess, buckets) }, { key: 'maintenance', label: '维修柜格数', values: maintenanceTrend(maintenance, buckets) }, { key: 'support', label: '客服介入次数', values: bucketCountOrNull(support, 'createdAt', buckets) }] } } }
    }
    if (tab === 'usage') {
      const counts = {}
      scopedDeposits.concat(scopedPickups).forEach(item => { const key = `${item.cabinetId || '未知'} · ${normalizeLockerId(item.lockerId)}`; counts[key] = (counts[key] || 0) + 1 })
      const ranking = Object.keys(counts).map(key => ({ key, label: key, value: counts[key] })).sort((a, b) => b.value - a.value)
      const active = new Set(scopedDeposits.concat(scopedPickups).map(item => item.cabinetId).filter(Boolean)).size
      return { ok: true, data: { ...base, metrics: [metric('scans', '扫码次数', events.filter(item => item.type === EVENT.QR_SCAN && inRange(item.createdAt, range)).length || null), metric('deposits', '存餐次数', scopedDeposits.length), metric('pickups', '取餐次数', scopedPickups.length), metric('activeCabinets', '活跃柜体数', active || null), metric('avgOccupancy', '平均占用时长', null, 'duration')], ranking } }
    }
    if (tab === 'device') {
      const lifetimeUnlockAttempts = lockers.reduce((sum, item) => sum + Math.max(0, Number(item.totalUnlockAttempts) || 0), 0)
      const lifetimeUnlockSuccesses = lockers.reduce((sum, item) => sum + Math.max(0, Number(item.totalUnlockSuccesses) || 0), 0)
      const lifetimeUnlockFailures = lockers.reduce((sum, item) => sum + Math.max(0, Number(item.totalUnlockFailures) || 0), 0)
      const ranking = cabinets.map(cabinet => { const id = cabinet._id; const failures = unlockFailed.filter(item => item.cabinetId === id).length; const attempts = unlockAttempts.filter(item => item.cabinetId === id).length; return { key: id, label: id, value: attempts ? `${rate(failures, attempts) || 0}%失败` : '暂无数据' } }).filter(item => item.value !== '暂无数据')
      return { ok: true, data: { ...base, metrics: [metric('bleAttempts', 'BLE连接尝试', bleAttempts.length || null), metric('bleSuccess', 'BLE连接成功', bleSuccess.length || null), metric('bleRate', 'BLE连接成功率', rate(bleSuccess.length, bleAttempts.length), 'percent'), metric('identifySuccess', 'IDENTIFY成功', eventOrLog(events, logs, EVENT.IDENTIFY_SUCCESS, '', range).length || null), metric('identifyFailed', 'IDENTIFY失败', eventOrLog(events, logs, EVENT.IDENTIFY_FAILED, '', range).length || null), metric('unlockAttempts', '开锁尝试', unlockAttempts.length || null), metric('unlockSuccess', '开锁成功', unlockSuccess.length || null), metric('unlockRate', '开锁成功率', rate(unlockSuccess.length, unlockAttempts.length), 'percent'), metric('lifetimeUnlockRate', '生命周期开锁成功率', rate(lifetimeUnlockSuccesses, lifetimeUnlockAttempts), 'percent'), metric('lifetimeUnlockAttempts', '历史开锁尝试', lifetimeUnlockAttempts || null), metric('lifetimeUnlockFailures', '历史开锁失败', lifetimeUnlockFailures || null), metric('maintenance', '当前维修柜格数', lockers.filter(item => item.status === 'MAINTENANCE').length)], ranking } }
    }
    if (tab === 'maintenance') {
      const orderRows = maintenance.filter(item => inRange(item.createdAt || item.updatedAt, range)).sort((a, b) => toMs(b.createdAt || b.updatedAt) - toMs(a.createdAt || a.updatedAt))
      const cursor = Math.max(0, Number(input.cursor) || 0); const items = orderRows.slice(cursor, cursor + 20).map(prettyOrder)
      const durations = maintenanceResolved.map(item => Math.max(0, toMs(item.resolvedAt) - toMs(item.createdAt))).filter(Number.isFinite)
      const repeated = new Set(orderRows.map(item => `${item.cabinetId}:${normalizeLockerId(item.lockerId)}`)).size
      return { ok: true, data: { ...base, metrics: [metric('autoCreated', '自动报修次数', maintenanceCreated.length || null), metric('resolved', '已完成维修数', maintenanceResolved.length || null), metric('pending', '当前待处理数', maintenance.filter(item => ACTIVE_MAINTENANCE.includes(item.status)).length || null), metric('avgDuration', '平均维修时长', durations.length ? durations.reduce((a, b) => a + b, 0) / durations.length : null, 'duration'), metric('repeated', '重复故障柜格', repeated || null)], orders: items, nextCursor: cursor + items.length < orderRows.length ? cursor + items.length : null } }
    }
    if (tab === 'support') {
      const counts = {}; support.forEach(item => { const key = `${item.cabinetId || '未知'}${item.lockerId ? ` · ${normalizeLockerId(item.lockerId)}号柜` : ''}`; counts[key] = (counts[key] || 0) + 1 })
      const successRows = eventOrLog(events, logs, EVENT.PICKUP_COMPLETED, ACTION.PICKUP, range)
      return { ok: true, data: { ...base, metrics: [metric('intervention', '客服介入次数', support.length || null), metric('auth', '客服一次性开柜次数', support.length || null), metric('success', '成功处理次数', successRows.length || null), metric('rate', '客服介入率', scopedPickups.length ? Math.round(support.length * 10000 / scopedPickups.length) / 100 : null, 'percent')], ranking: Object.keys(counts).map(key => ({ key, label: key, value: counts[key] })).sort((a, b) => b.value - a.value) } }
    }
    throw new Error('ANALYTICS_TAB_INVALID')
  } catch (error) { return { ok: false, error: { code: error.message || 'GET_OPERATIONS_ANALYTICS_FAILED' } } }
}

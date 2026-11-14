// 运营日期固定为 UTC+8；只转换统计边界和展示字段，不改写数据库时间。
const BEIJING_OFFSET_MS = 8 * 60 * 60 * 1000
const HOUR_MS = 60 * 60 * 1000
const DAY_MS = 24 * HOUR_MS
const TIME_ZONE = 'Asia/Shanghai'
const pad = value => String(value).padStart(2, '0')

function toMs(value) {
  if (value === null || value === undefined || value === '') return NaN
  if (value instanceof Date) return value.getTime()
  if (typeof value === 'number') return value < 100000000000 ? value * 1000 : value
  if (typeof value === 'object' && value._seconds !== undefined) return Number(value._seconds) * 1000 + Math.floor(Number(value._nanoseconds || 0) / 1000000)
  if (typeof value !== 'string') return NaN
  const text = value.trim()
  // 不带时区的日期/日期时间参数也明确按北京时间解释，避免 Date.parse 使用本机时区。
  const local = text.match(/^(\d{4})-(\d{2})-(\d{2})(?:[T ](\d{2}):(\d{2})(?::(\d{2})(?:\.(\d{1,9}))?)?)?$/)
  if (local) {
    const year = Number(local[1]); const month = Number(local[2]); const day = Number(local[3])
    const hour = Number(local[4] || 0); const minute = Number(local[5] || 0); const second = Number(local[6] || 0)
    const millisecond = Number((local[7] || '').padEnd(3, '0').slice(0, 3))
    const shifted = new Date(Date.UTC(year, month - 1, day, hour, minute, second, millisecond))
    if (shifted.getUTCFullYear() !== year || shifted.getUTCMonth() !== month - 1 || shifted.getUTCDate() !== day || shifted.getUTCHours() !== hour || shifted.getUTCMinutes() !== minute || shifted.getUTCSeconds() !== second) return NaN
    return shifted.getTime() - BEIJING_OFFSET_MS
  }
  // 其余字符串必须自带时区，不能依赖服务器或手机的本地时区。
  if (!/(?:Z|[+-]\d{2}:?\d{2})$/i.test(text) && !/\b(?:GMT|UTC)\b/i.test(text)) return NaN
  return new Date(text).getTime()
}

function startOfBeijingDay(value) {
  const time = typeof value === 'number' ? value : toMs(value)
  return Math.floor((time + BEIJING_OFFSET_MS) / DAY_MS) * DAY_MS - BEIJING_OFFSET_MS
}

function beijingDateKey(value) {
  const date = new Date((typeof value === 'number' ? value : toMs(value)) + BEIJING_OFFSET_MS)
  return `${date.getUTCFullYear()}-${pad(date.getUTCMonth() + 1)}-${pad(date.getUTCDate())}`
}

function formatBeijingDateTime(value) {
  const time = toMs(value)
  if (!Number.isFinite(time)) return ''
  const date = new Date(time + BEIJING_OFFSET_MS)
  return `${beijingDateKey(time)} ${pad(date.getUTCHours())}:${pad(date.getUTCMinutes())}`
}

function dateRange(input = {}, nowMs = Date.now()) {
  const today = startOfBeijingDay(nowMs)
  const requestedRange = String(input.range || 'LAST_7_DAYS').toUpperCase()
  const rangeName = ['TODAY', 'LAST_7_DAYS', 'LAST_30_DAYS', 'CUSTOM'].includes(requestedRange) ? requestedRange : 'LAST_7_DAYS'
  let start
  let end
  let granularity = 'DAY'
  if (rangeName === 'TODAY') {
    start = today
    end = today + DAY_MS
    granularity = 'HOUR'
  } else if (rangeName === 'CUSTOM') {
    // 兼容旧日期型 startAt/endAt；自定义范围只接受日历日期，不接受时间戳。
    const startDate = input.startDate === undefined ? input.startAt : input.startDate
    const endDate = input.endDate === undefined ? input.endAt : input.endDate
    const isCalendarDate = value => typeof value === 'string' && /^\d{4}-\d{2}-\d{2}$/.test(value) && Number.isFinite(toMs(value))
    if (!isCalendarDate(startDate) || !isCalendarDate(endDate)) throw new Error('ANALYTICS_CUSTOM_DATE_INVALID')
    start = toMs(startDate)
    const endDay = toMs(endDate)
    if (start > endDay) throw new Error('ANALYTICS_CUSTOM_START_AFTER_END')
    if (endDay > today) throw new Error('ANALYTICS_CUSTOM_END_IN_FUTURE')
    end = endDay + DAY_MS
    granularity = startDate === endDate ? 'HOUR' : 'DAY'
  } else {
    const days = rangeName === 'LAST_30_DAYS' ? 30 : 7
    start = today - (days - 1) * DAY_MS
    end = today + DAY_MS
  }
  return {
    range: rangeName,
    start, end, startAt: new Date(start).toISOString(), endAt: new Date(end).toISOString(),
    granularity, timeZone: TIME_ZONE, utcOffsetMinutes: 480,
    todayDate: beijingDateKey(today),
    defaultCustomStartDate: beijingDateKey(today - 6 * DAY_MS),
    defaultCustomEndDate: beijingDateKey(today)
  }
}

function bucketRange(range) {
  const hourly = range.granularity === 'HOUR'
  const step = hourly ? HOUR_MS : DAY_MS
  const first = hourly
    ? Math.floor((range.start + BEIJING_OFFSET_MS) / HOUR_MS) * HOUR_MS - BEIJING_OFFSET_MS
    : startOfBeijingDay(range.start)
  const labels = []; const starts = []; const keys = []
  for (let time = first; time < range.end; time += step) {
    const date = new Date(time + BEIJING_OFFSET_MS)
    const hour = pad(date.getUTCHours())
    starts.push(time)
    const dayLabel = range.range === 'CUSTOM'
      ? `${pad(date.getUTCMonth() + 1)}/${pad(date.getUTCDate())}`
      : `${date.getUTCMonth() + 1}/${date.getUTCDate()}`
    labels.push(hourly ? `${hour}:00` : dayLabel)
    keys.push(hourly ? `${beijingDateKey(time)}T${hour}:00:00+08:00` : beijingDateKey(time))
  }
  return { starts, labels, keys, step }
}

module.exports = { toMs, startOfBeijingDay, beijingDateKey, formatBeijingDateTime, dateRange, bucketRange }

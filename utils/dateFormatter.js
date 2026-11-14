function unwrapDateValue(value) {
  return value && typeof value === 'object' && value.$date ? value.$date : value
}

function parseDate(value) {
  const raw = unwrapDateValue(value)
  if (!raw) return null
  const date = new Date(raw)
  return Number.isNaN(date.getTime()) ? null : date
}

function formatDateTime(value, fallback = '') {
  const date = parseDate(value)
  if (!date) return fallback
  return `${String(date.getFullYear()).padStart(4, '0')}-${String(date.getMonth() + 1).padStart(2, '0')}-${String(date.getDate()).padStart(2, '0')} ${String(date.getHours()).padStart(2, '0')}:${String(date.getMinutes()).padStart(2, '0')}`
}

function formatMonthDayTime(value, fallback = '—') {
  const date = parseDate(value)
  if (!date) return fallback
  return `${String(date.getMonth() + 1).padStart(2, '0')}-${String(date.getDate()).padStart(2, '0')} ${String(date.getHours()).padStart(2, '0')}:${String(date.getMinutes()).padStart(2, '0')}`
}

module.exports = { formatDateTime, formatMonthDayTime }

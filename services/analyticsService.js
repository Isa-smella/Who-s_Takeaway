const permissionGuard = require('./permissionGuard')
const cloudAnalyticsRepository = require('../repositories/cloudAnalyticsRepository')
const { USE_CLOUD } = require('../config/env')

const RANGES = Object.freeze({ TODAY: 'TODAY', LAST_7_DAYS: 'LAST_7_DAYS', LAST_30_DAYS: 'LAST_30_DAYS', CUSTOM: 'CUSTOM' })

function getAnalytics(params = {}) {
  permissionGuard.assertRole(permissionGuard.MANAGEMENT_ROLES)
  if (!USE_CLOUD) return Promise.resolve({ range: { range: params.range || RANGES.LAST_7_DAYS }, metrics: [], trend: { hasData: false }, unavailable: true })
  return cloudAnalyticsRepository.getAnalytics({
    tab: params.tab || 'overview',
    range: params.range || RANGES.LAST_7_DAYS,
    startDate: params.startDate || '',
    endDate: params.endDate || '',
    startAt: params.startAt || '',
    endAt: params.endAt || '',
    cursor: params.cursor || 0
  })
}

module.exports = { getAnalytics, RANGES }

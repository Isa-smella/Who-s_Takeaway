const cloud = require('wx-server-sdk')
cloud.init({ env: cloud.DYNAMIC_CURRENT_ENV })
const db = cloud.database()
async function manager() {
  const { OPENID } = cloud.getWXContext()
  const users = await db.collection('users').where({ openid: OPENID, status: 'ACTIVE' }).limit(1).get()
  const user = users.data[0]
  if (!user || !['ADMIN', 'DEVELOPER'].includes(user.role)) throw new Error('ROLE_FORBIDDEN')
  const legal = (await db.collection('systemConfig').doc('legal-current').get()).data
  const consent = await db.collection('privacyConsents').where({ userId: user._id, agreementVersion: legal.agreementVersion, privacyVersion: legal.privacyVersion }).limit(1).get()
  if (!consent.data[0]) throw new Error('PRIVACY_CONSENT_REQUIRED')
  return user
}
exports.main = async () => {
  try {
    await manager()
    const first = await db.collection('cabinets').limit(100).get()
    const second = first.data.length === 100 ? await db.collection('cabinets').skip(100).limit(100).get() : { data: [] }
    const cabinets = await Promise.all(first.data.concat(second.data).map(async cabinet => {
      const lockerFirst = await db.collection('lockers').where({ cabinetId: cabinet._id }).limit(100).get()
      const lockerSecond = lockerFirst.data.length === 100 ? await db.collection('lockers').where({ cabinetId: cabinet._id }).skip(100).limit(100).get() : { data: [] }
      const lockers = lockerFirst.data.concat(lockerSecond.data)
      let telemetry = { batteryPercent: 100, onlineStatus: 'UNKNOWN' }
      try { telemetry = { ...telemetry, ...(await db.collection('deviceTelemetry').doc(cabinet._id).get()).data } } catch (error) {}
      const faultCount = lockers.filter(item => item.faultActive).length
      const maintenanceLockerCount = lockers.filter(item => item.status === 'MAINTENANCE' || item.status === 'DISABLED' || item.enabled === false).length
      const needsAttention = cabinet.status === 'DISABLED' || cabinet.status === 'MAINTENANCE' || cabinet.faultActive || faultCount || maintenanceLockerCount
      const alerts = []
      if (cabinet.faultActive) alerts.push('整柜控制器故障')
      if (faultCount) alerts.push(`${faultCount}格硬件故障`)
      if (maintenanceLockerCount) alerts.push(`${maintenanceLockerCount}格维修`)
      return { ...cabinet, id: cabinet._id, statusLabel: { ACTIVE: '正常', MAINTENANCE: '整柜维修', DISABLED: '整柜维修', PROVISIONING: '初始化中' }[cabinet.status] || cabinet.status, batteryPercent: telemetry.batteryPercent, onlineStatus: telemetry.onlineStatus, faultCount, maintenanceLockerCount, legacyDisabled: cabinet.status === 'DISABLED', needsAttention: Boolean(needsAttention), alertText: alerts.join(' · ') }
    }))
    cabinets.sort((a, b) => a.id.localeCompare(b.id))
    return { ok: true, data: { cabinets, totalCount: cabinets.length, activeCount: cabinets.filter(item => item.status === 'ACTIVE').length, attentionCount: cabinets.filter(item => item.needsAttention).length, maintenanceCount: cabinets.filter(item => item.status === 'MAINTENANCE' || item.status === 'DISABLED').length } }
  } catch (error) { return { ok: false, error: { code: error.message || 'LIST_CABINETS_FAILED' } } }
}

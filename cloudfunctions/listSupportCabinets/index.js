const cloud = require('wx-server-sdk')
cloud.init({ env: cloud.DYNAMIC_CURRENT_ENV })
const db = cloud.database()
exports.main = async () => {
  try {
    const { OPENID } = cloud.getWXContext()
    const users = await db.collection('users').where({ openid: OPENID, status: 'ACTIVE' }).limit(1).get()
    const user = users.data[0]
    if (!user || !['CUSTOMER_SERVICE', 'ADMIN', 'DEVELOPER'].includes(user.role)) throw new Error('ROLE_FORBIDDEN')
    const legal = (await db.collection('systemConfig').doc('legal-current').get()).data
    const consent = await db.collection('privacyConsents').where({ userId: user._id, agreementVersion: legal.agreementVersion, privacyVersion: legal.privacyVersion }).limit(1).get()
    if (!consent.data[0]) throw new Error('PRIVACY_CONSENT_REQUIRED')
    const first = await db.collection('cabinets').limit(100).get()
    const second = first.data.length === 100 ? await db.collection('cabinets').skip(100).limit(100).get() : { data: [] }
    const cabinets = await Promise.all(first.data.concat(second.data).map(async cabinet => {
      const occupied = await db.collection('lockers').where({ cabinetId: cabinet._id, status: 'OCCUPIED' }).count()
      return { ...cabinet, id: cabinet._id, statusLabel: { ACTIVE: '正常', MAINTENANCE: '维修中', DISABLED: '维修中' }[cabinet.status] || cabinet.status, occupiedCount: occupied.total, availableForEmergency: cabinet.status !== 'DISABLED' }
    }))
    cabinets.sort((a, b) => a.id.localeCompare(b.id))
    return { ok: true, data: cabinets }
  } catch (error) { return { ok: false, error: { code: error.message || 'LIST_SUPPORT_CABINETS_FAILED' } } }
}

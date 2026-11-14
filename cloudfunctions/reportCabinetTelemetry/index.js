const cloud = require('wx-server-sdk')
cloud.init({ env: cloud.DYNAMIC_CURRENT_ENV })
const db = cloud.database()

async function requireCoreAccess() {
  const { OPENID } = cloud.getWXContext()
  const users = await db.collection('users').where({ openid: OPENID, status: 'ACTIVE' }).limit(1).get()
  const user = users.data[0]
  if (!user) throw new Error('AUTH_REQUIRED')
  const legal = (await db.collection('systemConfig').doc('legal-current').get()).data
  const consents = await db.collection('privacyConsents').where({ userId: user._id, agreementVersion: legal.agreementVersion, privacyVersion: legal.privacyVersion }).limit(1).get()
  if (!consents.data[0]) throw new Error('PRIVACY_CONSENT_REQUIRED')
}

function parseLockerSnapshot(value) {
  if (!Array.isArray(value) || !value.length) throw new Error('TELEMETRY_LOCKER_SNAPSHOT_REQUIRED')
  const seen = new Set()
  return value.map(item => {
    const lockerId = Number(item && item.lockerId)
    if (!Number.isInteger(lockerId) || lockerId < 1 || lockerId > 200) throw new Error('LOCKER_ID_INVALID')
    if (seen.has(lockerId)) throw new Error('DUPLICATE_LOCKER_STATUS')
    if (!item || !['OPEN', 'CLOSED'].includes(item.doorStatus)) throw new Error('DOOR_STATUS_INVALID')
    seen.add(lockerId)
    return { lockerId, doorStatus: item.doorStatus }
  })
}

exports.main = async event => {
  try {
    await requireCoreAccess()
    const cabinetId = String(event.cabinetId || '').trim().toUpperCase()
    if (!cabinetId) throw new Error('CABINET_ID_REQUIRED')
    const lockersSnapshot = parseLockerSnapshot(event.lockers)
    const transaction = await db.startTransaction()
    const cabinet = (await transaction.collection('cabinets').doc(cabinetId).get()).data
    if (!cabinet) throw new Error('CABINET_NOT_FOUND')
    const first = await transaction.collection('lockers').where({ cabinetId }).limit(100).get()
    const second = first.data.length === 100 ? await transaction.collection('lockers').where({ cabinetId }).skip(100).limit(100).get() : { data: [] }
    const lockers = (first.data || []).concat(second.data || [])
    if (lockers.length !== lockersSnapshot.length) throw new Error('TELEMETRY_LOCKER_SNAPSHOT_INCOMPLETE')
    const byId = new Map(lockers.map(item => [Number(item.id), item]))
    if (lockersSnapshot.some(item => !byId.has(item.lockerId))) throw new Error('TELEMETRY_LOCKER_NOT_FOUND')

    for (const item of lockersSnapshot) {
      await transaction.collection('lockers').doc(byId.get(item.lockerId)._id).update({ data: { doorStatus: item.doorStatus } })
    }
    await transaction.collection('cabinets').doc(cabinetId).update({ data: { lastBleSeenAt: db.serverDate() } })
    await transaction.commit()
    return { ok: true, data: { cabinetId, lockerCount: lockersSnapshot.length } }
  } catch (error) {
    return { ok: false, error: { code: error.message || 'REPORT_CABINET_TELEMETRY_FAILED' } }
  }
}

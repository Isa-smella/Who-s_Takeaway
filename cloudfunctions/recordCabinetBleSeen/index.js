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

exports.main = async event => {
  try {
    await requireCoreAccess()
    const cabinetId = String(event.cabinetId || '').trim().toUpperCase()
    if (!cabinetId) throw new Error('CABINET_ID_REQUIRED')
    if (!Array.isArray(event.lockerStatuses) || !event.lockerStatuses.length) throw new Error('LOCKER_STATUS_SNAPSHOT_REQUIRED')
    const statuses = []
    const seen = new Set()
    event.lockerStatuses.forEach(item => {
      const lockerId = Number(item && item.lockerId)
      if (!Number.isInteger(lockerId) || lockerId < 1 || lockerId > 200) throw new Error('LOCKER_ID_INVALID')
      if (seen.has(lockerId)) throw new Error('DUPLICATE_LOCKER_STATUS')
      if (!item || !['OPEN', 'CLOSED'].includes(item.doorStatus)) throw new Error('DOOR_STATUS_INVALID')
      seen.add(lockerId)
      statuses.push({ lockerId, doorStatus: item.doorStatus })
    })

    const transaction = await db.startTransaction()
    const cabinet = (await transaction.collection('cabinets').doc(cabinetId).get()).data
    if (!cabinet) throw new Error('CABINET_NOT_FOUND')
    const lockerFirst = await transaction.collection('lockers').where({ cabinetId }).limit(100).get()
    const lockerSecond = lockerFirst.data.length === 100 ? await transaction.collection('lockers').where({ cabinetId }).skip(100).limit(100).get() : { data: [] }
    const lockers = (lockerFirst.data || []).concat(lockerSecond.data || [])
    if (lockers.length !== statuses.length) throw new Error('LOCKER_STATUS_SNAPSHOT_INCOMPLETE')
    const lockerMap = new Map(lockers.map(locker => [Number(locker.id), locker]))
    if (statuses.some(item => !lockerMap.has(item.lockerId))) throw new Error('LOCKER_STATUS_SNAPSHOT_INVALID')

    const syncedAt = db.serverDate()
    for (const item of statuses) {
      await transaction.collection('lockers').doc(lockerMap.get(item.lockerId)._id).update({ data: { doorStatus: item.doorStatus } })
    }
    await transaction.collection('cabinets').doc(cabinetId).update({ data: { lastBleSeenAt: syncedAt } })
    await transaction.commit()
    return { ok: true, data: { cabinetId, lockerCount: statuses.length } }
  } catch (error) {
    return { ok: false, error: { code: error.message || 'RECORD_CABINET_BLE_SEEN_FAILED' } }
  }
}

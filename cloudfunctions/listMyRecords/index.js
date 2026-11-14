const cloud = require('wx-server-sdk')
cloud.init({ env: cloud.DYNAMIC_CURRENT_ENV })
const db = cloud.database()

async function requireUser() {
  const { OPENID } = cloud.getWXContext()
  const result = await db.collection('users').where({ openid: OPENID, status: 'ACTIVE' }).limit(1).get()
  const user = result.data[0]
  if (!user) throw new Error('AUTH_REQUIRED')
  const legal = (await db.collection('systemConfig').doc('legal-current').get()).data
  const consent = await db.collection('privacyConsents').where({ userId: user._id, agreementVersion: legal.agreementVersion, privacyVersion: legal.privacyVersion }).limit(1).get()
  if (!consent.data[0]) throw new Error('PRIVACY_CONSENT_REQUIRED')
  return user
}
async function queryPage(where, offset, orderField) {
  if (offset < 0) return { items: [], nextOffset: null }
  const collection = db.collection('depositRecords')
  const result = await collection.where(where).orderBy(orderField, 'desc').skip(offset).limit(50).get()
  return { items: result.data.map(item => ({ ...item, id: item._id })), nextOffset: result.data.length === 50 ? offset + 50 : null }
}

exports.main = async event => {
  try {
    const user = await requireUser()
    const depositOffset = Number(event.depositOffset) === -1 ? -1 : Math.max(0, Number(event.depositOffset) || 0)
    const pickupOffset = Number(event.pickupOffset) === -1 ? -1 : Math.max(0, Number(event.pickupOffset) || 0)
    const [depositPage, pickupPage] = await Promise.all([
      queryPage({ depositorUserId: user._id }, depositOffset, 'storedAt'),
      queryPage({ pickedByUserId: user._id, status: 'PICKED_UP' }, pickupOffset, 'pickedAt')
    ])
    const deposits = depositPage.items
    const pickups = pickupPage.items
    deposits.sort((a, b) => new Date(b.storedAt) - new Date(a.storedAt))
    pickups.sort((a, b) => new Date(b.pickedAt) - new Date(a.pickedAt))
    return { ok: true, data: { deposits, pickups, nextDepositOffset: depositPage.nextOffset, nextPickupOffset: pickupPage.nextOffset } }
  } catch (error) {
    return { ok: false, error: { code: error.message || 'LIST_MY_RECORDS_FAILED' } }
  }
}

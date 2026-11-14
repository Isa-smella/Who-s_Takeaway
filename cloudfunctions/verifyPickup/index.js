const cloud = require('wx-server-sdk')
const crypto = require('crypto')
cloud.init({ env: cloud.DYNAMIC_CURRENT_ENV })
const db = cloud.database()

async function requireCoreAccess() {
  const { OPENID } = cloud.getWXContext()
  const users = await db.collection('users').where({ openid: OPENID, status: 'ACTIVE' }).limit(1).get()
  const user = users.data[0]
  if (!user || !['USER', 'ADMIN', 'DEVELOPER'].includes(user.role)) throw new Error('ROLE_FORBIDDEN')
  const legal = (await db.collection('systemConfig').doc('legal-current').get()).data
  const consents = await db.collection('privacyConsents').where({ userId: user._id, agreementVersion: legal.agreementVersion, privacyVersion: legal.privacyVersion }).limit(1).get()
  if (!consents.data[0]) throw new Error('PRIVACY_CONSENT_REQUIRED')
  return user
}

function rateLimitId(userId, cabinetId, lockerId) {
  return crypto.createHash('sha256').update(`${userId}:${cabinetId}:${lockerId}`).digest('hex')
}

async function recordFailure(user, cabinetId, lockerId, reason) {
  const id = rateLimitId(user._id, cabinetId, lockerId)
  const ref = db.collection('pickupRateLimits').doc(id)
  let current
  try { current = (await ref.get()).data } catch (error) {}
  const now = Date.now()
  const withinWindow = current && current.windowStartedAt && now - new Date(current.windowStartedAt).getTime() < 10 * 60 * 1000
  const failedAttempts = withinWindow ? Number(current.failedAttempts || 0) + 1 : 1
  const blockedUntil = failedAttempts >= 5 ? new Date(now + 10 * 60 * 1000).toISOString() : null
  await ref.set({ data: { userId: user._id, cabinetId, lockerId, failedAttempts, windowStartedAt: withinWindow ? current.windowStartedAt : new Date(now).toISOString(), blockedUntil, updatedAt: new Date(now).toISOString() } })
  await db.collection('operationLogs').add({ data: { userId: user._id, role: user.role, cabinetId, lockerId, recordId: null, action: 'USER_PICKUP_VERIFY_FAILED', result: 'FAILED', detail: { reason, failedAttempts, blockedUntil }, createdAt: new Date(now).toISOString() } })
}

exports.main = async event => {
  let user
  let cabinetId = ''
  let lockerId = 0
  try {
    user = await requireCoreAccess()
    cabinetId = String(event.cabinetId || '').trim().toUpperCase()
    lockerId = Number(event.lockerId)
    const pickupCode = String(event.pickupCode || '')
    if (!cabinetId || !Number.isInteger(lockerId) || !/^\d{4}$/.test(pickupCode)) throw new Error('PICKUP_INPUT_INVALID')
    const rateId = rateLimitId(user._id, cabinetId, lockerId)
    let rate
    try { rate = (await db.collection('pickupRateLimits').doc(rateId).get()).data } catch (error) {}
    if (rate && rate.blockedUntil && new Date(rate.blockedUntil).getTime() > Date.now()) throw new Error('PICKUP_ATTEMPTS_LIMITED')
    const cabinet = (await db.collection('cabinets').doc(cabinetId).get()).data
    if (!cabinet || cabinet.status !== 'ACTIVE') throw new Error('CABINET_NOT_ACTIVE')
    const lockers = await db.collection('lockers').where({ cabinetId, id: lockerId }).limit(1).get()
    const locker = lockers.data[0]
    if (!locker || locker.enabled === false || locker.status !== 'OCCUPIED' || !locker.currentRecordId) throw new Error('LOCKER_NOT_OCCUPIED')
    const record = (await db.collection('depositRecords').doc(locker.currentRecordId).get()).data
    if (!record || record.status !== 'WAITING_PICKUP' || record.pickupCode !== pickupCode || record.cabinetId !== cabinetId || Number(record.lockerId) !== lockerId) {
      await recordFailure(user, cabinetId, lockerId, 'CODE_ERROR')
      throw new Error('PICKUP_AUTHORIZATION_DENIED')
    }
    const now = Date.now()
    const authorizationId = `unlock-auth-${now}-${crypto.randomBytes(5).toString('hex')}`
    const authorization = {
      userId: user._id, cabinetId, lockerId, recordId: locker.currentRecordId,
      source: 'NORMAL_PICKUP', reason: '', issuedBy: 'SYSTEM', issuedByRole: 'SYSTEM',
      token: `CLOUD-UA-${crypto.randomBytes(24).toString('hex')}`,
      nonce: crypto.randomBytes(16).toString('hex'), protocolVersion: 'MOCK_V1', command: 'OPEN_LOCK',
      maintenanceOrderId: null, createdAt: new Date(now).toISOString(), expiresAt: new Date(now + 5 * 60 * 1000).toISOString(), status: 'UNUSED',
      usedAt: null, revokedAt: null, revokedBy: null, revocationReason: null
    }
    const transaction = await db.startTransaction()
    try {
      const previous = await transaction.collection('unlockAuthorizations').where({ userId: user._id, recordId: locker.currentRecordId, status: 'UNUSED' }).get()
      for (const item of previous.data) await transaction.collection('unlockAuthorizations').doc(item._id).update({ data: { status: 'REVOKED', revokedAt: new Date(now).toISOString(), revokedBy: 'SYSTEM', revocationReason: 'SUPERSEDED' } })
      await transaction.collection('unlockAuthorizations').doc(authorizationId).set({ data: authorization })
      await transaction.collection('pickupRateLimits').doc(rateId).set({ data: { userId: user._id, cabinetId, lockerId, failedAttempts: 0, windowStartedAt: new Date(now).toISOString(), blockedUntil: null, updatedAt: new Date(now).toISOString() } })
      await transaction.collection('operationLogs').add({ data: { userId: user._id, role: user.role, cabinetId, lockerId, recordId: locker.currentRecordId, action: 'USER_PICKUP_VERIFY_SUCCESS', result: 'SUCCESS', detail: { authorizationId }, createdAt: new Date(now).toISOString() } })
      await transaction.commit()
    } catch (error) { await transaction.rollback(); throw error }
    return { ok: true, data: { authorization: { ...authorization, id: authorizationId } } }
  } catch (error) {
    console.error('verifyPickup failed', error)
    return { ok: false, error: { code: error.message || 'VERIFY_PICKUP_FAILED' } }
  }
}

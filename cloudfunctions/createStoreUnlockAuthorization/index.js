const cloud = require('wx-server-sdk')
const crypto = require('crypto')
cloud.init({ env: cloud.DYNAMIC_CURRENT_ENV })
const db = cloud.database()
const FUNCTION_VERSION = '2026-09-02-store-auth-v4'
const STORE_REOPEN_WINDOW_MS = 10 * 60 * 1000

function businessError(code, detail = {}) {
  const error = new Error(code)
  error.detail = detail
  return error
}

async function requireCoreAccess() {
  const { OPENID } = cloud.getWXContext()
  const users = await db.collection('users').where({ openid: OPENID, status: 'ACTIVE' }).limit(1).get()
  const user = users.data[0]
  if (!user || !['USER', 'ADMIN', 'DEVELOPER'].includes(user.role)) throw new Error('ROLE_FORBIDDEN')
  const legal = (await db.collection('systemConfig').doc('legal-current').get()).data
  const consent = await db.collection('privacyConsents').where({ userId: user._id, agreementVersion: legal.agreementVersion, privacyVersion: legal.privacyVersion }).limit(1).get()
  if (!consent.data[0]) throw new Error('PRIVACY_CONSENT_REQUIRED')
  return user
}

exports.main = async event => {
  let transaction
  try {
    const user = await requireCoreAccess()
    const cabinetId = String(event.cabinetId || '').trim().toUpperCase()
    const lockerId = Number(event.lockerId)
    const recordId = String(event.recordId || '')
    const isReopen = Boolean(recordId)
    if (!cabinetId || !Number.isInteger(lockerId) || lockerId < 1) throw new Error('STORE_AUTHORIZATION_INPUT_INVALID')
    const cabinet = (await db.collection('cabinets').doc(cabinetId).get()).data
    if (!cabinet || cabinet.status !== 'ACTIVE') throw new Error('CABINET_NOT_ACTIVE')
    const lockers = await db.collection('lockers').where({ cabinetId, id: lockerId }).limit(1).get()
    const locker = lockers.data[0]
    if (!locker) throw businessError('LOCKER_NOT_FOUND')
    const lockerDetail = { status: locker.status, enabled: locker.enabled !== false, currentRecordId: locker.currentRecordId || null, doorStatus: locker.doorStatus || 'UNKNOWN' }
    if (locker.enabled === false || locker.status === 'DISABLED') throw businessError('LOCKER_DISABLED', lockerDetail)
    if (locker.status === 'MAINTENANCE' || locker.faultActive) throw businessError('LOCKER_IN_MAINTENANCE', lockerDetail)
    let record = null
    if (isReopen) {
      try { record = (await db.collection('depositRecords').doc(recordId).get()).data } catch (error) {}
      if (!record || record.status !== 'WAITING_PICKUP' || record.depositorUserId !== user._id) throw businessError('STORE_REOPEN_NOT_ALLOWED', lockerDetail)
      if (record.cabinetId !== cabinetId || Number(record.lockerId) !== lockerId || locker.status !== 'OCCUPIED' || locker.currentRecordId !== recordId) throw businessError('STORE_REOPEN_RECORD_MISMATCH', lockerDetail)
      const storedAt = new Date(record.storedAt).getTime()
      if (!Number.isFinite(storedAt) || storedAt > Date.now() + 60 * 1000 || Date.now() - storedAt > STORE_REOPEN_WINDOW_MS) throw businessError('STORE_REOPEN_EXPIRED', lockerDetail)
    } else {
      if (locker.status === 'OCCUPIED' || locker.currentRecordId) throw businessError('LOCKER_OCCUPIED', lockerDetail)
      if (locker.status !== 'EMPTY') throw businessError('LOCKER_NOT_AVAILABLE_FOR_STORE', lockerDetail)
    }
    const now = Date.now()
    const id = `unlock-auth-${now}-${crypto.randomBytes(5).toString('hex')}`
    const source = isReopen ? 'STORE_REOPEN' : 'STORE'
    const authorization = {
      userId: user._id, cabinetId, lockerId, recordId: isReopen ? recordId : null, source, reason: isReopen ? 'STORE_REOPEN_AFTER_DEPOSIT' : 'STORE_OPEN',
      issuedBy: 'SYSTEM', issuedByRole: 'SYSTEM', token: `CLOUD-UA-${crypto.randomBytes(24).toString('hex')}`,
      nonce: crypto.randomBytes(16).toString('hex'), protocolVersion: 'MOCK_V1', command: 'OPEN_LOCK', maintenanceOrderId: null,
      createdAt: new Date(now).toISOString(), expiresAt: new Date(now + 5 * 60 * 1000).toISOString(), status: 'UNUSED', usedAt: null
    }
    transaction = await db.startTransaction()
    const previous = await transaction.collection('unlockAuthorizations').where({ cabinetId, status: 'UNUSED' }).get()
    for (const item of previous.data.filter(item => item.userId === user._id && Number(item.lockerId) === lockerId && item.source === source)) await transaction.collection('unlockAuthorizations').doc(item._id).update({ data: { status: 'REVOKED', revokedAt: authorization.createdAt, revokedBy: 'SYSTEM', revocationReason: 'SUPERSEDED' } })
    await transaction.collection('unlockAuthorizations').doc(id).set({ data: authorization })
    const logId = `operation-${Date.now()}-${crypto.randomBytes(4).toString('hex')}`
    await transaction.collection('operationLogs').doc(logId).set({ data: { userId: user._id, role: user.role, cabinetId, lockerId, recordId: authorization.recordId, action: 'UNLOCK_AUTHORIZATION_CREATED', result: 'SUCCESS', detail: { authorizationId: id, source, expiresAt: authorization.expiresAt }, createdAt: authorization.createdAt } })
    await transaction.commit()
    return { ok: true, data: { ...authorization, id, functionVersion: FUNCTION_VERSION } }
  } catch (error) {
    if (transaction) await transaction.rollback().catch(() => null)
    return { ok: false, error: { code: error.message || 'CREATE_STORE_UNLOCK_AUTHORIZATION_FAILED', functionVersion: FUNCTION_VERSION, detail: error.detail || null } }
  }
}

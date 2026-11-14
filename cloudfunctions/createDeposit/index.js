const cloud = require('wx-server-sdk')
const crypto = require('crypto')
cloud.init({ env: cloud.DYNAMIC_CURRENT_ENV })
const db = cloud.database()
const FUNCTION_VERSION = '2026-09-02-create-deposit-v2'

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

exports.main = async event => {
  let auditContext = null
  try {
    const user = await requireCoreAccess()
    const cabinetId = String(event.cabinetId || '').trim().toUpperCase()
    const lockerId = Number(event.lockerId)
    const pickupCode = String(event.pickupCode || '')
    const requestedRecordId = String(event.recordId || '').trim()
    const isRedeposit = Boolean(requestedRecordId)
    if (!cabinetId) throw new Error('CABINET_ID_REQUIRED')
    if (!Number.isInteger(lockerId) || lockerId < 1) throw new Error('LOCKER_ID_INVALID')
    if (!/^\d{4}$/.test(pickupCode)) throw new Error('PICKUP_CODE_INVALID')
    auditContext = { userId: user._id, role: user.role, cabinetId, lockerId, recordId: requestedRecordId || null }
    const lockerQuery = await db.collection('lockers').where({ cabinetId, id: lockerId }).limit(1).get()
    const targetLocker = lockerQuery.data[0]
    if (!targetLocker) throw new Error('LOCKER_NOT_FOUND')
    const transaction = await db.startTransaction()
    try {
      const cabinet = (await transaction.collection('cabinets').doc(cabinetId).get()).data
      const locker = (await transaction.collection('lockers').doc(targetLocker._id).get()).data
      if (!cabinet || cabinet.status !== 'ACTIVE') throw new Error('CABINET_NOT_ACTIVE')
      if (!locker || locker.enabled === false) throw new Error('LOCKER_DISABLED')
      if (locker.status === 'MAINTENANCE' || locker.faultActive) throw new Error('LOCKER_IN_MAINTENANCE')
      // 当前实体柜门实时状态由现场手机通过 BLE 查询，数据库中的 doorStatus 可能仍是上一次的 OPEN。
      // 页面已在调用前检查 @STATUS 返回的 CLOSED；云端只校验业务提交中的关门结果。
      if (event.doorClosed !== true) throw new Error('DOOR_NOT_CLOSED')
      const now = new Date().toISOString()
      let recordId = requestedRecordId
      let record
      if (isRedeposit) {
        if (locker.status !== 'OCCUPIED' || locker.currentRecordId !== recordId) throw new Error('REDEPOSIT_RECORD_MISMATCH')
        let existingRecord
        try { existingRecord = (await transaction.collection('depositRecords').doc(recordId).get()).data } catch (error) {}
        if (!existingRecord || existingRecord.status !== 'WAITING_PICKUP' || existingRecord.cabinetId !== cabinetId || Number(existingRecord.lockerId) !== lockerId) throw new Error('REDEPOSIT_RECORD_MISMATCH')
        if (existingRecord.depositorUserId !== user._id) throw new Error('REDEPOSIT_NOT_ALLOWED')
        const recordUpdate = { pickupCode, initialStoredAt: existingRecord.initialStoredAt || existingRecord.storedAt, storedAt: now, reconfirmedAt: now, updatedAt: now }
        await transaction.collection('depositRecords').doc(recordId).update({ data: recordUpdate })
        await transaction.collection('lockers').doc(targetLocker._id).update({ data: { status: 'OCCUPIED', doorStatus: 'CLOSED', currentRecordId: recordId, storedAt: now, updatedAt: now } })
        record = { ...existingRecord, ...recordUpdate }
      } else {
        if (locker.status !== 'EMPTY' || locker.currentRecordId) throw new Error('LOCKER_NOT_EMPTY')
        recordId = `deposit-${cabinetId}-${Date.now()}-${crypto.randomBytes(4).toString('hex')}`
        record = { cabinetId, lockerId, depositorUserId: user._id, pickupCode, storedAt: now, initialStoredAt: now, reconfirmedAt: null, pickedAt: null, pickedByUserId: '', status: 'WAITING_PICKUP', updatedAt: now }
        await transaction.collection('depositRecords').doc(recordId).set({ data: record })
        await transaction.collection('lockers').doc(targetLocker._id).update({ data: { status: 'OCCUPIED', doorStatus: 'CLOSED', currentRecordId: recordId, storedAt: now, updatedAt: now } })
      }
      const logId = `operation-${Date.now()}-${crypto.randomBytes(4).toString('hex')}`
      await transaction.collection('operationLogs').doc(logId).set({ data: { userId: user._id, role: user.role, cabinetId, lockerId, recordId, action: 'USER_CONFIRM_DEPOSIT', result: 'SUCCESS', detail: { mode: isRedeposit ? 'REDEPOSIT' : 'INITIAL_DEPOSIT' }, createdAt: now } })
      await transaction.commit()
      return { ok: true, data: { record: { ...record, id: recordId }, locker: { ...locker, id: lockerId, status: 'OCCUPIED', doorStatus: 'CLOSED', currentRecordId: recordId, storedAt: now }, functionVersion: FUNCTION_VERSION } }
    } catch (error) {
      await transaction.rollback()
      throw error
    }
  } catch (error) {
    console.error('createDeposit failed', error)
    if (auditContext) {
      try {
        await db.collection('operationLogs').add({ data: { ...auditContext, action: 'USER_CONFIRM_DEPOSIT', result: 'FAILED', detail: { reason: error.message || 'CREATE_DEPOSIT_FAILED' }, createdAt: new Date().toISOString() } })
      } catch (logError) { console.error('createDeposit failure audit failed', logError) }
    }
    return { ok: false, error: { code: error.message || 'CREATE_DEPOSIT_FAILED', functionVersion: FUNCTION_VERSION } }
  }
}

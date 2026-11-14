const cloud = require('wx-server-sdk')
cloud.init({ env: cloud.DYNAMIC_CURRENT_ENV })
const db = cloud.database()
const FUNCTION_VERSION = '2026-08-23-consume-auth-v2'

exports.main = async event => {
  try {
    const { OPENID } = cloud.getWXContext()
    const users = await db.collection('users').where({ openid: OPENID, status: 'ACTIVE' }).limit(1).get()
    const user = users.data[0]
    if (!user) throw new Error('AUTH_REQUIRED')
    const legal = (await db.collection('systemConfig').doc('legal-current').get()).data
    const consent = await db.collection('privacyConsents').where({ userId: user._id, agreementVersion: legal.agreementVersion, privacyVersion: legal.privacyVersion }).limit(1).get()
    if (!consent.data[0]) throw new Error('PRIVACY_CONSENT_REQUIRED')
    const authorizationId = String(event.authorizationId || '')
    const cabinetId = String(event.cabinetId || '').trim().toUpperCase()
    if (!authorizationId || !cabinetId) throw new Error('UNLOCK_AUTHORIZATION_INPUT_INVALID')
    const transaction = await db.startTransaction()
    try {
      const authorization = (await transaction.collection('unlockAuthorizations').doc(authorizationId).get()).data
      if (!authorization) throw new Error('UNLOCK_AUTHORIZATION_NOT_FOUND')
      if (authorization.userId !== user._id) throw new Error('UNLOCK_AUTHORIZATION_USER_MISMATCH')
      if (authorization.cabinetId !== cabinetId) throw new Error('UNLOCK_AUTHORIZATION_CABINET_MISMATCH')
      if (authorization.status !== 'UNUSED') throw new Error(`UNLOCK_AUTHORIZATION_${authorization.status}`)
      if (new Date(authorization.expiresAt).getTime() <= Date.now()) throw new Error('UNLOCK_AUTHORIZATION_EXPIRED')
      const cabinet = (await transaction.collection('cabinets').doc(cabinetId).get()).data
      if (!cabinet || cabinet.status !== 'ACTIVE') throw new Error('CABINET_NOT_ACTIVE')
      const lockers = await transaction.collection('lockers').where({ cabinetId, id: Number(authorization.lockerId) }).limit(1).get()
      const locker = lockers.data[0]
      if (!locker || locker.enabled === false) throw new Error('LOCKER_NOT_AVAILABLE')
      if (authorization.source === 'STORE') {
        // 当前柜门实时状态由手机通过实体 BLE/控制器现场判断，数据库 doorStatus 可能仍是上一次的 OPEN。
        // 云端消费授权只校验业务状态；接入实体控制器后由硬件回执确认真实开门结果。
        if (locker.status !== 'EMPTY' || locker.currentRecordId) throw new Error('LOCKER_NOT_AVAILABLE_FOR_STORE')
      } else {
        const record = (await transaction.collection('depositRecords').doc(authorization.recordId).get()).data
        if (!record || record.status !== 'WAITING_PICKUP' || record.cabinetId !== cabinetId || Number(record.lockerId) !== Number(authorization.lockerId)) throw new Error('RECORD_NOT_ACTIVE')
        if (locker.status !== 'OCCUPIED' || locker.currentRecordId !== authorization.recordId) throw new Error('LOCKER_RECORD_MISMATCH')
      }
      const usedAt = new Date().toISOString()
      await transaction.collection('unlockAuthorizations').doc(authorizationId).update({ data: { status: 'USED', usedAt } })
      await transaction.commit()
      return { ok: true, data: { ...authorization, id: authorizationId, status: 'USED', usedAt, functionVersion: FUNCTION_VERSION } }
    } catch (error) { await transaction.rollback(); throw error }
  } catch (error) {
    console.error('consumeUnlockAuthorization failed', error)
    return { ok: false, error: { code: error.message || 'CONSUME_UNLOCK_AUTHORIZATION_FAILED', functionVersion: FUNCTION_VERSION } }
  }
}

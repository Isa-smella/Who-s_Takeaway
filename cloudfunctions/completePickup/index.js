const cloud = require('wx-server-sdk')
const crypto = require('crypto')
cloud.init({ env: cloud.DYNAMIC_CURRENT_ENV })
const db = cloud.database()

exports.main = async event => {
  try {
    const { OPENID } = cloud.getWXContext()
    const users = await db.collection('users').where({ openid: OPENID, status: 'ACTIVE' }).limit(1).get()
    const user = users.data[0]
    if (!user) throw new Error('AUTH_REQUIRED')
    const authorizationId = String(event.authorizationId || '')
    const cabinetId = String(event.cabinetId || '').trim().toUpperCase()
    const lockerId = Number(event.lockerId)
    const recordId = String(event.recordId || '')
    if (!authorizationId || !cabinetId || !recordId || !Number.isInteger(lockerId)) throw new Error('COMPLETE_PICKUP_INPUT_INVALID')
    if (event.doorOpened !== true) throw new Error('DOOR_NOT_OPEN')
    const lockerQuery = await db.collection('lockers').where({ cabinetId, id: lockerId }).limit(1).get()
    const targetLocker = lockerQuery.data[0]
    if (!targetLocker) throw new Error('LOCKER_NOT_FOUND')
    const transaction = await db.startTransaction()
    try {
      const authorization = (await transaction.collection('unlockAuthorizations').doc(authorizationId).get()).data
      const record = (await transaction.collection('depositRecords').doc(recordId).get()).data
      const locker = (await transaction.collection('lockers').doc(targetLocker._id).get()).data
      if (!authorization || authorization.status !== 'USED' || authorization.userId !== user._id) throw new Error('UNLOCK_AUTHORIZATION_INVALID')
      if (authorization.cabinetId !== cabinetId || Number(authorization.lockerId) !== lockerId || authorization.recordId !== recordId) throw new Error('UNLOCK_AUTHORIZATION_BINDING_MISMATCH')
      if (!authorization.usedAt || Date.now() - new Date(authorization.usedAt).getTime() > 2 * 60 * 1000) throw new Error('UNLOCK_RESULT_REPORT_EXPIRED')
      if (!record || record.status !== 'WAITING_PICKUP' || record.pickedAt) throw new Error('RECORD_NOT_ACTIVE')
      if (!locker || locker.currentRecordId !== recordId || locker.status !== 'OCCUPIED') throw new Error('LOCKER_RECORD_MISMATCH')
      const pickedAt = new Date().toISOString()
      const pickupMethod = authorization.source === 'CUSTOMER_SERVICE' ? 'CUSTOMER_SERVICE_AUTHORIZED' : 'USER_SELF_SERVICE'
      await transaction.collection('depositRecords').doc(recordId).update({ data: { status: 'PICKED_UP', pickedAt, pickedByUserId: user._id, pickupMethod } })
      await transaction.collection('lockers').doc(targetLocker._id).update({ data: { status: 'EMPTY', currentRecordId: null, storedAt: null, doorStatus: 'OPEN', updatedAt: pickedAt } })
      await transaction.collection('unlockAuthorizations').doc(authorizationId).update({ data: { completionReportedAt: pickedAt } })
      const supportRequests = await transaction.collection('emergencySupportRequests').where({ authorizationId }).get()
      for (const request of supportRequests.data) await transaction.collection('emergencySupportRequests').doc(request._id).update({ data: { status: 'RESOLVED', resolvedAt: pickedAt, statusReason: 'PICKUP_SUCCESS', updatedAt: pickedAt } })
      const logId = `operation-${Date.now()}-${crypto.randomBytes(4).toString('hex')}`
      await transaction.collection('operationLogs').doc(logId).set({ data: { userId: user._id, role: user.role, cabinetId, lockerId, recordId, action: 'USER_PICKUP_SUCCESS', result: 'SUCCESS', detail: { authorizationId, source: authorization.source }, createdAt: pickedAt } })
      await transaction.commit()
      return { ok: true, data: { record: { ...record, id: recordId, status: 'PICKED_UP', pickedAt, pickedByUserId: user._id, pickupMethod }, locker: { ...locker, id: lockerId, status: 'EMPTY', currentRecordId: null, storedAt: null, doorStatus: 'OPEN' } } }
    } catch (error) { await transaction.rollback(); throw error }
  } catch (error) {
    console.error('completePickup failed', error)
    return { ok: false, error: { code: error.message || 'COMPLETE_PICKUP_FAILED' } }
  }
}

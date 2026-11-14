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
    if (!authorizationId) throw new Error('UNLOCK_AUTHORIZATION_NOT_FOUND')
    const transaction = await db.startTransaction()
    try {
      const authorization = (await transaction.collection('unlockAuthorizations').doc(authorizationId).get()).data
      if (!authorization || authorization.userId !== user._id) throw new Error('UNLOCK_AUTHORIZATION_USER_MISMATCH')
      if (authorization.status !== 'UNUSED') throw new Error(`UNLOCK_AUTHORIZATION_${authorization.status}`)
      const now = new Date().toISOString()
      await transaction.collection('unlockAuthorizations').doc(authorizationId).update({ data: { status: 'REVOKED', revokedAt: now, revokedBy: user._id, revocationReason: 'USER_GAVE_UP' } })
      const supportRequests = await transaction.collection('emergencySupportRequests').where({ authorizationId }).get()
      for (const request of supportRequests.data) await transaction.collection('emergencySupportRequests').doc(request._id).update({ data: { status: 'OPEN', authorizationId: null, statusReason: 'AUTHORIZATION_REVOKED_BY_USER', updatedAt: now } })
      const logId = `operation-${Date.now()}-${crypto.randomBytes(4).toString('hex')}`
      await transaction.collection('operationLogs').doc(logId).set({ data: { userId: user._id, role: user.role, cabinetId: authorization.cabinetId, lockerId: Number(authorization.lockerId), recordId: authorization.recordId, action: 'UNLOCK_AUTHORIZATION_REVOKED_BY_USER', result: 'SUCCESS', detail: { authorizationId }, createdAt: now } })
      await transaction.commit()
      return { ok: true, data: { ...authorization, id: authorizationId, status: 'REVOKED', revokedAt: now, revokedBy: user._id, revocationReason: 'USER_GAVE_UP' } }
    } catch (error) { await transaction.rollback(); throw error }
  } catch (error) { return { ok: false, error: { code: error.message || 'REVOKE_UNLOCK_AUTHORIZATION_FAILED' } } }
}

const cloud = require('wx-server-sdk')
const crypto = require('crypto')
cloud.init({ env: cloud.DYNAMIC_CURRENT_ENV })
const db = cloud.database()
exports.main = async event => {
  try {
    const { OPENID } = cloud.getWXContext()
    const staffResult = await db.collection('users').where({ openid: OPENID, status: 'ACTIVE' }).limit(1).get()
    const staff = staffResult.data[0]
    if (!staff || !['CUSTOMER_SERVICE', 'ADMIN', 'DEVELOPER'].includes(staff.role)) throw new Error('ROLE_FORBIDDEN')
    const legal = (await db.collection('systemConfig').doc('legal-current').get()).data
    const consent = await db.collection('privacyConsents').where({ userId: staff._id, agreementVersion: legal.agreementVersion, privacyVersion: legal.privacyVersion }).limit(1).get()
    if (!consent.data[0]) throw new Error('PRIVACY_CONSENT_REQUIRED')
    const customerUserId = String(event.customerUserId || '').trim()
    const cabinetId = String(event.cabinetId || '').trim().toUpperCase()
    const lockerId = Number(event.lockerId)
    const recordId = String(event.recordId || '')
    const pickupCode = String(event.pickupCode || '')
    const reason = String(event.reason || '').trim().slice(0, 200)
    if (!customerUserId) throw new Error('CUSTOMER_USER_ID_REQUIRED')
    if (reason.length < 5) throw new Error('AUTHORIZATION_REASON_REQUIRED')
    const customer = (await db.collection('users').doc(customerUserId).get()).data
    if (!customer || customer.status !== 'ACTIVE' || !['USER', 'ADMIN', 'DEVELOPER'].includes(customer.role)) throw new Error('CUSTOMER_NOT_ELIGIBLE')
    const cabinet = (await db.collection('cabinets').doc(cabinetId).get()).data
    if (!cabinet || cabinet.status !== 'ACTIVE') throw new Error('CABINET_NOT_ACTIVE')
    const lockers = await db.collection('lockers').where({ cabinetId, id: lockerId }).limit(1).get()
    const locker = lockers.data[0]
    if (!locker || locker.enabled === false || locker.status !== 'OCCUPIED' || locker.currentRecordId !== recordId) throw new Error('LOCKER_NOT_AVAILABLE_FOR_AUTHORIZATION')
    const record = (await db.collection('depositRecords').doc(recordId).get()).data
    if (!record || record.status !== 'WAITING_PICKUP' || record.pickupCode !== pickupCode) throw new Error('BUSINESS_RECORD_VERIFICATION_FAILED')
    let issue
    try { issue = (await db.collection('unlockIssues').doc(recordId).get()).data } catch (error) {}
    if (issue && issue.status === 'REQUIRES_ONSITE_MAINTENANCE') throw new Error('REQUIRES_ONSITE_MAINTENANCE')
    let supportRequest = null
    const supportRequestId = event.supportRequestId ? String(event.supportRequestId) : ''
    if (supportRequestId) {
      try { supportRequest = (await db.collection('emergencySupportRequests').doc(supportRequestId).get()).data } catch (error) {}
      if (!supportRequest || !['OPEN', 'VERIFYING'].includes(supportRequest.status) || supportRequest.userId !== customerUserId || supportRequest.cabinetId !== cabinetId || Number(supportRequest.lockerId) !== lockerId || supportRequest.recordId !== recordId) throw new Error('SUPPORT_REQUEST_CONTEXT_MISMATCH')
    }
    const now = Date.now()
    const id = `unlock-auth-${now}-${crypto.randomBytes(5).toString('hex')}`
    const authorization = { userId: customerUserId, cabinetId, lockerId, recordId, source: 'CUSTOMER_SERVICE', reason, issuedBy: staff._id, issuedByRole: staff.role, token: `CLOUD-UA-${crypto.randomBytes(24).toString('hex')}`, nonce: crypto.randomBytes(16).toString('hex'), protocolVersion: 'MOCK_V1', command: 'OPEN_LOCK', maintenanceOrderId: null, createdAt: new Date(now).toISOString(), expiresAt: new Date(now + 5 * 60 * 1000).toISOString(), status: 'UNUSED', usedAt: null, revokedAt: null, revokedBy: null, revocationReason: null }
    const previous = await db.collection('unlockAuthorizations').where({ userId: customerUserId, recordId, status: 'UNUSED' }).get()
    const transaction = await db.startTransaction()
    try {
      for (const item of previous.data) await transaction.collection('unlockAuthorizations').doc(item._id).update({ data: { status: 'REVOKED', revokedAt: new Date(now).toISOString(), revokedBy: staff._id, revocationReason: 'SUPERSEDED' } })
      await transaction.collection('unlockAuthorizations').doc(id).set({ data: authorization })
      if (supportRequest) await transaction.collection('emergencySupportRequests').doc(supportRequestId).update({ data: { status: 'AUTHORIZED', authorizationId: id, statusReason: null, updatedAt: new Date(now).toISOString() } })
      const logId = `operation-${Date.now()}-${crypto.randomBytes(4).toString('hex')}`
      await transaction.collection('operationLogs').doc(logId).set({ data: { userId: staff._id, role: staff.role, cabinetId, lockerId, recordId, action: 'CUSTOMER_SERVICE_UNLOCK_AUTH_CREATED', result: 'SUCCESS', detail: { operatorUserId: staff._id, customerUserId, authorizationId: id, expiresAt: authorization.expiresAt, reason }, createdAt: new Date(now).toISOString() } })
      await transaction.commit()
    } catch (error) { await transaction.rollback(); throw error }
    return { ok: true, data: { ...authorization, id } }
  } catch (error) { return { ok: false, error: { code: error.message || 'CREATE_CUSTOMER_SERVICE_AUTH_FAILED' } } }
}

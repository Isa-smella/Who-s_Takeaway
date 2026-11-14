const cloud = require('wx-server-sdk')
const crypto = require('crypto')
cloud.init({ env: cloud.DYNAMIC_CURRENT_ENV })
const db = cloud.database()
const STAFF_ROLES = ['CUSTOMER_SERVICE', 'ADMIN', 'DEVELOPER']
const ACTIVE = ['OPEN', 'VERIFYING', 'AUTHORIZED', 'REQUIRES_ONSITE_MAINTENANCE']

async function requireActor() {
  const { OPENID } = cloud.getWXContext()
  const result = await db.collection('users').where({ openid: OPENID, status: 'ACTIVE' }).limit(1).get()
  const user = result.data[0]
  if (!user) throw new Error('AUTH_REQUIRED')
  const legal = (await db.collection('systemConfig').doc('legal-current').get()).data
  const consent = await db.collection('privacyConsents').where({ userId: user._id, agreementVersion: legal.agreementVersion, privacyVersion: legal.privacyVersion }).limit(1).get()
  if (!consent.data[0]) throw new Error('PRIVACY_CONSENT_REQUIRED')
  return user
}
function assertStaff(user) { if (!STAFF_ROLES.includes(user.role)) throw new Error('ROLE_FORBIDDEN') }
async function normalizeContext(input = {}) {
  const cabinetId = input.cabinetId ? String(input.cabinetId).trim().toUpperCase() : null
  const lockerId = input.lockerId === null || input.lockerId === undefined || input.lockerId === '' ? null : Number(input.lockerId)
  let recordId = input.recordId ? String(input.recordId) : null
  if (!cabinetId && lockerId !== null) throw new Error('CABINET_ID_REQUIRED')
  if (lockerId !== null && (!Number.isInteger(lockerId) || lockerId < 1)) throw new Error('LOCKER_ID_REQUIRED')
  if (!cabinetId) return { cabinetId: null, lockerId: null, recordId: null }
  const cabinet = (await db.collection('cabinets').doc(cabinetId).get()).data
  if (!cabinet) throw new Error('CABINET_NOT_FOUND')
  if (cabinet.status === 'DISABLED') throw new Error('CABINET_DISABLED')
  if (lockerId === null) return { cabinetId, lockerId: null, recordId: null }
  const lockers = await db.collection('lockers').where({ cabinetId, id: lockerId }).limit(1).get()
  const locker = lockers.data[0]
  if (!locker || locker.enabled === false) throw new Error('LOCKER_NOT_AVAILABLE')
  const activeRecordId = locker.currentRecordId || null
  if (recordId && recordId !== activeRecordId) throw new Error('SUPPORT_REQUEST_RECORD_MISMATCH')
  if (activeRecordId) {
    const record = (await db.collection('depositRecords').doc(activeRecordId).get()).data
    recordId = record && record.status === 'WAITING_PICKUP' ? activeRecordId : null
  } else recordId = null
  return { cabinetId, lockerId, recordId }
}
function sameContext(item, context) {
  if (context.recordId || item.recordId) return Boolean(context.recordId) && item.recordId === context.recordId
  return (item.cabinetId || null) === context.cabinetId && Number(item.lockerId || 0) === Number(context.lockerId || 0)
}
async function audit(transaction, actor, request, action, result = 'SUCCESS', detail = {}) {
  const id = `operation-${Date.now()}-${crypto.randomBytes(4).toString('hex')}`
  await transaction.collection('operationLogs').doc(id).set({ data: { userId: actor._id, role: actor.role, cabinetId: request.cabinetId || null, lockerId: request.lockerId || null, recordId: request.recordId || null, action, result, detail: { supportRequestId: request._id || request.id, ...detail }, createdAt: new Date().toISOString() } })
}

exports.main = async event => {
  try {
    const actor = await requireActor()
    const action = String(event.action || '')
    const now = new Date().toISOString()
    if (action === 'PREPARE') {
      const context = await normalizeContext(event.context)
      const candidates = await db.collection('emergencySupportRequests').where({ userId: actor._id }).limit(100).get()
      const existing = candidates.data.find(item => ['DRAFT', ...ACTIVE].includes(item.status) && sameContext(item, context))
      if (existing) {
        if (!['DRAFT', 'OPEN', 'VERIFYING'].includes(existing.status)) return { ok: true, data: { ...existing, id: existing._id } }
        const updated = { ...context, expiresAt: new Date(Date.now() + 30 * 60 * 1000).toISOString(), updatedAt: now }
        await db.collection('emergencySupportRequests').doc(existing._id).update({ data: updated })
        return { ok: true, data: { ...existing, ...updated, id: existing._id } }
      }
      const id = `support-request-${Date.now()}-${crypto.randomBytes(4).toString('hex')}`
      const request = { userId: actor._id, ...context, status: 'DRAFT', statusReason: null, authorizationId: null, issueId: null, createdAt: now, updatedAt: now, expiresAt: new Date(Date.now() + 30 * 60 * 1000).toISOString() }
      await db.collection('emergencySupportRequests').doc(id).set({ data: request })
      return { ok: true, data: { ...request, id } }
    }
    const requestId = String(event.requestId || '')
    if (!requestId) throw new Error('SUPPORT_REQUEST_NOT_FOUND')
    const current = (await db.collection('emergencySupportRequests').doc(requestId).get()).data
    if (!current) throw new Error('SUPPORT_REQUEST_NOT_FOUND')
    const transaction = await db.startTransaction()
    try {
      const request = (await transaction.collection('emergencySupportRequests').doc(requestId).get()).data
      let patch = { updatedAt: now }
      let logAction = ''
      let detail = {}
      if (action === 'UPDATE_CONTEXT') {
        if (request.userId !== actor._id || !['DRAFT', 'OPEN'].includes(request.status)) throw new Error('SUPPORT_REQUEST_NOT_EDITABLE')
        patch = { ...patch, ...(await normalizeContext(event.context)), statusReason: null }
        logAction = 'EMERGENCY_SUPPORT_REQUEST_CONTEXT_UPDATED'; detail.updatedBy = 'USER'
      } else if (action === 'ACTIVATE') {
        if (request.userId !== actor._id || !['DRAFT', 'OPEN'].includes(request.status)) throw new Error('SUPPORT_REQUEST_NOT_ACTIVATABLE')
        if (request.status === 'OPEN') { await transaction.rollback(); return { ok: true, data: { ...request, id: requestId } } }
        patch = { ...patch, status: 'OPEN', activatedAt: now, statusReason: null }
        logAction = 'EMERGENCY_SUPPORT_REQUEST_OPENED'
      } else if (action === 'BIND_CONTEXT') {
        assertStaff(actor)
        if (!['OPEN', 'VERIFYING'].includes(request.status)) throw new Error('SUPPORT_REQUEST_NOT_EDITABLE')
        const context = await normalizeContext(event.context)
        if (!context.cabinetId || !context.lockerId) throw new Error('LOCKER_ID_REQUIRED')
        patch = { ...patch, ...context, statusReason: context.recordId ? null : 'WAITING_FOR_VALID_RECORD' }
        logAction = 'EMERGENCY_SUPPORT_REQUEST_CONTEXT_UPDATED'; detail = { updatedBy: actor._id, activeRecordFound: Boolean(context.recordId) }
      } else if (action === 'START_HANDLING') {
        assertStaff(actor)
        if (!['OPEN', 'VERIFYING'].includes(request.status)) throw new Error('SUPPORT_REQUEST_NOT_OPEN')
        if (request.status === 'VERIFYING') { await transaction.rollback(); return { ok: true, data: { ...request, id: requestId } } }
        patch = { ...patch, status: 'VERIFYING', handlingStartedAt: now, handledBy: actor._id, statusReason: null }
        logAction = 'EMERGENCY_SUPPORT_REQUEST_PROCESSING'
      } else if (action === 'CANCEL') {
        if (request.userId !== actor._id || !['DRAFT', ...ACTIVE].includes(request.status)) throw new Error('SUPPORT_REQUEST_NOT_CANCELLABLE')
        if (request.authorizationId) {
          const authorization = (await transaction.collection('unlockAuthorizations').doc(request.authorizationId).get()).data
          if (authorization && authorization.status === 'UNUSED') await transaction.collection('unlockAuthorizations').doc(request.authorizationId).update({ data: { status: 'REVOKED', revokedAt: now, revokedBy: actor._id, revocationReason: 'USER_CANCELLED_SUPPORT_REQUEST' } })
        }
        patch = { ...patch, status: 'CANCELLED', cancelledAt: now, statusReason: 'USER_CANCELLED' }
        logAction = 'EMERGENCY_SUPPORT_REQUEST_CANCELLED'
      } else if (action === 'CLOSE') {
        assertStaff(actor)
        if (!ACTIVE.includes(request.status)) throw new Error('SUPPORT_REQUEST_NOT_CLOSABLE')
        if (request.authorizationId) {
          const authorization = (await transaction.collection('unlockAuthorizations').doc(request.authorizationId).get()).data
          if (authorization && authorization.status === 'UNUSED') await transaction.collection('unlockAuthorizations').doc(request.authorizationId).update({ data: { status: 'REVOKED', revokedAt: now, revokedBy: actor._id, revocationReason: 'STAFF_CLOSED_SUPPORT_REQUEST' } })
        }
        const reason = String(event.reason || 'STAFF_RESOLVED').slice(0, 100)
        patch = { ...patch, status: 'RESOLVED', resolvedAt: now, closedBy: actor._id, statusReason: reason }
        logAction = 'EMERGENCY_SUPPORT_REQUEST_RESOLVED'; detail.reason = reason
      } else if (action === 'REOPEN') {
        assertStaff(actor)
        if (request.status !== 'AUTHORIZED') throw new Error('SUPPORT_REQUEST_NOT_AUTHORIZED')
        if (request.authorizationId) {
          const authorization = (await transaction.collection('unlockAuthorizations').doc(request.authorizationId).get()).data
          if (authorization && authorization.status === 'UNUSED') await transaction.collection('unlockAuthorizations').doc(request.authorizationId).update({ data: { status: 'REVOKED', revokedAt: now, revokedBy: actor._id, revocationReason: 'REVOKED_BY_STAFF' } })
        }
        patch = { ...patch, status: 'OPEN', authorizationId: null, statusReason: 'AUTHORIZATION_REVOKED_BY_STAFF' }
      } else throw new Error('SUPPORT_REQUEST_ACTION_UNSUPPORTED')
      await transaction.collection('emergencySupportRequests').doc(requestId).update({ data: patch })
      const updated = { ...request, ...patch, id: requestId }
      if (logAction) await audit(transaction, actor, updated, logAction, 'SUCCESS', detail)
      await transaction.commit()
      return { ok: true, data: updated }
    } catch (error) { await transaction.rollback(); throw error }
  } catch (error) {
    console.error('manageEmergencySupportRequest failed', error)
    return { ok: false, error: { code: error.message || 'MANAGE_SUPPORT_REQUEST_FAILED' } }
  }
}

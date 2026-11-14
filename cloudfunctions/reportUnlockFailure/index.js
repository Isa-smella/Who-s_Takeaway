const cloud = require('wx-server-sdk')
const crypto = require('crypto')
cloud.init({ env: cloud.DYNAMIC_CURRENT_ENV })
const db = cloud.database()
const _ = db.command

const STATS_VERSION = 2
const MAX_CONSECUTIVE_FAILURES = 3
const ACTIVE_ORDER_STATUSES = ['PENDING', 'IN_PROGRESS', 'ONSITE', 'MANUAL_UNLOCK_COMPLETED', 'SELF_CHECK_PASSED']
const COUNTED_SOURCES = ['STORE', 'STORE_REOPEN', 'NORMAL_PICKUP', 'CUSTOMER_SERVICE']

async function getActiveUser() {
  const { OPENID } = cloud.getWXContext()
  const users = await db.collection('users').where({ openid: OPENID, status: 'ACTIVE' }).limit(1).get()
  const user = users.data[0]
  if (!user) throw new Error('AUTH_REQUIRED')
  return user
}

function assertCountedSource(source) {
  if (!COUNTED_SOURCES.includes(source)) throw new Error('UNLOCK_FAILURE_SOURCE_UNSUPPORTED')
}

async function findActiveOrder(transaction, cabinetId, lockerId) {
  const orders = await transaction.collection('maintenanceWorkOrders').where({ cabinetId, status: _.in(ACTIVE_ORDER_STATUSES) }).get()
  return orders.data.find(item => (item.type || item.targetType) === 'LOCKER' && Number(item.lockerId) === Number(lockerId)) || null
}

async function recordUnlockSuccess(user, authorizationId) {
  const transaction = await db.startTransaction()
  try {
    const authorization = (await transaction.collection('unlockAuthorizations').doc(authorizationId).get()).data
    if (!authorization || authorization.userId !== user._id || authorization.status !== 'USED') throw new Error('UNLOCK_AUTHORIZATION_INVALID')
    assertCountedSource(authorization.source)
    const lockers = await transaction.collection('lockers').where({ cabinetId: authorization.cabinetId, id: Number(authorization.lockerId) }).limit(1).get()
    const locker = lockers.data[0]
    if (!locker) throw new Error('LOCKER_NOT_FOUND')
    console.log('[UNLOCK_STATS_V2]', {
      statsVersion: STATS_VERSION, stage: 'SUCCESS_BRANCH', success: true,
      cabinetId: authorization.cabinetId, lockerId: Number(authorization.lockerId),
      alreadyReported: Boolean(authorization.successReportedAt)
    })
    if (authorization.successReportedAt) {
      const attempts = Math.max(0, Number(locker.totalUnlockAttempts) || 0)
      const consecutiveFailures = Math.max(0, Number(locker.consecutiveUnlockFailures) || 0)
      await transaction.rollback().catch(() => null)
      return {
        statsVersion: STATS_VERSION,
        consecutiveUnlockFailures: consecutiveFailures,
        totalUnlockAttempts: attempts,
        totalUnlockSuccesses: Math.max(0, Number(locker.totalUnlockSuccesses) || 0),
        totalUnlockFailures: Math.max(0, Number(locker.totalUnlockFailures) || 0),
        remainingAttempts: Math.max(0, MAX_CONSECUTIVE_FAILURES - consecutiveFailures),
        locker: { ...locker, id: Number(locker.id) }
      }
    }
    const now = new Date().toISOString()
    const totalUnlockAttempts = Math.max(0, Number(locker.totalUnlockAttempts) || 0) + 1
    const totalUnlockSuccesses = Math.max(0, Number(locker.totalUnlockSuccesses) || 0) + 1
    const totalUnlockFailures = Math.max(0, Number(locker.totalUnlockFailures) || 0)
    // 基于事务内读取的值写入全部累计字段，旧记录无需预先初始化。
    const lockerPatch = { consecutiveUnlockFailures: 0, totalUnlockAttempts, totalUnlockSuccesses, totalUnlockFailures, lastUnlockSuccessAt: now, updatedAt: now }
    await transaction.collection('lockers').doc(locker._id).update({ data: lockerPatch })
    await transaction.collection('unlockAuthorizations').doc(authorizationId).update({ data: { successReportedAt: now } })
    await transaction.commit()
    console.log('[UNLOCK_STATS_V2]', {
      statsVersion: STATS_VERSION, stage: 'SUCCESS_COMMITTED', success: true,
      cabinetId: authorization.cabinetId, lockerId: Number(authorization.lockerId),
      totalUnlockAttempts, totalUnlockSuccesses, totalUnlockFailures,
      consecutiveUnlockFailures: 0, lastUnlockSuccessAt: now
    })
    return {
      statsVersion: STATS_VERSION,
      consecutiveUnlockFailures: 0,
      totalUnlockAttempts,
      totalUnlockSuccesses,
      totalUnlockFailures,
      remainingAttempts: MAX_CONSECUTIVE_FAILURES,
      locker: { ...locker, id: Number(locker.id), ...lockerPatch, totalUnlockAttempts, totalUnlockSuccesses, totalUnlockFailures }
    }
  } catch (error) {
    await transaction.rollback().catch(() => null)
    throw error
  }
}

exports.main = async event => {
  let transaction
  try {
    console.log('[UNLOCK_STATS_V2]', { statsVersion: STATS_VERSION, stage: 'REQUEST', success: event.success, successType: typeof event.success })
    const user = await getActiveUser()
    const authorizationId = String(event.authorizationId || '')
    if (!authorizationId) throw new Error('UNLOCK_AUTHORIZATION_INPUT_INVALID')

    if (event.success === true) return { ok: true, data: await recordUnlockSuccess(user, authorizationId) }

    const failureCode = String(event.failureCode || 'DOOR_NOT_OPEN').slice(0, 64)
    transaction = await db.startTransaction()
    try {
      const authorization = (await transaction.collection('unlockAuthorizations').doc(authorizationId).get()).data
      if (!authorization || authorization.userId !== user._id || authorization.status !== 'USED') throw new Error('UNLOCK_AUTHORIZATION_INVALID')
      if (authorization.completionReportedAt) throw new Error('PICKUP_ALREADY_COMPLETED')
      if (authorization.failureReportedAt) throw new Error('UNLOCK_FAILURE_ALREADY_REPORTED')
      assertCountedSource(authorization.source)

      const lockers = await transaction.collection('lockers').where({ cabinetId: authorization.cabinetId, id: Number(authorization.lockerId) }).limit(1).get()
      const locker = lockers.data[0]
      const isInitialStore = authorization.source === 'STORE'
      const isStoreReopen = authorization.source === 'STORE_REOPEN'
      if (!locker || (isInitialStore ? (locker.status !== 'EMPTY' || locker.currentRecordId) : locker.currentRecordId !== authorization.recordId)) throw new Error('LOCKER_RECORD_MISMATCH')

      const issueId = isInitialStore ? `store-${authorization.cabinetId}-${Number(authorization.lockerId)}` : authorization.recordId
      let previous
      try { previous = (await transaction.collection('unlockIssues').doc(issueId).get()).data } catch (error) {}
      const currentFailures = Math.max(0, Number(locker.consecutiveUnlockFailures) || 0)
      const failedAttempts = Math.min(MAX_CONSECUTIVE_FAILURES, currentFailures + 1)
      const requiresOnsite = failedAttempts >= MAX_CONSECUTIVE_FAILURES
      const hasWaitingPickup = locker.status === 'OCCUPIED' || Boolean(locker.currentRecordId)
      const now = new Date().toISOString()
      const issue = {
        userId: user._id, cabinetId: authorization.cabinetId, lockerId: Number(authorization.lockerId),
        recordId: authorization.recordId || null, source: authorization.source, authorizationId,
        failedAttempts, consecutiveUnlockFailures: failedAttempts,
        remainingAttempts: Math.max(0, MAX_CONSECUTIVE_FAILURES - failedAttempts), hasWaitingPickup,
        lastFailureCode: failureCode, reason: requiresOnsite ? 'LOCK_HARDWARE_FAILURE' : 'ELECTRONIC_UNLOCK_FAILED',
        status: requiresOnsite ? 'REQUIRES_ONSITE_MAINTENANCE' : 'NORMAL_RETRY', updatedAt: now,
        createdAt: previous && previous.createdAt || now
      }
      await transaction.collection('unlockIssues').doc(issueId).set({ data: issue })
      await transaction.collection('unlockAuthorizations').doc(authorizationId).update({ data: { failureReportedAt: now, failureCode } })

      if (authorization.source === 'NORMAL_PICKUP' || authorization.source === 'CUSTOMER_SERVICE') {
        const supportRequests = await transaction.collection('emergencySupportRequests').where({ authorizationId }).get()
        for (const request of supportRequests.data) await transaction.collection('emergencySupportRequests').doc(request._id).update({ data: { status: requiresOnsite ? 'REQUIRES_ONSITE_MAINTENANCE' : 'OPEN', authorizationId: requiresOnsite ? authorizationId : null, issueId: requiresOnsite ? issueId : null, statusReason: requiresOnsite ? 'LOCK_HARDWARE_FAILURE' : 'ELECTRONIC_UNLOCK_FAILED', updatedAt: now } })
      }

      const totalUnlockAttempts = Math.max(0, Number(locker.totalUnlockAttempts) || 0) + 1
      const totalUnlockSuccesses = Math.max(0, Number(locker.totalUnlockSuccesses) || 0)
      const totalUnlockFailures = Math.max(0, Number(locker.totalUnlockFailures) || 0) + 1
      const lockerPatch = { consecutiveUnlockFailures: failedAttempts, totalUnlockAttempts: _.inc(1), totalUnlockFailures: _.inc(1), updatedAt: now }
      if (requiresOnsite) {
        lockerPatch.status = 'MAINTENANCE'
        lockerPatch.maintenanceSource = 'HARDWARE_FAULT'
        lockerPatch.previousStatus = locker.status
        lockerPatch.faultActive = true
        lockerPatch.faultCode = 'LOCK_HARDWARE_FAILURE'
        lockerPatch.faultReportedAt = now
      }
      await transaction.collection('lockers').doc(locker._id).update({ data: lockerPatch })

      if (requiresOnsite) {
        const existing = await findActiveOrder(transaction, authorization.cabinetId, authorization.lockerId)
        if (!existing) {
          const orderId = `maintenance-${authorization.cabinetId}-${authorization.lockerId}-${Date.now()}`
          await transaction.collection('maintenanceWorkOrders').doc(orderId).set({ data: { type: 'LOCKER', cabinetId: authorization.cabinetId, lockerId: Number(authorization.lockerId), recordId: authorization.recordId || null, issueId, source: isInitialStore ? 'STORE_UNLOCK_FAILURE' : isStoreReopen ? 'STORE_REOPEN_FAILURE' : 'UNLOCK_FAILURE', reason: 'LOCK_HARDWARE_FAILURE', faultCode: 'LOCK_HARDWARE_FAILURE', requiresSelfCheck: true, status: 'PENDING', createdAt: now, updatedAt: now } })
        }
      }

      const action = requiresOnsite ? 'UNLOCK_REQUIRES_ONSITE_MAINTENANCE' : 'LOCK_OPEN_FAILED'
      const logId = `operation-${Date.now()}-${crypto.randomBytes(4).toString('hex')}`
      await transaction.collection('operationLogs').doc(logId).set({ data: { userId: user._id, role: user.role, cabinetId: authorization.cabinetId, lockerId: Number(authorization.lockerId), recordId: authorization.recordId, action, result: 'FAILED', detail: { authorizationId, failureCode, failedAttempts, consecutiveUnlockFailures: failedAttempts, remainingAttempts: issue.remainingAttempts }, createdAt: now } })
      await transaction.commit()
      return { ok: true, data: { issue: { ...issue, id: issueId }, locker: { ...locker, id: Number(authorization.lockerId), ...lockerPatch, totalUnlockAttempts, totalUnlockSuccesses, totalUnlockFailures } } }
    } catch (error) { await transaction.rollback(); throw error }
  } catch (error) {
    console.error('reportUnlockFailure failed', error)
    return { ok: false, error: { code: error.message || 'REPORT_UNLOCK_FAILURE_FAILED' } }
  }
}

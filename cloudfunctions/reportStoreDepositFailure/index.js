const cloud = require('wx-server-sdk')
const crypto = require('crypto')
cloud.init({ env: cloud.DYNAMIC_CURRENT_ENV })
const db = cloud.database()

async function requireUser() {
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
  let transaction
  try {
    const user = await requireUser()
    const cabinetId = String(event.cabinetId || '').trim().toUpperCase()
    const lockerId = Number(event.lockerId)
    if (!cabinetId || !Number.isInteger(lockerId) || lockerId < 1) throw new Error('STORE_FAILURE_INPUT_INVALID')
    transaction = await db.startTransaction()
    const lockers = await transaction.collection('lockers').where({ cabinetId, id: lockerId }).limit(1).get()
    const locker = lockers.data[0]
    if (!locker || locker.enabled === false) throw new Error('LOCKER_NOT_AVAILABLE_FOR_STORE')
    if (locker.status === 'MAINTENANCE' || locker.faultActive) throw new Error('LOCKER_IN_MAINTENANCE')
    if (locker.status !== 'EMPTY' || locker.currentRecordId) throw new Error('LOCKER_NO_LONGER_EMPTY')

    const issueId = `store-deposit-${cabinetId}-${lockerId}`
    let previous
    try { previous = (await transaction.collection('unlockIssues').doc(issueId).get()).data } catch (error) {}
    const failedAttempts = Number(previous && previous.failedAttempts || 0) + 1
    const now = new Date().toISOString()
    const issue = {
      userId: user._id, cabinetId, lockerId, recordId: null, source: 'STORE_CONFIRM',
      failedAttempts, lastFailureCode: String(event.failureCode || 'STORE_CONFIRM_FAILED').slice(0, 80),
      // 这是确认存入/业务落库失败，不代表实体 @OPEN 失败；不能触发柜格硬件停用。
      reason: 'STORE_CONFIRM_FAILED',
      status: 'NORMAL_RETRY',
      createdAt: previous && previous.createdAt || now, updatedAt: now
    }
    await transaction.collection('unlockIssues').doc(issueId).set({ data: issue })

    const logId = `operation-${Date.now()}-${crypto.randomBytes(4).toString('hex')}`
    await transaction.collection('operationLogs').doc(logId).set({ data: { userId: user._id, role: user.role, cabinetId, lockerId, recordId: null, action: 'STORE_CONFIRM_RETRY_REQUIRED', result: 'FAILED', detail: { issueId, failedAttempts, failureCode: issue.lastFailureCode }, createdAt: now } })
    await transaction.commit()
    return { ok: true, data: { issue: { ...issue, id: issueId }, locker: { ...locker, id: lockerId } } }
  } catch (error) {
    if (transaction) await transaction.rollback().catch(() => null)
    return { ok: false, error: { code: error.message || 'REPORT_STORE_DEPOSIT_FAILURE_FAILED' } }
  }
}

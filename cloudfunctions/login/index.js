const cloud = require('wx-server-sdk')
const crypto = require('crypto')

cloud.init({ env: cloud.DYNAMIC_CURRENT_ENV })
const db = cloud.database()
const _ = db.command

const REGISTRATION_COUNTER_ID = 'user-registration-counter'
const MAX_REGISTRATION_SEQUENCE = Number.MAX_SAFE_INTEGER
const ALLOCATION_RETRY_LIMIT = 4

function normalizeSequence(value) {
  const sequence = Number(value)
  return Number.isInteger(sequence) && sequence > 0 && sequence <= MAX_REGISTRATION_SEQUENCE ? sequence : 0
}

function formatRegistrationNumber(sequence) {
  const normalized = normalizeSequence(sequence)
  if (!normalized) throw new Error('USER_REGISTRATION_SEQUENCE_INVALID')
  return String(normalized).padStart(5, '0')
}

function userDocumentId(openid) {
  return `user-${crypto.createHash('sha256').update(openid).digest('hex').slice(0, 32)}`
}

async function getHighestAssignedSequence() {
  const result = await db.collection('users').orderBy('registrationSequence', 'desc').limit(1).get()
  return normalizeSequence(result.data[0] && result.data[0].registrationSequence)
}

async function getRegisteredUserCount() {
  const result = await db.collection('users').count()
  return Number(result.total) || 0
}

async function normalizeAssignedUser(user) {
  const sequence = normalizeSequence(user.registrationSequence)
  if (!sequence) return null
  const registrationNumber = formatRegistrationNumber(sequence)
  if (user.registrationSequence !== sequence || user.registrationNumber !== registrationNumber || user.nickname !== registrationNumber) {
    await db.collection('users').doc(user._id).update({ data: { registrationSequence: sequence, registrationNumber, nickname: registrationNumber, updatedAt: db.serverDate() } })
  }
  return { ...user, registrationSequence: sequence, registrationNumber, nickname: registrationNumber }
}

async function assignLegacyRegistrationIdentity(user) {
  const registeredUserCount = await getRegisteredUserCount()
  const highestAssignedSequence = await getHighestAssignedSequence()
  let historicalSequence = 0
  if (user.createdAt && _ && typeof _.lt === 'function') {
    const olderUsers = await db.collection('users').where({ createdAt: _.lt(user.createdAt) }).count()
    historicalSequence = Number(olderUsers.total) + 1
  }
  let lastError = null
  for (let attempt = 0; attempt < ALLOCATION_RETRY_LIMIT; attempt += 1) {
    const transaction = await db.startTransaction()
    try {
      const freshUser = (await transaction.collection('users').doc(user._id).get()).data
      const assignedSequence = normalizeSequence(freshUser && freshUser.registrationSequence)
      if (assignedSequence) {
        const registrationNumber = formatRegistrationNumber(assignedSequence)
        await transaction.commit()
        return { ...freshUser, registrationSequence: assignedSequence, registrationNumber, nickname: registrationNumber }
      }
      let counter = null
      try { counter = (await transaction.collection('systemConfig').doc(REGISTRATION_COUNTER_ID).get()).data } catch (error) {}
      let sequence = normalizeSequence(historicalSequence)
      if (sequence) {
        const collisions = await transaction.collection('users').where({ registrationSequence: sequence }).limit(1).get()
        if (collisions.data.some(item => item._id !== user._id)) sequence = 0
      }
      const reservedMaximum = Math.max(normalizeSequence(counter && counter.currentValue), highestAssignedSequence, registeredUserCount)
      if (!sequence) sequence = reservedMaximum + 1
      if (sequence > MAX_REGISTRATION_SEQUENCE || reservedMaximum > MAX_REGISTRATION_SEQUENCE) throw new Error('USER_REGISTRATION_LIMIT_REACHED')
      const counterValue = Math.max(reservedMaximum, sequence)
      const registrationNumber = formatRegistrationNumber(sequence)
      const now = db.serverDate()
      if (counter) {
        await transaction.collection('systemConfig').doc(REGISTRATION_COUNTER_ID).update({ data: { currentValue: counterValue, updatedAt: now } })
      } else {
        await transaction.collection('systemConfig').doc(REGISTRATION_COUNTER_ID).set({ data: { currentValue: counterValue, createdAt: now, updatedAt: now } })
      }
      await transaction.collection('users').doc(user._id).update({ data: { registrationSequence: sequence, registrationNumber, nickname: registrationNumber, updatedAt: now } })
      await transaction.commit()
      return { ...freshUser, registrationSequence: sequence, registrationNumber, nickname: registrationNumber }
    } catch (error) {
      lastError = error
      try { await transaction.rollback() } catch (rollbackError) {}
      const refreshed = await db.collection('users').doc(user._id).get()
      const normalized = refreshed.data ? await normalizeAssignedUser(refreshed.data) : null
      if (normalized) return normalized
    }
  }
  throw lastError || new Error('USER_REGISTRATION_ALLOCATION_FAILED')
}

async function allocateRegistrationIdentity({ openid, appid, unionid }) {
  const highestAssignedSequence = await getHighestAssignedSequence()
  const registeredUserCount = await getRegisteredUserCount()
  let lastError = null
  for (let attempt = 0; attempt < ALLOCATION_RETRY_LIMIT; attempt += 1) {
    const transaction = await db.startTransaction()
    try {
      const matched = await transaction.collection('users').where({ openid }).limit(1).get()
      const existing = matched.data[0]
      const existingSequence = normalizeSequence(existing && existing.registrationSequence)
      if (existing && existingSequence) {
        const registrationNumber = formatRegistrationNumber(existingSequence)
        if (existing.registrationSequence !== existingSequence || existing.registrationNumber !== registrationNumber || existing.nickname !== registrationNumber) {
          await transaction.collection('users').doc(existing._id).update({ data: { registrationSequence: existingSequence, registrationNumber, nickname: registrationNumber, updatedAt: db.serverDate() } })
        }
        await transaction.commit()
        return { ...existing, registrationSequence: existingSequence, registrationNumber, nickname: registrationNumber }
      }

      let counter = null
      try { counter = (await transaction.collection('systemConfig').doc(REGISTRATION_COUNTER_ID).get()).data } catch (error) {}
      const currentValue = Math.max(normalizeSequence(counter && counter.currentValue), highestAssignedSequence, registeredUserCount)
      const registrationSequence = currentValue + 1
      if (registrationSequence > MAX_REGISTRATION_SEQUENCE) throw new Error('USER_REGISTRATION_LIMIT_REACHED')
      const registrationNumber = formatRegistrationNumber(registrationSequence)
      const now = db.serverDate()
      if (counter) {
        await transaction.collection('systemConfig').doc(REGISTRATION_COUNTER_ID).update({ data: { currentValue: registrationSequence, updatedAt: now } })
      } else {
        await transaction.collection('systemConfig').doc(REGISTRATION_COUNTER_ID).set({ data: { currentValue: registrationSequence, createdAt: now, updatedAt: now } })
      }

      let user
      if (existing) {
        await transaction.collection('users').doc(existing._id).update({ data: { registrationSequence, registrationNumber, nickname: registrationNumber, updatedAt: now } })
        user = { ...existing, registrationSequence, registrationNumber, nickname: registrationNumber }
      } else {
        const id = userDocumentId(openid)
        const data = {
          openid,
          appid: appid || '',
          unionid: unionid || '',
          role: 'USER',
          status: 'ACTIVE',
          registrationSequence,
          registrationNumber,
          nickname: registrationNumber,
          avatarUrl: '',
          createdAt: now,
          updatedAt: now
        }
        await transaction.collection('users').doc(id).set({ data })
        user = { ...data, _id: id }
      }
      await transaction.commit()
      return user
    } catch (error) {
      lastError = error
      try { await transaction.rollback() } catch (rollbackError) {}
      const afterConflict = await db.collection('users').where({ openid }).limit(1).get()
      const normalized = afterConflict.data[0] ? await normalizeAssignedUser(afterConflict.data[0]) : null
      if (normalized) return normalized
    }
  }
  throw lastError || new Error('USER_REGISTRATION_ALLOCATION_FAILED')
}

exports.main = async () => {
  try {
    const { OPENID, APPID, UNIONID } = cloud.getWXContext()
    if (!OPENID) return { ok: false, error: { code: 'WECHAT_IDENTITY_MISSING' } }
    const users = db.collection('users')
    const existing = await users.where({ openid: OPENID }).limit(1).get()
    let user = existing.data[0]
    if (user && user.status !== 'ACTIVE') return { ok: false, error: { code: 'USER_DISABLED' } }
    user = user
      ? await normalizeAssignedUser(user) || await assignLegacyRegistrationIdentity(user)
      : await allocateRegistrationIdentity({ openid: OPENID, appid: APPID, unionid: UNIONID })
    if (user.status !== 'ACTIVE') return { ok: false, error: { code: 'USER_DISABLED' } }
    const consents = await db.collection('privacyConsents').where({ userId: user._id }).limit(1).get()
    const privacyConsent = consents.data[0]
      ? { ...consents.data[0], id: consents.data[0]._id }
      : null
    // Role, registration number and consent are read from the database; none is accepted from the client.
    return { ok: true, data: { user: {
      id: user._id,
      openid: OPENID,
      role: user.role || 'USER',
      registrationSequence: user.registrationSequence,
      registrationNumber: user.registrationNumber,
      nickname: user.registrationNumber,
      avatarUrl: user.avatarUrl || ''
    }, privacyConsent } }
  } catch (error) {
    console.error('login failed', error)
    return { ok: false, error: { code: error.message || 'LOGIN_INTERNAL_ERROR' } }
  }
}

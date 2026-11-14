const cloud = require('wx-server-sdk')
const crypto = require('crypto')
cloud.init({ env: cloud.DYNAMIC_CURRENT_ENV })
const db = cloud.database()

const TYPES = ['NOTICE', 'ADVERTISEMENT', 'MAINTENANCE']
const STATUSES = ['DRAFT', 'PUBLISHED', 'DISABLED']
const DEFAULT_LABELS = { NOTICE: '公告', ADVERTISEMENT: '广告', MAINTENANCE: '维护通知' }

async function requireManager() {
  const { OPENID } = cloud.getWXContext()
  const users = await db.collection('users').where({ openid: OPENID, status: 'ACTIVE' }).limit(1).get()
  const user = users.data[0]
  if (!user || !['ADMIN', 'DEVELOPER'].includes(user.role)) throw new Error('ROLE_FORBIDDEN')
  const legal = (await db.collection('systemConfig').doc('legal-current').get()).data
  const consent = await db.collection('privacyConsents').where({ userId: user._id, agreementVersion: legal.agreementVersion, privacyVersion: legal.privacyVersion }).limit(1).get()
  if (!consent.data[0]) throw new Error('PRIVACY_CONSENT_REQUIRED')
  return user
}
function cleanText(value, maxLength) { return String(value || '').trim().slice(0, maxLength) }
function normalizeImageUrls(data) {
  const sources = Array.isArray(data.imageUrls) ? data.imageUrls : [data.imageUrl]
  return sources.map(value => cleanText(value, 500)).filter(Boolean)
    .filter((value, index, list) => list.indexOf(value) === index).slice(0, 9)
}
function getStoredImageUrls(data = {}) {
  const sources = Array.isArray(data.imageUrls) && data.imageUrls.length ? data.imageUrls : [data.imageUrl]
  return sources.map(value => String(value || '').trim()).filter(Boolean)
    .filter((value, index, list) => list.indexOf(value) === index)
}
function isManagedAnnouncementFile(fileID) {
  return /^cloud:\/\/[^/]+\/announcement-images\//i.test(String(fileID || ''))
}
async function cleanupAnnouncementFiles(fileIDs) {
  const managed = fileIDs.filter(isManagedAnnouncementFile)
    .filter((value, index, list) => list.indexOf(value) === index)
  if (!managed.length) return
  try {
    await cloud.deleteFile({ fileList: managed })
  } catch (error) {
    // 公告业务数据已经成功提交，云文件清理失败仅记录，不能回滚公告。
    console.warn('cleanup announcement images failed', { fileCount: managed.length, error: error.message })
  }
}
function normalizeDate(value) {
  if (!value) return null
  const timestamp = new Date(value).getTime()
  if (!Number.isFinite(timestamp)) throw new Error('ANNOUNCEMENT_TIME_INVALID')
  return new Date(timestamp).toISOString()
}
function normalize(data = {}) {
  const type = String(data.type || 'NOTICE').toUpperCase()
  const status = String(data.status || 'DRAFT').toUpperCase()
  if (!TYPES.includes(type)) throw new Error('ANNOUNCEMENT_TYPE_INVALID')
  if (!STATUSES.includes(status)) throw new Error('ANNOUNCEMENT_STATUS_INVALID')
  const title = cleanText(data.title, 60)
  const summary = cleanText(data.summary, 120)
  if (!title) throw new Error('ANNOUNCEMENT_TITLE_REQUIRED')
  if (!summary) throw new Error('ANNOUNCEMENT_SUMMARY_REQUIRED')
  const startsAt = normalizeDate(data.startsAt)
  const endsAt = normalizeDate(data.endsAt)
  const imageUrls = normalizeImageUrls(data)
  if (startsAt && endsAt && new Date(endsAt).getTime() <= new Date(startsAt).getTime()) throw new Error('ANNOUNCEMENT_TIME_RANGE_INVALID')
  return {
    type,
    label: cleanText(data.label, 12) || DEFAULT_LABELS[type],
    title,
    summary,
    content: cleanText(data.content, 2000) || summary,
    imageUrl: imageUrls[0] || '',
    imageUrls,
    targetUrl: cleanText(data.targetUrl, 500),
    priority: Math.min(999, Math.max(0, Number(data.priority) || 0)),
    status,
    enabled: status === 'PUBLISHED',
    startsAt,
    endsAt
  }
}
async function audit(transaction, manager, action, announcementId, detail, now) {
  const id = `operation-${Date.now()}-${crypto.randomBytes(4).toString('hex')}`
  await transaction.collection('operationLogs').doc(id).set({ data: {
    userId: manager._id, role: manager.role, cabinetId: null, lockerId: null, recordId: null,
    action, result: 'SUCCESS', detail: { announcementId, ...detail }, createdAt: now
  } })
}
async function getAnnouncement(transaction, id) {
  if (!id) throw new Error('ANNOUNCEMENT_ID_REQUIRED')
  let item = null
  try { item = (await transaction.collection('announcements').doc(id).get()).data } catch (error) {}
  if (!item || item.deletedAt) throw new Error('ANNOUNCEMENT_NOT_FOUND')
  return item
}

exports.main = async event => {
  try {
    const manager = await requireManager()
    const action = String(event.action || '').toUpperCase()
    const now = new Date().toISOString()
    const transaction = await db.startTransaction()
    let filesToDelete = []
    try {
      let output
      if (action === 'SAVE') {
        const input = normalize(event.data)
        const requestedId = cleanText(event.data && event.data.id, 100)
        if (requestedId) {
          const existing = await getAnnouncement(transaction, requestedId)
          filesToDelete = getStoredImageUrls(existing).filter(fileID => !input.imageUrls.includes(fileID))
          await transaction.collection('announcements').doc(requestedId).update({ data: { ...input, updatedAt: now, updatedBy: manager._id } })
          await audit(transaction, manager, 'ANNOUNCEMENT_UPDATED', requestedId, { beforeStatus: existing.status, afterStatus: input.status, title: input.title, removedImageCount: filesToDelete.filter(isManagedAnnouncementFile).length }, now)
          output = { ...existing, ...input, id: requestedId, updatedAt: now, updatedBy: manager._id }
        } else {
          const id = `announcement-${Date.now()}-${crypto.randomBytes(5).toString('hex')}`
          const created = { ...input, createdAt: now, updatedAt: now, createdBy: manager._id, updatedBy: manager._id, deletedAt: null }
          await transaction.collection('announcements').doc(id).set({ data: created })
          await audit(transaction, manager, 'ANNOUNCEMENT_CREATED', id, { status: input.status, title: input.title }, now)
          output = { ...created, id }
        }
      } else if (action === 'SET_STATUS') {
        const id = cleanText(event.announcementId, 100)
        const status = String(event.status || '').toUpperCase()
        if (!STATUSES.includes(status)) throw new Error('ANNOUNCEMENT_STATUS_INVALID')
        const existing = await getAnnouncement(transaction, id)
        await transaction.collection('announcements').doc(id).update({ data: { status, enabled: status === 'PUBLISHED', updatedAt: now, updatedBy: manager._id } })
        await audit(transaction, manager, 'ANNOUNCEMENT_STATUS_CHANGED', id, { previousStatus: existing.status, status }, now)
        output = { ...existing, id, status, enabled: status === 'PUBLISHED', updatedAt: now, updatedBy: manager._id }
      } else if (action === 'SOFT_DELETE') {
        const id = cleanText(event.announcementId, 100)
        const existing = await getAnnouncement(transaction, id)
        filesToDelete = getStoredImageUrls(existing)
        await transaction.collection('announcements').doc(id).update({ data: { status: 'DISABLED', enabled: false, imageUrl: '', imageUrls: [], deletedAt: now, updatedAt: now, updatedBy: manager._id } })
        await audit(transaction, manager, 'ANNOUNCEMENT_DELETED', id, { previousStatus: existing.status, title: existing.title, softDelete: true, removedImageCount: filesToDelete.filter(isManagedAnnouncementFile).length }, now)
        output = { ...existing, id, status: 'DISABLED', enabled: false, imageUrl: '', imageUrls: [], deletedAt: now, updatedAt: now }
      } else throw new Error('ANNOUNCEMENT_ACTION_UNSUPPORTED')
      await transaction.commit()
      await cleanupAnnouncementFiles(filesToDelete)
      return { ok: true, data: output }
    } catch (error) {
      await transaction.rollback()
      throw error
    }
  } catch (error) {
    console.error('manageAnnouncement failed', error)
    return { ok: false, error: { code: error.message || 'MANAGE_ANNOUNCEMENT_FAILED' } }
  }
}

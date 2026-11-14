const cloud = require('wx-server-sdk')
cloud.init({ env: cloud.DYNAMIC_CURRENT_ENV })
const db = cloud.database()

async function requireUser(scope) {
  const { OPENID } = cloud.getWXContext()
  const users = await db.collection('users').where({ openid: OPENID, status: 'ACTIVE' }).limit(1).get()
  const user = users.data[0]
  if (!user) throw new Error('LOGIN_REQUIRED')
  if (scope === 'MANAGEMENT' && !['ADMIN', 'DEVELOPER'].includes(user.role)) throw new Error('ROLE_FORBIDDEN')
  const legal = (await db.collection('systemConfig').doc('legal-current').get()).data
  const consent = await db.collection('privacyConsents').where({ userId: user._id, agreementVersion: legal.agreementVersion, privacyVersion: legal.privacyVersion }).limit(1).get()
  if (!consent.data[0]) throw new Error('PRIVACY_CONSENT_REQUIRED')
  return user
}
function activeAt(item, now) {
  if (item.status !== 'PUBLISHED' || item.deletedAt) return false
  const startsAt = item.startsAt ? new Date(item.startsAt).getTime() : 0
  const endsAt = item.endsAt ? new Date(item.endsAt).getTime() : Number.POSITIVE_INFINITY
  return now >= startsAt && now <= endsAt
}
function sortItems(items) {
  return items.sort((left, right) => Number(right.priority || 0) - Number(left.priority || 0) || String(right.updatedAt || '').localeCompare(String(left.updatedAt || '')))
}

exports.main = async event => {
  try {
    const scope = String(event.scope || 'PUBLIC').toUpperCase()
    if (!['PUBLIC', 'MANAGEMENT'].includes(scope)) throw new Error('ANNOUNCEMENT_SCOPE_INVALID')
    await requireUser(scope)
    const offset = Math.max(0, Number(event.offset) || 0)
    const limit = Math.min(100, Math.max(1, Number(event.limit) || 100))
    const result = await db.collection('announcements').skip(offset).limit(limit).get()
    let items = result.data.filter(item => !item.deletedAt).map(item => ({ ...item, id: item._id }))
    if (scope === 'PUBLIC') items = items.filter(item => activeAt(item, Date.now())).map(item => ({
      id: item.id, type: item.type, label: item.label, title: item.title, summary: item.summary,
      content: item.content, imageUrl: item.imageUrl, imageUrls: Array.isArray(item.imageUrls) ? item.imageUrls : (item.imageUrl ? [item.imageUrl] : []), targetUrl: item.targetUrl, priority: item.priority,
      startsAt: item.startsAt, endsAt: item.endsAt, updatedAt: item.updatedAt
    }))
    return { ok: true, data: { items: sortItems(items), nextOffset: result.data.length === limit ? offset + limit : null } }
  } catch (error) {
    console.error('listAnnouncements failed', error)
    return { ok: false, error: { code: error.message || 'LIST_ANNOUNCEMENTS_FAILED' } }
  }
}

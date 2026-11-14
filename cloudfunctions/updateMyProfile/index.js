const cloud = require('wx-server-sdk')

cloud.init({ env: cloud.DYNAMIC_CURRENT_ENV })
const db = cloud.database()

async function requireCurrentUser() {
  const { OPENID } = cloud.getWXContext()
  if (!OPENID) throw new Error('LOGIN_REQUIRED')
  const users = await db.collection('users').where({ openid: OPENID, status: 'ACTIVE' }).limit(1).get()
  if (!users.data[0]) throw new Error('LOGIN_REQUIRED')
  return users.data[0]
}

exports.main = async () => {
  try {
    await requireCurrentUser()
    // 账号名统一由注册顺序生成，旧客户端也不能再自行修改。
    throw new Error('REGISTRATION_NAME_IMMUTABLE')
  } catch (error) {
    console.error('updateMyProfile failed', error)
    return { ok: false, error: { code: error.message || 'UPDATE_PROFILE_FAILED' } }
  }
}

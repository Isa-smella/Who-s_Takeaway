const cloud = require('wx-server-sdk')

cloud.init({ env: cloud.DYNAMIC_CURRENT_ENV })
const db = cloud.database()

const PAGE = 'pages/home/home'
const DEFAULT_ENV_VERSION = 'develop'
const ALLOWED_ENV_VERSIONS = new Set(['develop', 'trial', 'release'])
const CODE_WIDTH = 430

function normalizeCabinetId(value) {
  const cabinetId = String(value == null ? '' : value).trim().toUpperCase()
  if (!cabinetId) throw new Error('CABINET_ID_REQUIRED')
  // Keep the scene compact and limited to characters accepted by the
  // unlimited mini-program-code API. This also prevents path-like input.
  if (!/^[A-Z0-9_-]{1,32}$/.test(cabinetId)) throw new Error('CABINET_ID_INVALID')
  return cabinetId
}

function normalizeEnvVersion(value) {
  const envVersion = String(value || DEFAULT_ENV_VERSION).trim().toLowerCase()
  if (!ALLOWED_ENV_VERSIONS.has(envVersion)) throw new Error('ENV_VERSION_INVALID')
  return envVersion
}

async function requireManager() {
  const { OPENID } = cloud.getWXContext()
  if (!OPENID) throw new Error('AUTH_REQUIRED')

  const users = await db.collection('users')
    .where({ openid: OPENID, status: 'ACTIVE' })
    .limit(1)
    .get()
  const user = users.data[0]
  if (!user) throw new Error('AUTH_REQUIRED')
  if (!['ADMIN', 'DEVELOPER'].includes(user.role)) throw new Error('ROLE_FORBIDDEN')

  const legal = (await db.collection('systemConfig').doc('legal-current').get()).data
  const consent = await db.collection('privacyConsents')
    .where({
      userId: user._id,
      agreementVersion: legal.agreementVersion,
      privacyVersion: legal.privacyVersion
    })
    .limit(1)
    .get()
  if (!consent.data[0]) throw new Error('PRIVACY_CONSENT_REQUIRED')
  return user
}

async function findCabinet(cabinetId) {
  let result
  try {
    result = await db.collection('cabinets').doc(cabinetId).get()
  } catch (error) {
    if (/not found|does not exist|不存在/i.test(String(error && error.message))) return null
    throw error
  }
  return result && result.data ? result.data : null
}

exports.main = async event => {
  try {
    await requireManager()

    const cabinetId = normalizeCabinetId(event && event.cabinetId)
    const cabinet = await findCabinet(cabinetId)
    if (!cabinet) throw new Error('CABINET_NOT_FOUND')

    // 当前联调默认使用开发版；可选版本只允许微信支持的三种值，且不会进入 scene。
    const envVersion = normalizeEnvVersion(event && event.envVersion)
    const wxacode = await cloud.openapi.wxacode.getUnlimited({
      scene: cabinetId,
      page: PAGE,
      envVersion,
      checkPath: envVersion === 'release',
      width: CODE_WIDTH
    })
    if (!wxacode || !wxacode.buffer) {
      throw new Error((wxacode && (wxacode.errMsg || wxacode.errmsg)) || 'WXACODE_GENERATE_FAILED')
    }

    const cloudPath = `cabinet-codes/${cabinetId}.png`
    const uploadResult = await cloud.uploadFile({
      cloudPath,
      fileContent: wxacode.buffer
    })
    if (!uploadResult || !uploadResult.fileID) throw new Error('CABINET_CODE_UPLOAD_FAILED')

    let tempFileURL = ''
    try {
      const tempResult = await cloud.getTempFileURL({ fileList: [uploadResult.fileID] })
      const item = tempResult && tempResult.fileList && tempResult.fileList[0]
      tempFileURL = item && item.tempFileURL ? item.tempFileURL : ''
    } catch (error) {
      console.warn('generateCabinetMiniProgramCode temp URL failed', error)
    }

    return {
      ok: true,
      data: {
        cabinetId,
        page: PAGE,
        scene: cabinetId,
        envVersion,
        cloudPath,
        fileID: uploadResult.fileID,
        tempFileURL,
        contentType: wxacode.contentType || 'image/png'
      }
    }
  } catch (error) {
    console.error('generateCabinetMiniProgramCode failed', error)
    return { ok: false, error: { code: error.message || 'GENERATE_CABINET_CODE_FAILED' } }
  }
}

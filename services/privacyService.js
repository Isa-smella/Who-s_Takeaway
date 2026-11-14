const privacyConsentRepository = require('../repositories/privacyConsentRepository')
const { AGREEMENT_VERSION, PRIVACY_VERSION, MOCK_AUTO_CONSENT, USE_CLOUD } = require('../config/env')
const cloudService = require('./cloudService')

function getCurrentConsent(userId) { return userId ? privacyConsentRepository.getByUserId(userId) : null }
function hasCurrentConsent(userId) {
  const consent = getCurrentConsent(userId)
  return Boolean(consent && consent.agreementVersion === AGREEMENT_VERSION && consent.privacyVersion === PRIVACY_VERSION)
}
function agree(userId) {
  if (!userId) throw new Error('USER_ID_REQUIRED')
  if (USE_CLOUD) {
    return cloudService.callFunction('agreePrivacy').then(consent => privacyConsentRepository.save(consent))
  }
  return privacyConsentRepository.save({
    id: `consent-${userId}-${Date.now()}`,
    userId,
    agreementVersion: AGREEMENT_VERSION,
    privacyVersion: PRIVACY_VERSION,
    agreedAt: new Date().toISOString()
  })
}
function initialize(user) {
  if (user && MOCK_AUTO_CONSENT && !USE_CLOUD && !hasCurrentConsent(user.id)) return agree(user.id)
  return getCurrentConsent(user && user.id)
}

module.exports = { initialize, agree, hasCurrentConsent, getCurrentConsent, AGREEMENT_VERSION, PRIVACY_VERSION }

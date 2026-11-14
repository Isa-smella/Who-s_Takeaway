const authService = require('../../services/authService')
const privacyService = require('../../services/privacyService')
const operationLogService = require('../../services/operationLogService')
const ACTIONS = require('../../constants/operationActions')
const { LEGAL_DOCUMENTS } = require('../../config/publicInfo')

Page({
  data: { agreementChecked: false, privacyChecked: false, submitting: false },
  onLoad() { if (!authService.isLoggedIn()) wx.redirectTo({ url: '/pages/login/login' }) },
  toggleLegalConsent() {
    const checked = !(this.data.agreementChecked && this.data.privacyChecked)
    this.setData({ agreementChecked: checked, privacyChecked: checked })
  },
  showAgreement() { wx.showModal({ title: LEGAL_DOCUMENTS.agreement.title, content: LEGAL_DOCUMENTS.agreement.content, showCancel: false }) },
  showPrivacy() { wx.showModal({ title: LEGAL_DOCUMENTS.privacy.title, content: LEGAL_DOCUMENTS.privacy.content, showCancel: false }) },
  agreeAndContinue() {
    if (!this.data.agreementChecked || !this.data.privacyChecked || this.data.submitting) return
    const user = authService.getCurrentUser()
    this.setData({ submitting: true })
    Promise.resolve(privacyService.agree(user.id)).then(consent => {
      operationLogService.log(ACTIONS.PRIVACY_AGREED, { detail: { agreementVersion: consent.agreementVersion, privacyVersion: consent.privacyVersion } })
      return getApp().resumePendingCabinet()
    })
      .then(() => wx.reLaunch({ url: '/pages/home/home' }))
      .catch(error => {
        this.setData({ submitting: false })
        const title = error && error.message === 'PRIVACY_CONSENT_INTERNAL_ERROR' ? '协议确认失败，请检查云端索引' : '继续进入失败，请重试'
        wx.showToast({ title, icon: 'none' })
        console.error('privacy consent flow failed', error)
      })
  }
})

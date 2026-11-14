const LEGAL_DOCUMENTS = Object.freeze({
  agreement: Object.freeze({
    title: '用户协议',
    version: 'dev-1',
    content: '当前为开发测试版本。正式发布前需要补充服务范围、用户行为规范、存取责任边界、异常处理、责任限制和协议更新方式，并同步更新云端 agreementVersion。'
  }),
  privacy: Object.freeze({
    title: '隐私政策',
    version: 'dev-1',
    content: '当前为开发测试版本。正式发布前需要说明微信身份、柜体与柜格、存取记录、反馈、设备及操作日志等数据的收集目的、保存期限、用户权利和联系渠道，并同步更新云端 privacyVersion。'
  })
})

const CONTACT_INFO = Object.freeze({
  customerServiceChannel: 'WECHAT_MINIPROGRAM_CONTACT',
  cooperationTitle: '合作联系',
  cooperationQQ: '1281949372',
  cooperationContent: '如需咨询校园柜体投放、场地合作或商务合作，请联系 QQ：1281949372。'
})

module.exports = { LEGAL_DOCUMENTS, CONTACT_INFO }

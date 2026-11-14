// 当前阶段的公告 Mock 数据。后续接入云端后，由 announcementService 替换数据来源。
module.exports = [
  {
    id: 'notice-board-enabled',
    type: 'NOTICE',
    label: '公告',
    title: '公告栏已启用',
    summary: '柜体维护、取餐提醒及合作信息将在这里发布。',
    content: '后续可以在公告栏发布柜体维护通知、校园告示、合作信息或广告内容。',
    imageUrl: '',
    imageUrls: [],
    targetUrl: '',
    enabled: true,
    priority: 100,
    startsAt: '2026-08-26T00:00:00+08:00',
    endsAt: null
  }
]

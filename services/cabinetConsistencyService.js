const ISSUE_LABELS = {
  EMPTY_WITH_WAITING_RECORD: '显示空闲，但存在未取餐记录',
  EMPTY_WITH_STALE_BINDING: '显示空闲，但仍绑定业务记录',
  OCCUPIED_WITHOUT_WAITING_RECORD: '显示占用，但没有未取餐记录',
  RECORD_BINDING_MISMATCH: '柜格绑定记录与未取餐记录不一致',
  MULTIPLE_WAITING_RECORDS: '同一柜格存在多条未取餐记录'
}

function inspect(lockers = [], records = []) {
  const waitingRecords = records.filter(record => record && record.status === 'WAITING_PICKUP')
  const issues = []
  lockers.forEach(locker => {
    const lockerId = Number(locker.id)
    const matched = waitingRecords.filter(record => Number(record.lockerId) === lockerId)
    const matchedIds = matched.map(record => String(record.id || record._id || '')).filter(Boolean)
    function add(type, detail = {}) {
      issues.push({ type, label: ISSUE_LABELS[type], lockerId, lockerNumber: String(lockerId).padStart(2, '0'), recordIds: matchedIds, ...detail })
    }
    if (matched.length > 1) add('MULTIPLE_WAITING_RECORDS', { waitingRecordCount: matched.length })
    if (locker.status === 'EMPTY') {
      if (matched.length) add('EMPTY_WITH_WAITING_RECORD')
      else if (locker.currentRecordId) add('EMPTY_WITH_STALE_BINDING', { currentRecordId: locker.currentRecordId })
    }
    if (locker.status === 'OCCUPIED') {
      if (!matched.length) add('OCCUPIED_WITHOUT_WAITING_RECORD', { currentRecordId: locker.currentRecordId || null })
      else if (!locker.currentRecordId || !matchedIds.includes(String(locker.currentRecordId))) {
        add('RECORD_BINDING_MISMATCH', { currentRecordId: locker.currentRecordId || null })
      }
    }
  })
  return issues.sort((left, right) => left.lockerId - right.lockerId || left.type.localeCompare(right.type))
}

module.exports = { inspect, ISSUE_LABELS }

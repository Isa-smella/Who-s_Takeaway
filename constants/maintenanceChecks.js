// 小程序运行时的维修人工检查项；云函数目录按独立部署单元各自维护同一组键。
const CHECK_KEYS = Object.freeze(['electronicLock', 'wiring', 'driver', 'power'])
const CHECK_ITEM_LABELS = Object.freeze({
  electronicLock: '电子锁',
  wiring: '线路',
  driver: '驱动',
  power: '电源'
})

module.exports = { CHECK_KEYS, CHECK_ITEM_LABELS }

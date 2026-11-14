# 云数据库索引清单

本项目所有集合均继续使用“所有用户不可读写”，数据只由云函数访问。以下索引用于正式数据量下的复合查询和倒序分页。

## 第一批：核心业务索引

| 集合 | 字段顺序 | 用途 |
| --- | --- | --- |
| `users` | `openid` 升序、`status` 升序 | 微信登录与云端身份校验 |
| `privacyConsents` | `userId` 升序、`agreementVersion` 升序、`privacyVersion` 升序 | 当前协议版本门禁 |
| `lockers` | `cabinetId` 升序、`id` 升序 | 按柜体和柜格定位 |
| `lockers` | `cabinetId` 升序、`status` 升序 | 客服/管理端统计占用柜格 |
| `depositRecords` | `cabinetId` 升序、`status` 升序 | 柜体未取餐查询 |
| `depositRecords` | `cabinetId` 升序、`lockerId` 升序、`status` 升序 | 柜格未取餐校验 |
| `depositRecords` | `depositorUserId` 升序、`storedAt` 降序 | 我的存入记录 |
| `depositRecords` | `pickedByUserId` 升序、`status` 升序、`pickedAt` 降序 | 我的取餐记录 |
| `feedback` | `userId` 升序、`createdAt` 降序 | 我的反馈 |
| `unlockAuthorizations` | `userId` 升序、`recordId` 升序、`status` 升序 | 正常/客服授权去重 |
| `unlockAuthorizations` | `userId` 升序、`source` 升序、`status` 升序 | 用户待执行客服授权 |
| `unlockAuthorizations` | `cabinetId` 升序、`status` 升序 | 柜体进入维修时撤销授权 |
| `maintenanceWorkOrders` | `status` 升序、`updatedAt` 降序 | 维修工单列表 |
| `maintenanceWorkOrders` | `cabinetId` 升序、`status` 升序 | 柜体当前维修工单 |
| `emergencySupportRequests` | `userId` 升序、`updatedAt` 降序 | 用户自己的紧急客服请求 |
| `announcements` | `status` 升序、`priority` 降序、`updatedAt` 降序 | 首页有效公告及管理端排序（数据量增加后启用云端筛选） |

## 第二批：操作日志索引

操作日志支持组合筛选。至少建立：

| 集合 | 字段顺序 | 用途 |
| --- | --- | --- |
| `operationLogs` | `createdAt` 降序 | 管理员查看全部日志 |
| `operationLogs` | `userId` 升序、`createdAt` 降序 | 按用户查询 |
| `operationLogs` | `cabinetId` 升序、`createdAt` 降序 | 按柜体查询 |
| `operationLogs` | `recordId` 升序、`createdAt` 降序 | 按业务记录查询 |
| `operationLogs` | `action` 升序、`createdAt` 降序 | 按操作类型查询 |
| `operationLogs` | `userId` 升序、`action` 升序、`createdAt` 降序 | 客服按用户查询允许的操作 |
| `operationLogs` | `cabinetId` 升序、`action` 升序、`createdAt` 降序 | 客服按柜体查询允许的操作 |

运营分析事件集合建议建立：

| 集合 | 字段顺序 | 用途 |
| --- | --- | --- |
| `operationEvents` | `createdAt` 降序 | 服务端按时间范围聚合事件 |
| `operationEvents` | `type` 升序、`createdAt` 降序 | 按事件类型聚合 |
| `operationEvents` | `cabinetId` 升序、`createdAt` 降序 | 柜体健康与使用分析 |

如后台实际需要同时按柜体、柜格、结果和时间组合检索，再根据云开发控制台的缺失索引提示增加对应组合索引；不要预先创建所有排列组合。

## 单字段索引

以下字段会被直接查询，应保留或建立普通单字段索引：

- `cabinets.bleIdentifier`
- `users.createdAt`
- `users.registrationSequence`
- `users.registrationNumber`
- `emergencySupportRequests.authorizationId`
- `emergencySupportRequests.recordId`
- `maintenanceWorkOrders.updatedAt`
- `emergencySupportRequests.updatedAt`
- `feedback.createdAt`

## 注意事项

- 字段名必须与表格完全一致，尤其是 `openid`，不是系统字段 `_openid`。
- 时间排序字段使用“降序”。
- 数据库权限不能因为创建索引而改为客户端可读写。
- 新增云函数查询条件时，应同步更新本清单。

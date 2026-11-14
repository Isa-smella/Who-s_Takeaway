# 架构边界（云端业务与实体 BLE 链路已接入）

## 已建立的边界

- `authService`：统一用户会话；云模式使用微信身份和 `login` 云函数。
- `login` 在云端事务中维护注册序号，账号名格式化为至少五位的 `registrationNumber`。旧用户按 `createdAt` 补号，新用户从现有用户总数和计数器的较大值继续递增；客户端不能提交、修改或复用编号。
- `privacyService`：统一协议版本确认。
- `permissionGuard`：统一登录、隐私、角色和核心业务门禁。
- 登录是所有功能入口的前置条件；未登录时仅保留登录、用户协议、隐私政策和必要登录说明。手动扫一扫会先校验登录与协议，扫码启动参数则先保存为 `pendingCabinetId`，登录并同意协议后再恢复，之后才加载柜体和连接 BLE。
- `cabinetSessionService`：持久保存扫码得到的 pendingCabinetId，登录/协议流程后恢复。
- `operationLogService`：统一不可变操作日志；云端关键业务由各受保护云函数写入 `operationLogs`。
- `operationEventService`：统一旁路运营事件入口；事件写入 `operationEvents` 失败不阻塞主业务，统计由 `getOperationsAnalytics` 服务端聚合。
- `cabinetRepository`：柜体查询。
- `lockerRepository`：柜格状态接口。
- `depositRepository`：存入、验证与取餐接口。
- `feedbackRepository`：反馈接口。
- `deviceRepository`：按 cabinetId 读取电池、电压、在线状态和固件版本；硬件接入前由调试页模拟控制器上报。
- `bleLockerService`：负责 HM-10 文本 BLE 的扫描、连接、FFE0/FFE1、Notify、`@IDENTIFY`、`@OPEN` 和 `@STATUS`。
- `bluetoothService`：提供应用层已验证连接门面；只有 BLE 已连接、Notify 成功且 `@IDENTIFY` 与 cabinetId 一致时才算已连接。
- `doorSensorService`：统一门状态入口；电子锁蓝白反馈返回 `OPEN/LOCKED`，上层映射为 `OPEN/CLOSED`，不依赖独立门磁。
- `cabinetTelemetryService`：已验证连接期间按周期查询全部柜格，并通过 `reportCabinetTelemetry` 同步实体门状态。
- `reportCabinetTelemetry`：在同一云端事务中更新 `Locker.doorStatus` 与 `Cabinet.lastBleSeenAt`。
- `reportOperationEvent` / `getOperationsAnalytics`：分别负责安全写入运营事件和管理端服务端统计；运营分析页面不下载原始事件到前端统计。

## 客服授权开锁与现场应急

- `ADMIN` 是“客服 plus”，继承 `CUSTOMER_SERVICE` 的授权签发和查询能力；客服不属于 `MANAGEMENT_ROLES`。
- 客服只针对现有 `WAITING_PICKUP` 记录核对取餐码、目标用户和原因，再签发绑定 `userId/cabinetId/lockerId/recordId` 的 `EmergencyUnlockAuthorization`。不存在业务记录时不能指定任意柜格。
- 客服手机不连接柜体，也不直接开锁。固定链路为：客服 → 云端 → 顾客小程序 → 顾客手机 BLE → HM-10 → STM32。STM32 当前不依赖 Wi-Fi/4G。
- 该限制同时落在 `app.enterCabinet`、BLE 建连方法、普通取餐授权和 `lockService`，不能靠绕过客服页面获得连接或开锁能力。客服扫描柜体码时只进入只读核验页，不建立 BLE；ADMIN/DEVELOPER 仍按各自管理权限处理实体柜。
- 授权使用 `UNUSED / USED / EXPIRED / REVOKED` 状态；当前 token 为短时云端占位格式。正式发布前由云端签发可被 STM32 离线验证的签名凭证，并提供防重放校验。
- 紧急客服请求使用 `DRAFT / OPEN / VERIFYING / AUTHORIZED / REQUIRES_ONSITE_MAINTENANCE / RESOLVED / CANCELLED / EXPIRED`。同一用户、同一 recordId 的活动请求去重；没有业务记录时按柜体和可选柜格去重。
- 未扫码请求允许用户自行补充或客服根据聊天内容补录 `cabinetId/lockerId`。客服端只能从 CabinetRepository 和该柜体实际 Locker 中选择，不能录入不存在的目标；绑定时自动查询当前 `WAITING_PICKUP` 记录，取餐码仍只在后续核验步骤使用。
- 用户可取消请求或放弃未使用授权，客服可撤销授权或关闭请求；柜体/柜格进入维修和业务记录失效会自动撤销关联的未使用授权。所有撤销原因均写入审计日志。
- 客服操作记录查询支持用户 ID、注册编号或柜体范围。注册编号先由云端解析为内部 userId，再套用客服允许的用户业务动作白名单；没有反馈或紧急请求不是查询操作记录的前置条件。
- 普通取餐和客服授权都调用 `requestUnlockAuthorization`，再进入统一 `unlockExecutionService`；区别只是授权来源 `NORMAL_PICKUP / CUSTOMER_SERVICE`。授权成功不等于开锁成功，只有 STM32 返回实体开锁成功且电子锁反馈确认 `OPEN` 后才完成 DepositRecord。
- “我的存入记录”允许存餐者在10分钟内为本人仍处于 `WAITING_PICKUP` 的记录进入再次存入流程，并申请 `STORE_REOPEN` 一次性授权。开柜后必须重新关门、输入手机号后4位并确认；系统更新原记录的取餐码和最新存入时间，不创建重复记录，柜格继续保持 `OCCUPIED`。
- 一次性授权在真正提交硬件尝试时消费，开锁失败也不能重复使用。客服可在核验后重新签发，但连续电子开锁失败达到阈值后，问题进入 `REQUIRES_ONSITE_MAINTENANCE`，柜格自动进入维修并停止授权。
- 现场机械应急开锁由管理员/维修人员完成。软件只记录 `MANUAL_EMERGENCY_UNLOCK`；完成交付后柜格仍为 `MAINTENANCE`，必须检查电子锁、线路、驱动和电源四项，自检通过后再由管理员恢复。
- 审计日志区分 `CUSTOMER_SERVICE_UNLOCK_AUTH_CREATED / ATTEMPT / SUCCESS / FAILED`，并关联操作员、顾客、柜体、柜格、记录和授权 ID；日志不保存 token 或用户输入的取餐码明文。

## 管理端边界

- 正式管理中心与开发调试工具是两个独立页面。
- `ADMIN` 和 `DEVELOPER` 可以进入管理中心；`USER` 和客服不能进行柜格管理。
- 占用中的柜格禁止直接设置维修，避免覆盖正在进行的业务。
- 占用柜实际为空时只能走“开柜核空”：管理员先取得绑定当前 `WAITING_PICKUP` 记录的短时授权并在现场成功开柜，再二次确认空柜。确认后原记录进入 `ADMIN_CLEARED`，柜格才变为 `EMPTY`；该过程不写入 `PICKED_UP`，也不会伪造成用户取餐。
- 核空授权必须属于当前管理员、柜体、柜格和记录，且已经被本次开柜尝试消费；确认窗口为开柜后5分钟。云端在提交时重新读取柜格和记录，状态已变化时拒绝清空。
- 维修与恢复操作统一写入 OperationLog。
- 控制器/设备层上报柜格故障后，由 `deviceHealthService` 自动切换为维修中；管理员不能直接清除硬件故障。
- 设备自检通过只解除故障锁，柜格仍保持维修中，需管理员再次确认后才恢复使用。
- 硬件故障会创建 `MaintenanceWorkOrder`。工单状态为 `PENDING / IN_PROGRESS / ONSITE / MANUAL_UNLOCK_COMPLETED / SELF_CHECK_PASSED / RESOLVED`，记录负责人、到场、四项检查、自检、机械开锁和最终恢复时间。
- 所有维修来源（包括管理员人工设置维修）都必须先完成 STM32/电子锁实体自检，管理员才可恢复。因真实硬件故障创建的工单还必须满足电子锁、线路、驱动、电源四项全部正常；人工维修后若又出现硬件故障，现有工单会自动升级并追加四项检查要求。
- 整柜控制器故障采用相同状态机：设备故障自动将 Cabinet 设为 `MAINTENANCE` 并断开当前 BLE；ESP 自检通过后仍需管理员确认恢复。
- 故障检测、自检通过、无效恢复尝试和最终恢复均写入不可修改的 OperationLog。
- 电池遥测按 cabinetId 隔离；正式版由云端设备数据替换 Mock Repository。

## 门状态与云端同步语义

- 当前已连接柜体时，`@STATUS:xx` 返回的是实时实体门状态：`OPEN` 映射为 `doorStatus=OPEN`，`LOCKED` 映射为 `doorStatus=CLOSED`。
- 云端 `Locker.doorStatus` 表示最近一次通过已验证 BLE 连接成功同步的已知状态，不等同于无连接时的实时读取。
- `Cabinet.lastBleSeenAt` 与整批柜格遥测同步写入，表示最近一次实体柜体状态同步时间。

## 运营分析时间口径

- 面向运营人员的日期、小时与统计周期统一使用北京时间（固定 UTC+8），不依赖服务器或用户手机的本地时区。
- `getOperationsAnalytics/beijingTime.js` 统一处理绝对时间解析、北京时间边界、小时/日期桶以及维修明细时间展示。日期字段继续保存原始 Date/时间戳，不向数据库时间人为增加8小时。
- “今天”为北京时间00:00至次日00:00，采用左闭右开区间，始终保留00至23时的24个桶。近7天/30天包含今天，按北京时间自然日对齐，分别保留7/30个日期桶。
- 自定义范围提交 `range=CUSTOM` 与 `YYYY-MM-DD` 格式的 `startDate/endDate`，只选择北京时间日历日期，结束日期包含整天。前后端拒绝逆序、格式错误和未来结束日期，服务端还校验真实日历日期；不静默裁剪用户选择。
- 自定义单日沿用24小时桶，多日按每天一个桶返回；不限制为31个桶，长范围只抽样X轴文字，全部数据点仍可触摸选择。当前维修柜格数继续表示当前快照。
- 日期picker的“今天”和默认近7天日期由服务端统一时间工具返回，页面只保存草稿日期和已确认日期；确认后才请求统计，前端不将日期转换成UTC时间戳。
- 服务端返回固定时区的 `labels`、`bucketKeys` 和范围元信息；前端坐标轴与 Tooltip 直接展示返回标签，不根据设备本地时区重新计算。

## 柜体生命周期

- 柜体均从 `CabinetRepository` 动态加载，小程序代码中不维护固定柜体清单。
- `Cabinet.status` 的正式业务状态只有 `ACTIVE / MAINTENANCE`；旧数据中的 `DISABLED` 仅作为迁移输入，管理页面加载后会自动转为 `MAINTENANCE` 并补建维修工单。
- `cabinetId` 创建后不可编辑；更换编号采用新增柜体，并将旧柜体设置为整柜维修。
- 柜格数量对应实体结构，只允许在创建 Cabinet 时设置；初始化后不可增减。
- 单个柜格的业务状态只有 `EMPTY / OCCUPIED / MAINTENANCE`，管理员可以设置维修、在满足工单条件后恢复使用，或对实际为空的占用柜执行受控核空。
- 占用中或仍关联未取餐记录的柜格不能人工设置维修，避免覆盖真实业务记录。
- 人工设置维修和设备故障都会创建维修工单；维修中的柜体或柜格不会接受新的存餐或普通开锁授权。
- 扫码进入前先查询柜体状态；`MAINTENANCE` 不会连接 BLE。旧 `DISABLED` 数据也按维修处理并触发迁移。
- 柜体新增、修改、整柜维修和恢复均写入 OperationLog；旧状态迁移同样留下审计记录。
- `cabinetMonitoringService` 聚合各柜体状态、设备遥测和柜格异常，为多柜体管理列表提供统一异常总览；未来可替换为云端聚合查询。

## 反馈处理权限

- 用户端只显示自己提交的反馈内容和时间，不要求用户持续关注内部处理状态。
- `ADMIN / CUSTOMER_SERVICE / DEVELOPER` 可进入反馈处理后台，查看提交用户、柜体、可选柜格和描述。
- 工作人员可在内部使用 `PENDING / PROCESSING / RESOLVED`，每次状态变化写入 `FEEDBACK_UPDATED` 审计日志。
- 反馈卡片可以按提交用户、柜体和可选柜格跳转到操作轨迹；日志页继续支持操作类型、成功/失败和日期范围组合筛选。
- `USER` 即使直接调用管理 Service 也会被角色守卫拒绝；Feedback 与审计记录均不提供删除接口。

## 数据归属

云端保存 User（含不可修改的 `registrationSequence/registrationNumber`）、Cabinet、Locker 业务状态、DepositRecord、Feedback、PrivacyConsent、OperationLog、授权、紧急请求和维修工单。客户端仅保存会话类状态（例如 pendingCabinetId）、必要缓存与实时硬件状态；BLE连接状态不进入共享业务数据库。

## 本地 Mock 与云端开关

当前配置使用 `USE_CLOUD=true`。`MOCK_AUTO_LOGIN` 与 `MOCK_AUTO_CONSENT` 只在关闭云模式的本地回归测试中生效，不参与真实云端身份和协议门禁。

开发登录页可模拟 `USER`、`ADMIN`、`CUSTOMER_SERVICE` 和 `DEVELOPER`。存餐者与取餐者统一为 `USER`，同一账号同时拥有存餐和取餐能力；存入记录以 `depositorUserId` 归属，成功取餐以 `pickedByUserId` 归属。旧 Mock 缓存中的 `CUSTOMER`、`RIDER` 和 `riderId` 会在读取时兼容迁移。正式版本仍由云端决定 userId 与角色。

个人中心统计严格按当前用户区分“本人存入”和“本人成功取餐”；客服或管理员只有从管理入口携带柜体条件查询时才能查看权限范围内的跨用户业务记录。客服授权取餐、现场机械应急取餐和用户自助取餐使用不同展示标签。

开发调试重置通过独立 `mockDataResetService` 清理指定柜体在各个 Mock Repository 中的数据，页面不直接拼接多个本地缓存键。此能力只允许 `DEVELOPER`，正式 Cloud Repository 不提供客户端删除业务事实或审计日志的接口。

# 微信云函数部署说明

当前目录包含云函数。核心云函数、集合、索引和主要业务流程已完成部署验证；新增或修改的云函数需要在对应功能启用前重新部署。HM-10 + STM32 实体 BLE、电子锁反馈和维修恢复链已经真机验证；正式签名授权仍需在发布前完成。

## 部署检查清单

- 只要修改 `cloudfunctions/<name>/` 下的代码，完成报告必须明确列出需要重新部署的云函数。
- 修改云函数后，在微信开发者工具中对对应目录执行“上传并部署：云端安装依赖”。
- 确认部署环境与客户端 `config/env.js` 的 `CLOUD_ENV_ID` 一致。
- 部署后至少验证一次对应云函数的真实调用，不能只依赖本地静态检查。
- 如果云函数名称、入口或依赖发生变化，必须在报告中单独说明，并重新执行相关真机回归。

## 当前接入进度

`login/` 通过 `cloud.getWXContext()` 获取 OPENID，在 `users` 集合中查询账号；首次登录只能创建 `USER`，不会接收客户端提交的角色。当前客户端配置为 `USE_CLOUD=true`，云环境 ID 为 `cloud1-takeaway-d9fcdc9a85c2ebda`。

启用云模式前需要：

1. 在微信开发者工具中创建云环境并填写 `CLOUD_ENV_ID`。
2. 创建 `users` 集合。
   同时创建 `privacyConsents`、`systemConfig`、`cabinets`、`lockers`、`depositRecords`、`feedback`、`operationLogs`、`operationEvents`、`unlockAuthorizations`、`pickupRateLimits`、`unlockIssues`、`emergencySupportRequests`、`maintenanceWorkOrders`、`deviceTelemetry`、`bleIdentifiers`、`announcements` 集合，并在 `systemConfig` 中建立 `_id=legal-current`：

   ```json
   { "agreementVersion": "dev-1", "privacyVersion": "dev-1" }
   ```

   `cabinets` 使用 `cabinetId` 作为文档 `_id`；`lockers` 每条记录必须包含 `cabinetId` 和数字类型 `id`。
   完整索引及字段顺序见 `../docs/CLOUD_DATABASE_INDEXES.md`。
3. 对本目录中已经实现的各云函数分别执行“上传并部署：云端安装依赖”。
4. 将 `users` 及后续核心业务集合的客户端读写权限设为拒绝，业务操作只允许经过云函数。
5. 管理员、客服、开发者角色只能由受控后台写入，不能由小程序客户端更新。

云模式每次启动都会清除本地角色缓存，避免从 Mock 模式残留 `DEVELOPER` 身份；完成云登录后才建立本次会话。用户存取、个人历史、用户反馈、客服授权、紧急客服请求、后台反馈处理、分权限操作日志、柜体管理、实体柜体遥测和维修工单均已接入。开发阶段仍可由 `DEVELOPER` 使用 Mock 页面做回归，但正式设备链路使用 HM-10 + STM32。

`getOperationLogs` 不提供删除或修改能力。`CUSTOMER_SERVICE` 必须指定用户 ID、注册编号或柜体范围，并只能查询业务处理所需动作；`ADMIN/DEVELOPER` 才能查询更广的管理审计。返回前会移除 token、取餐码、openid、签名和密码等敏感字段。

当前云端授权仍使用随机 token 和 `MOCK_V1` 协议，以便在没有真实控制器的阶段验证业务状态机。它还不是可供实体设备离线验签的正式凭证；签名算法、密钥下发、设备侧验签和持久化防重放属于第3步控制器固件工作。

- `login`：使用微信身份换取云端 User 与角色；在事务中按注册顺序分配至少五位的 `registrationNumber`（`00001` 起），既有账号按原 `createdAt` 补号。客户端不能指定编号或 ADMIN/CUSTOMER_SERVICE/DEVELOPER 角色。
- `updateMyProfile`：保留用于拒绝旧客户端的改名请求，统一返回 `REGISTRATION_NAME_IMMUTABLE`；注册编号不可修改。
- `getCabinet`：按 cabinetId 返回柜体、位置、BLE身份与设备配置。
- `listCabinetsForManagement`：按管理权限查询全部柜体及柜格状态汇总；旧 `DISABLED` 数据按维修中返回并由管理端迁移。
- `getCabinetManagementDetail`：返回管理详情、柜格、活动维修工单、故障事件及未取餐数量。
- `manageCabinet`：统一执行新增、编辑、整柜维修/恢复、单格维修/恢复和占用柜开柜核空；所有恢复动作都由服务端强制校验设备自检成功，真实硬件故障还需四项现场检查正常。核空要求绑定当前待取记录的管理员短时授权已经被现场开柜尝试消费，且必须在5分钟内确认；确认后记录进入 `ADMIN_CLEARED`，不会伪造 `PICKED_UP`。服务端拒绝修改初始化后的柜格数量。新柜体先进入 `PROVISIONING`，柜格全部创建后才切换为 `ACTIVE`；旧停用动作仅用于兼容历史客户端，并统一转成维修中。
- `getLockers`：按 cabinetId 返回柜格业务状态。
- `reportDeviceHealth`：开发阶段由 DEVELOPER 模拟可信设备上报电量、故障和自检结果；真实设备接入后替换认证通道。
- `reportCabinetTelemetry`：已验证 BLE 手机上报完整柜体门状态快照，并在同一事务中更新 `lockers.doorStatus` 与 `cabinets.lastBleSeenAt`；电池字段暂不接收硬件协议数据。
- `reportOperationEvent`：普通已登录用户按允许的事件类型旁路写入 `operationEvents`；服务端生成用户标识和服务器时间，并过滤取餐码、手机号、token、BLE MAC 等敏感字段。
- `getOperationsAnalytics`：仅 ADMIN/DEVELOPER 调用，按时间范围在服务端聚合存取餐、设备事件、维修工单和客服事件，支持总览、使用情况、设备健康、故障维修、客服五个 Tab，维修明细使用 cursor 加载更多。
- `createStoreUnlockAuthorization`：为首次存餐开柜签发一次性授权；也允许存餐者在成功存入后10分钟内，针对本人仍待取的原记录申请 `STORE_REOPEN` 授权。
- `createDeposit`：首次存餐时创建待取记录；再次存入时复用原待取记录，重新保存手机号后4位并更新最新存入时间，不创建同柜格重复记录。
- `createDeposit`：服务端校验用户输入的4位手机号尾号，并将其作为取餐码原子创建 DepositRecord。
- `verifyPickup`：服务端验证柜体、柜格和取餐码，返回短时开锁授权，不直接完成取餐。
- `completePickup`：收到现场手机通过实体 BLE 查询并确认电子锁反馈 OPEN 的结果后原子完成取餐。
- `submitFeedback`：创建关联用户、柜体及可选柜格的反馈；后台再按用户和时间查询相关业务记录。
- `getOperationLogs`：按 ADMIN/CUSTOMER_SERVICE/DEVELOPER 的细分权限提供查询；客服可用用户 ID、注册编号或柜体限定范围，不要求用户先提交反馈/紧急请求，并可查看必要的存取与开锁业务动作。
- `createCustomerServiceUnlockAuthorization`：客服核验具体 DepositRecord 后，为目标用户签发绑定 userId、cabinetId、lockerId、recordId 的短时一次性凭证；不得接受任意柜格开锁。
- `consumeUnlockAuthorization`：由目标用户小程序在实际 BLE 尝试前原子消费授权，拒绝过期、撤销、重复使用、用户不匹配或柜体不匹配。
- `reportUnlockFailure` / `reportStoreDepositFailure`：记录现场执行失败并在达到阈值后创建维修状态和工单。
- `manageEmergencySupportRequest`：创建、补充、取消或按客服权限推进紧急请求状态机。
- `revokeUnlockAuthorization`：允许目标用户放弃或授权客服撤销尚未使用的授权；维修和记录失效由服务端自动撤销。
- `listMaintenanceWorkOrders`：仅 ADMIN/DEVELOPER 查询活动与历史维修工单。
- `manageMaintenanceWorkOrder`：记录接单、到场、四项检查、机械应急开锁、自检和受控恢复；服务端校验状态迁移和操作者权限。
- `listAnnouncements`：登录用户读取有效公告；仅 ADMIN/DEVELOPER 可以查询草稿和已停用内容。
- `manageAnnouncement`：仅 ADMIN/DEVELOPER 新增、编辑、发布、停用和软删除公告，并同步写入不可由普通用户删除的操作日志。

页面只依赖 `repositories/` 与 `services/` 接口；云端与本地回归实现通过配置切换，不在页面中复制业务状态机。

运营分析的统一事件类型包括 `QR_SCAN`、`BLE_CONNECT_ATTEMPT`、`BLE_CONNECT_SUCCESS`、`BLE_CONNECT_FAILED`、`IDENTIFY_SUCCESS`、`IDENTIFY_FAILED`、`UNLOCK_ATTEMPT`、`UNLOCK_SUCCESS`、`UNLOCK_FAILED`、`DEPOSIT_CREATED`、`PICKUP_COMPLETED`、`MAINTENANCE_CREATED`、`MAINTENANCE_RESOLVED` 和 `CUSTOMER_SERVICE_UNLOCK`。事件写入是旁路操作，失败只记录告警，不影响存餐、取餐或开柜。历史数据不足的指标由统计接口返回空值，页面显示“暂无数据”，不反推成功率。

## 云端安全要求

- 角色、隐私协议版本和业务权限均由云端校验。
- 用户注册编号由 `systemConfig/user-registration-counter` 在事务中分配；客户端提交的账号名或编号一律不可信。
- 取餐码由存餐用户输入手机号后4位，云端只接受4位数字并负责保存、验证；日志不得记录明文取餐码。
- DepositRecord、Feedback、OperationLog 不允许普通客户端直接修改或删除。
- 公告移除照片或软删除公告时，由对应云函数在数据库提交成功后清理本项目云存储目录中的旧文件；客户端不能请求删除任意路径。
- 柜体和柜格只有正常业务状态与维修状态，不再新增软停用状态；历史存取、反馈和审计数据始终保留。
- 维修中的柜体不能获得 BLE 开锁授权；旧二维码不得触发自动连接。
- BLE 开锁授权应短时有效，并绑定 userId、cabinetId、lockerId、recordId。
- 客服只能读取处理问题所必需的数据，不能修改角色、系统安全配置或任意开锁。
- 现场控制器不直接联网。正式链路固定为“客服 → 云端 → 顾客手机 → BLE → 控制器”，不能实现客服跨互联网直控控制器。
- 正式 token 必须由云端安全生成，并采用最终控制器可离线验证的签名/防重放协议；当前 `MOCK_V1` token 不具备密码学安全性。
- 客服请求、授权撤销、故障事件和维修工单均属于云端业务事实；客户端不得自行改状态或删除历史。

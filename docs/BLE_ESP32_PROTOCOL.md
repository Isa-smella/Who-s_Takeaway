# 湖's Takeaway HM-10 / STM32 BLE 协议边界

当前实体原型链路为：当前用户手机 → HM-10 → STM32。手机通过 FFE0 Service / FFE1 Characteristic 建立 Notify，并在 `@IDENTIFY` 返回的柜体 ID 与二维码一致后，才允许发送业务指令。柜体不直接联网，云端业务授权仍由手机完成。

## 当前文本协议

指令以 `\r` 结尾：

```text
@IDENTIFY\r
@OPEN:01\r
@STATUS:01\r
```

STM32 返回：

```text
@IDENTIFY:CABINET_001\r\n
@OPEN:01:OK\r\n
@OPEN:01:FAIL\r\n
@STATUS:01:OPEN\r\n
@STATUS:01:LOCKED\r\n
```

手机将 `@STATUS:xx:OPEN` 映射为 `doorStatus=OPEN`，将 `@STATUS:xx:LOCKED` 映射为 `doorStatus=CLOSED`。当前柜门状态来自电子锁蓝白反馈，不使用独立门磁。

## 业务边界

- `bleLockerService` 负责扫描、连接、FFE0/FFE1、Notify、协议收发和实体柜体身份验证。
- `bluetoothService` 向业务层提供已验证连接状态。
- `doorSensorService` 向存餐、取餐、管理和维修流程提供统一门状态。
- `cabinetTelemetryService` 在连接期间周期查询全部柜格，并由 `reportCabinetTelemetry` 同步 `Locker.doorStatus` 与 `Cabinet.lastBleSeenAt`。
- 当前已连接时的 `@STATUS` 是实时实体状态；云端 `Locker.doorStatus` 是最近一次成功同步的已知状态。

## Mock 与正式发布边界

`BLE_TRANSPORT=MOCK` 的 Mock 传输和调试页继续用于开发回归；`BLE_TRANSPORT=HM10_TEXT` 时，门状态和开锁结果只能来自 HM-10/STM32 的真实协议响应。当前授权载荷仍为开发阶段占位格式，正式发布前需要完成云端签名、STM32 离线验签和防重放设计。

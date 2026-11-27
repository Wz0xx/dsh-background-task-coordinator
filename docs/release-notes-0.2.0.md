DSH 后台任务协调器 0.2.0——把 0.1.8 到 0.1.10 一路攒下的七条审计遗留全部收完，另修一个做测试时撞出来的真 bug。

## 最要紧的四条

**8 处 `LIMIT 500` 全表截断。** 以前核心查询都是拉前 500 条再内存过滤，任务累积超 500 条后，活动任务会掉出窗口——结算事件到了也匹配不上，**永久丢弃**，不计限额、不显示在列表、永不超时。而且 `ORDER BY priority ASC` 让优先级小的历史任务永远排前面，挤出去更快。现在全部改成走索引的定向查询，并补了 `native_session_id` 索引。

**`purgeHistoryOlderThan()` 定义了从没被调用。** 台账与幂等表只增不减，必然撞上一条。现在接进维护循环，默认保留 30 天（`config.retentionDays`，设 0 关闭），幂等表一起清。

**幂等键是全表 `UNIQUE` 而非 `(task_id, key)`。** 任务 A 用 `"step-2"` 投过，任务 B 再用同一个键：消息**真的投给了子代理**，但写库撞全表 UNIQUE、异常被吞掉返回 false、调用方没检查——结果 agent 收到了，台账里 0 条记录，审计和幂等同时失灵。用 meta 版本机制重建表改成联合唯一。本机真实旧库（含 2.1 MB WAL）迁移验证：29 任务 / 53 事件 / 5 消息全保留。

**GBK 三重乱码。** 以前首个 chunk 试解一次就永久锁定编码，而 Windows 命令的第一段常常是纯 ASCII，UTF-8 当然通过 → 锁成 utf8 → 之后所有中文全乱码。改成单流持久 `TextDecoder` + `{stream:true}`，纯 ASCII 不锁定，`end()` 在收尾时冲掉不完整序列。

## 其余四条

- **`pending` 消息不 flush**：绑定前排队的指令永久卡死，重发还被内容哈希幂等挡住。现在绑定后真补投；幂等判据改成按状态，只有 `delivered`/`cancelled` 挡重试。
- **多 profile 共享单库**：开第二个 profile 时它的启动对账查不到第一个 profile 内存里的 job/agent，会把正在跑的任务全标 `lost`。现在按 profile 隔离路径（`DSH_PROFILE_DIR` → `DSH_PROFILE` → `default`），加 `PRAGMA busy_timeout=5000`。**旧库不自动搬**，要留数据得手动 copy（连同 `-wal`/`-shm`）。
- **`dispose()` 不关 `_sqlite`**：重载累积连接、`-wal` 永不 checkpoint、Windows 上库文件还被锁住。现在关库前先 `wal_checkpoint(TRUNCATE)`。
- **`stopReason` 空串落 `failed`**：0.1.7 的白名单听着严谨，但宿主根本不发那些词——本机 asar 里 `SubagentStopReasonMap` 是 `completed / aborted / error / max-tokens / refusal`。于是空 `stopReason` 被编造成失败。现在按真实枚举映射，空串/未知词落 `succeeded` 但注明「stopReason 未给出」。

## 新发现：`cmd /s /c` 把引号拼成字面量

做 GBK 测试时撞出来的，不属于原七条，但比其中几条更容易坑住人：

```
objective: node "C:\某目录\脚本.js"
→ Error: Cannot find module 'C:\...\"C:\某目录\脚本.js"'
```

插件用 `cmd.exe /d /s /c <objective>` 执行，Node 的 `spawn` 默认按 CreateProcess 规则加引号转义，`cmd /s` 又剥一层，两头一夹引号变字面量。**任何带引号、带空格的命令都会中招。** 修法是 `windowsVerbatimArguments: true`。

## 配置现在真的生效

`apply(ctx)` 以前只收一个参数，`cordis.patch.yml` 里 `config:` 写什么都不进来（以前是空对象所以看不出来）。现在三层覆盖：内置默认 → yml config → `DSH_COORD_LIMITS`。垃圾值一律退回默认——`setInterval(NaN)` 会退化成 1ms 死循环，比不设还糟。

```yaml
config:
  retentionDays: 30     # 终态任务保留天数，0 = 不清
  timeoutMinutes: 120   # 单任务超时
  sweepSeconds: 300     # 维护循环间隔
```

## 测试

三套 66 项全绿：

```
主回归      16/16
下游补丁     8/8
0.2.0 专项  45/45
```

几条是专门设计成「能反驳自己」的——比如断言旧 `listTasks({limit:500})` 写法在 601 条台账下**确实漏掉活动任务**，用来证明修的是真 bug 而不是想象出来的。

测试本身也修了一处假绿：原来写死 `file:///C:/Users/stop/...` 绝对路径，在别处跑其实加载的还是本机代码。改成相对导入后，在远端 clone 里重跑才是真的 66/66。

## 装

下载 `dsh-background-task-coordinator-0.2.0.zip` 或 `.tgz`，按 README 第三节装。硬前提仍然是组合里有 `@deepseek-ai/dsh-tool-jobs`。

**从 0.1.x 升级注意**：库路径改成按 profile 隔离了。旧库不会自动迁移，要保留历史任务请把 `tasks.db`、`tasks.db-wal`、`tasks.db-shm` 三个文件一起拷到 `~/.dsh/background-task-coordinator/<profile>/`。只拷 `tasks.db` 会得到一个空库——真实数据在 WAL 里。

逐条细节见 `docs/0.2.0改动记录-20261127.md`。

## 补记：0.1.5 – 0.1.10

这几版之前只推了代码没发 Release，一并说明：

- **0.1.5** — 修 `subagent/end` 只比 `nativeId` 漏 `nativeSessionId`（事件到了认不出）、`register_delegation` 把 agent 名当 session id、三处 `ctx.agents.get` 按名字查。新增 `compat/subagents-adapter.js` 做双路反查（0.2.2 用 `resolveName`，0.2.1 用 `listChildren` 按 label）。
- **0.1.6** — 抽 `toTaskHandle` 统一入口（三处手拼字段漏 `nativeSessionId`）；自检恒 `degraded` 改成 OR 组整体判定；`describe` 与 `list` 都走 `sweepOnce`。
- **0.1.7** — issue #1 四条：`describe` 会写 `lost` 终态不可逆 → 改只读；`deadlineAt` 假修复（读不存在的列）→ 改从 labels 取；caller 依赖 `exec.agent`；超时对 subagent 是死路。
- **0.1.8** — 深度审计三条 P0：沙箱 100% 绕过（算出 `wrapped` 却 spawn `parts`，四个分支全 fail-open）、僵尸任务（`nativeSessionId` 为空恒判存活）、七工具零归属校验还拿库里的 owner 冒充 caller。
- **0.1.9** — cwd 缺陷：cordis 4.x 对未 inject 的服务取属性就抛，`ctx.workingDirectory?.ensure?.()` 的 `?.` 救不了，catch 吞掉后 cwd 恒 null、job 一律拒建。全部改 `ctx.get` 查询式，并把 `tests/mockctx.mjs` 做成刻意复刻 cordis 语义。
- **0.1.10** — 收编下游四处补丁：限额默认 3/2 改 5/4；`exec.agent` 为空时四级 cwd 兜底；区分「服务不存在」与「真被沙箱拒绝」；`cancel` 探活只对真 session id 做。

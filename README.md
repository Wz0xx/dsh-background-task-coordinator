# DSH 后台任务协调器

给 DSH（DeepSeek Harness）加一层任务台账：**长活扔后台跑，前台照常聊天。**

> **装前必读**：本插件会通过 `ctx.systemPrompt.section` **往系统提示里插入一段**（约 15 行，内容是「什么时候该把活扔后台」）——它不是纯工具插件，装上后宿主 agent 的行为会变（长命令默认进后台）。不接受的话别装。

---

## 一、它解决什么

DSH 本身就能起后台作业和子代理。但没有一个统一的账本——起了三件事，过半小时还记得每件在哪一步、跑完没有、中途改过什么要求吗？

这个插件补的就是这一层：

- **建任务**，绑到原生执行单元上，状态跟原生对齐（不自己编）
- **一个地方查**：阶段、进度、结果摘要
- **中途改要求**：追加指令真能送到，送不到就如实说送不到
- **结束/失败有通知**：不用盯着查
- **重启不撒谎**：原生执行单元没了的任务标 `lost`，绝不虚报 running
- **真并行**：多个任务同时跑，不是排队

---

## 二、装之前，先确认一件事

**`@deepseek-ai/dsh-tool-jobs` 必须在你的组合里。这是硬前提。**

没有它，插件照样能装、工具照样注册出来，但一建后台作业就报：

```
background jobs unavailable: no job controller serves this agent
(load @deepseek-ai/dsh-tool-jobs in its composition)
```

**怎么确认**：打开 `<DSH_HOME>/profiles/<你的 profile>/cordis.patch.yml`，搜 `tool-jobs`。没有就补：

```yaml
- insert:
    - id: tool-jobs
      name: '@deepseek-ai/dsh-tool-jobs'
```

**别认错名字**：`dsh-tool-jobs`（模型工具层）和 `dsh-jobs-local`（真正起子进程的注册表）是两层东西。这条报错只提前者，但两者缺哪个都会挂。`dsh-jobs-local` 通常已经在宿主里，重复 insert 会报 `service "jobs" has been registered`。

---

## 三、安装

### 方式一：tgz / zip（推荐，干净）

1. 把 `dsh-background-task-coordinator-<版本>.tgz`（或同名 `.zip`，内容一致）放到任意目录。
2. 找到两个路径：
   - DSH 自带的 pnpm：`<DSH 安装目录>\resources\runtime\x64\primary-runtime\dependencies\pnpm\bin\pnpm.mjs`
   - 你的 profile：`<DSH_HOME>\profiles\<profile 名>`
3. 在 profile 目录下执行：

   ```powershell
   node "<pnpm.mjs 路径>" add "<tgz 路径>" --ignore-scripts
   ```

4. **把插件挂进组合。** 这一步别漏——用 pnpm 直接装**不会**自动合并包里的 patch。zip 包的话先解压出 `package/cordis.patch.yml` 看一眼。打开 profile 的 `cordis.patch.yml`，在**末尾**加：

   ```yaml
   - insert:
       - id: background-task-coordinator
         name: dsh-background-task-coordinator
   ```

   > 如果是用 DSH 自带的插件管理器（`plugin_manager install_bundle`）装的，它会读包里的 `dsh.bundle.patch` 自动合并，这一步可以跳过。

5. **完全退出 DSH**（窗口关掉，托盘图标也右键退出），再打开。

### 方式二：目录链接（想自己改代码时用）

1. 把整个目录解压到比如 `C:\dsh-plugins\background-task-coordinator`。
2. 打开 profile 的 `package.json`，在 `dependencies` 里加一行：

   ```json
   "dsh-background-task-coordinator": "link:C:/dsh-plugins/background-task-coordinator"
   ```

   注意用正斜杠。

3. 在 profile 目录下执行：

   ```powershell
   node "<pnpm.mjs 路径>" install --ignore-scripts
   ```

4. 完全退出 DSH，再打开。

---

## 四、怎么确认装上了

**看日志**（`<DSH_HOME>\logs\desktop-next.log`），应该有这几行：

```
[task-coordinator] 后台作业：可用
[task-coordinator] 系统提示已加一段（order=1600）
[task-coordinator] 已注册 8 个工具（7 任务 + task_probe 诊断），数据目录 C:\Users\<你>\.dsh\background-task-coordinator\<profile>
```

第一行是启动自检（0.1.1 起有）：启动时先探 `ctx.jobs.start` 在不在。看到「后台作业：不可用——ctx.jobs.start 不存在」就是第二节那个硬前提没满足，先去补 `dsh-tool-jobs`，别的都不用查。

**或者直接问**：开一条新会话，说「task_list」。返回一个空列表就是装好了。

**看系统提示**：随便说句话，如果模型开始主动把长命令扔后台、不再问你「要不要后台」，说明提示词那段生效了。

---

## 五、怎么用

装好之后**不用记工具名**——系统提示里已经写清了什么时候该用。正常说话就行：

| 你说 | 它做 |
|---|---|
| 「这个构建跑一下」 | 直接建后台任务，不让你等 |
| 「刚才那个跑到哪了」 | 查台账，报阶段和进度 |
| 「别跑那个了，改成测这一条」 | 追加指令：子代理能收到；后台命令收不到会如实说 |
| 「全部停掉」 | 取消，按进程树杀，不留残余 |

### 八个工具（7 任务 + 1 诊断）

| 工具 | 干什么 |
|---|---|
| `task_create` | 建任务。`type=job` 是命令，`type=subagent` 是子代理 |
| `task_list` | 看有哪些在跑 |
| `task_describe` | 看某一个的阶段、进度、结果摘要 |
| `task_register_delegation` | 把原生 `subagent` 建出来的子代理绑进台账 |
| `task_append_message` | 追加指令（`next-turn` / `next-step`） |
| `task_cancel` | 取消 |
| `task_context` | 任务级共享上下文：阶段、决策、改动过的文件、待办 |
| `task_probe` | 诊断：列出宿主 jobs/agents 服务的方法面，排查环境用 |

### 一条重要约定

`type=job` 建出来的任务**收不到追加指令**。后台命令没有 stdin 写端，插件会如实返回 `undeliverable` 并记进台账，不会假装投递成功。要能改要求的，用 `type=subagent`。

---

## 六、已知限制

1. **重启 DSH 后，正在跑的 job 会丢。** `dsh-jobs-local` 是纯内存的，宿主一死作业就没了。台账会把它标成 `lost`——不假装还在跑，但任务本身要重起。
2. **不自动劫持命令。** 插件只在系统提示里写了「默认扔后台」的判据，决定权在模型手里。不做「看到 `npm test` 就偷偷改成后台」——技术上只能取消+重建，模型会拿不到结果、以为命令失败了，那比不做更糟。
3. **Windows 主要路径实测过。** GBK 解码、`taskkill /T` 这些都有平台分支，Linux / macOS 没测。
4. **数据是一个 SQLite 库**：`~/.dsh/background-task-coordinator/<profile>/tasks.db`（WAL 模式）。可以直接看（`node:sqlite` 或任意 sqlite3 客户端）、直接删——删了下次启动重建空账，不影响 DSH。

   **0.2.0 起按 profile 隔离，0.2.4 合入 `config.profile` 支持并防同名 profile 串库。** 优先级：① `cordis.patch.yml` 中的 `config.profile` / `config.profileName`（解决部分机器 host 子进程读不到 `DSH_PROFILE*` 环境变量的问题）→ ② `DSH_PROFILE_DIR`（位于默认 `~/.dsh/profiles/<name>` 下沿用 `<name>`；来自不同根目录、自定义 `DSH_HOME` 或清洗截断后的名字自动附带 8 位 SHA-256 路径指纹 `<name>-<hash>`）→ ③ `DSH_PROFILE` / `DSH_PROFILE_NAME` → ④ `default`。启动时会打印 `台账目录：...（来源：...）`，POSIX 下目录自动收紧为 `0700`、库文件为 `0600`。

   **落盘脱敏与旧 JSON 清理（0.2.4）**：写进 SQLite 的命令目标、已落盘追加指令、上下文与事件流水会自动对常见内联凭据（`KEY=`/`TOKEN=`/`PASSWORD=`、`Bearer`、`sk-`/`ghp_`/`AKIA`、`--token`、URL 密码）脱敏（不影响实际运行参数）；旧版 `tasks.json` 迁入并 checkpoint 落盘后直接删除源文件，并清理历史遗留的 `tasks.json.migrated` 明文副本。

5. **限额与超时可配**，三层来源，后者盖前者：内置默认 → `cordis.patch.yml` 的 `config` → 环境变量 `DSH_COORD_LIMITS`（JSON）。

   ```yaml
   config:
     retentionDays: 30     # 终态任务完成超过几天就删（连事件/消息/幂等账），0 = 不清
     timeoutMinutes: 120   # 单个任务超时分钟数
     sweepSeconds: 300     # 维护循环间隔
   ```

   超限额的建任务请求被明确拒绝（不绕过）；过 deadline 的活动任务先请求取消，等执行器确认后落终态。配置里写了垃圾值（字符串、空、对象）一律退回默认，不会让定时器退化成死循环。

6. **台账会自动清理**。0.2.0 之前 `purgeHistoryOlderThan()` 定义了却从没被调用，台账只增不减——到 500 条之后，结算事件会开始永久丢失。现在维护循环每轮顺带清一次，保留天数见上。

---

## 七、卸载

1. profile 的 `package.json` 里删掉 `dsh-background-task-coordinator` 那一行
2. 如果 `cordis.patch.yml` 里有对应的 insert，删掉
3. 删 `~/.dsh/background-task-coordinator/`
4. 重启 DSH

什么都没留在 DSH 核心里。

---

## 八、验收情况

**12 项全部通过**，证据在 `docs/验收结果-20261124.md`。0.1.2 又过了一轮（V1.1 任务书全量对齐，变更记录见 `docs/V1.1-进行中.md`），0.1.3/0.1.4 又修了 0.2.2 适配与沙箱对齐（见同文档 11-26 追记）：

- 状态机重写：`cancel_requested` 与 `cancelled` 分离，`succeeded/failed/cancelled/lost` 四终态
- 两个 `ping -n 25` 任务各跑 24 秒、时间**完全重叠**——真并行，不是排队
- 子代理跑到一半追加指令，它在最终回复里原样带上了那段内容，`turn/end: completed`
- 取消后进程树无残留
- 30 分钟连续跑，1800 个包一个不丢
- 重启回收：失联任务标 `lost`，并把终态通知投回发起会话（0.2.2 起真投；以前只记账不投，那句话是假的）

**接口契约核验 15 项全部 VERIFIED**，在 `docs/接口核验表.md`。那份表里还记了两个「看着像问题其实不是」的坑：

- `ctx.jobs 探测：[{"key":"jobs","methods":[]}]`——`methods` 是空的但 `jobs.start()` 调得通。这个服务是受控代理，反射拿不到方法名。**别拿 `methods: []` 判断「服务没挂」。**
- `followup` / `steer` 收的是**消息对象**不是字符串。传裸字符串会抛 `Cannot read properties of undefined (reading 'kind')`，把子代理整轮打成 error。

---

## 八点五、启动自检与能力检测

启动时打一行 `compat:`，列出本机每项能力的三态（`supported` / `unsupported`），拿不到就是 `unsupported`，不猜：

```
[task-coordinator] compat: {"overallStatus":"degraded","caps":{
  "job.start":"supported","job.inspect":"supported","job.cancel":"supported",
  "agent.get":"supported","subagent.resolve_name":"unsupported",
  "subagent.list_children":"supported", ...}}
```

**`subagent.resolve_name`** 在 0.2.1-rc.4 上是 `unsupported`（该版本的 asar 里没有 `resolveName`，只有 `listChildren`）。插件按双路降级：

| 宿主版本 | 名字→会话 id 怎么解析 |
|---|---|
| 0.2.2+ | `ctx.subagents.resolveName(caller, name)` |
| 0.2.1 | `ctx.subagents.listChildren(parentSessionId)` → 按 `label` 匹配 |

两条都拿不到时，`nativeSessionId` 留 `null`（**绝不把 agent 名字当会话 id 落库**），`task_register_delegation` 的返回文本会明说「结算靠兜底」；这种任务的终态改由 `task_list` 探活兜底落 `lost`。

---

## 九、兼容性

- **DSH 0.2.1-rc.4：全链路实测**（docs/A01-A14验收报告-20261125.md：建 job / 建并绑定 subagent / 查状态 / 读输出 / 取消 / 追加指令 / 限额 / 截断 / 重启对账，14 项）
- **DSH 0.2.2-rc3：适配**（0.1.3 起）。0.2.2 收紧了 job 注册表的 owner 校验（`start(spec)` 强制解析 `spec.owner` 的活 agent，且有主 job 的 kill/readAt/get 按 owner 围栏）——0.1.3 起插件按真实会话 id 传 owner 并全程带 caller。0.1.2 及更早版本在 0.2.2 上 `type=job` 会报 `no job controller serves this agent`。
- Node ≥ 22.16（`node:sqlite` 需要）
- 零核心改动，纯插件层

---

## 九点五、0.2.0 改了什么

七条收尾 + 一个做测试时撞出来的真 bug，逐条见 `docs/0.2.0改动记录-20261127.md`。挑最要紧的说：

| 问题 | 后果 | 现状 |
|---|---|---|
| 8 处 `LIMIT 500` 全表截断 | 任务超 500 条后，**结算事件永久丢失** | 全改定向查询，补 `native_session_id` 索引 |
| `purgeHistoryOlderThan` 从没被调用 | 台账只增不减，必然撞上面那条 | 接进维护循环，幂等表一起清 |
| 幂等键是全表 `UNIQUE` | 跨任务用同一显式键 → 消息投出去了但库里没记录 | 重建表，改 `(task_id, key)` 联合唯一（带 meta 版本迁移） |
| `pending` 消息不 flush | 绑定前排队的指令永久卡死，且重发被幂等挡住 | 绑定后真补投；非 `delivered` 不再锁死重试 |
| GBK 首次判编码就锁定 | 先吐 ASCII 再吐中文 → 全程乱码 | 改单流持久化解码器 + `end()` 收尾 |
| 多 profile 共用一个库 | 开第二个 profile 会把第一个的任务全标 `lost` | 按 profile 隔离路径；加 `busy_timeout` |
| `dispose()` 不关 `_sqlite` | 重载累积连接、`-wal` 永不 checkpoint | 关库 + `wal_checkpoint(TRUNCATE)` |
| `stopReason` 空串落 `failed` | 假失败（和以前假成功一样糟） | 按宿主真实枚举映射，空串落 `succeeded` 但注明「未给出原因」 |
| **`cmd /s /c` 把引号拼成字面量**（新发现） | 任何带引号/带空格的命令都报 `Cannot find module '..."..."'` | `spawn` 加 `windowsVerbatimArguments`（仅 danger-full-access 分支） |

测试三套，**150 项全绿**（0.2.4 起）：

```
主回归      16/16
下游补丁     9/9
专项      125/125
```

其中几条是专门设计成「能反驳自己」的——比如断言旧 `listTasks({limit:500})` 写法在 601 条台账下**确实漏掉活动任务**，用来证明修的是真 bug。迁移那条用本机真实旧库（含 2.1 MB WAL）跑过：29 任务 / 53 事件 / 5 消息全保留。

## 九点六、0.2.1 改了什么

0.2.0 发布后收到一份逐行核验报告（带行号和复现方法），核出**我在修的过程中新引入的 7 处退化**。全部核实属实，这一版逐条修掉：

| 问题 | 后果 | 现状 |
|---|---|---|
| `task_register_delegation` 漏 `ownedBy` | 任何会话知道 taskId 就能劫持别人的任务，并借 pending 补投**把别人排队的指令刷给自己** | 补上归属校验 |
| `task_describe` 仍用台账 owner 当 caller | 冒充 owner 读别人的 job 输出，穿透 assertAccess 围栏 | 改用真实调用者 |
| `task_cancel` 对未绑定 queued 之代理 | 分支顺序错，取消后卡在 `cancel_requested` 永不落地 | 从未绑定直接落 cancelled |
| `getAgentHandle` 抛错后 3 处没接 | 一条子代理查询异常就把 `task_list` / `task_append_message` 打崩 | 全部接住，探活失败不当成「已死」 |
| 迁移丢外键与 CHECK | 重建后的表比迁移前更松：孤儿消息、非法 status 都能写进去 | 保留约束；判据改成看表结构而不只看版本号 |
| `windowsVerbatimArguments` 无条件开 | 沙箱包装器里 `C:\Program Files\...` 这类路径被劈成多个参数 | 只对 danger-full-access 分支开 |
| `resolveSubagentSessionId` 漏 `caller.id` + 盲信 `given` | 空态兜底造出的 caller 反查必败；模型乱填的字符串被当成会话 id 落库 | 补 `caller.id`；`given` 先做「像不像 id」判断 |

另外清掉：`lib/storage/{task-store,event-store}.js`（引用了已删除的 `lib/core`，导入即 `ERR_MODULE_NOT_FOUND`，还一直随包发布）、`currentStage` 停在 `creating-executor`、`task_probe` 直取未 inject 服务、pending 正文被截到 500 字（补投时等于把指令砍半投出去）。

`config` 现在真的管住 `task_create` —— 0.2.0 里它只对维护循环生效，限额仍读环境变量那一套（实测传 `{global:1}` 仍能建第 2 个、`deadlineMinutes` 仍落 120）。

**一处取舍要说明**：核验报告建议对 `given` 严格校验，我一开始写成「必须是 UUID」，结果把 `sess-F1` 这种合法短 id 也打断了，补投直接失效——这是测试逼出来的。现在只排除明显是话不是 id 的（空、含空格、纯中文、超短），其余接受但算「未核实」。

---

## 九点七、0.2.2 改了什么

0.2.1 之后把核验报告剩下的「未修 / 半修」九条全部处理掉：

| 问题 | 后果 | 现状 |
|---|---|---|
| `execSync('taskkill …')` | **同步阻塞宿主事件循环**，杀大进程树能卡住几百毫秒 | 改异步 spawn + unref |
| 首行为空的 objective 未拦 | spawn 一条空命令，落 failed 而模型以为在跑 | 建任务前拦下 |
| `sweepOnce` 单次 miss 就判死 | **一次探活抖动就把在跑的任务打死，`lost` 不可逆** | 连续两轮才认，查回来就清零 |
| Mode B 秒结竞态 | 事件比绑定先到就被丢弃 → 短任务永远停在 running | 缓存并回放，走同一套结算映射 |
| 失联 job 无运行期恢复 | 结算事件缺失时永远 running，永不超时 | 新增 `sweepJobsOnce`，挂 task_list + 维护循环 |
| `task_context` 无 `expectedVersion` | 两个代理各自读写，后者静默覆盖前者 | 暴露版本参数，冲突直接拒 |
| `settleNotification` 只记账 | `lost` 这类自产终态前台收不到 | 真投到发起会话（幂等、只投自产的） |
| 死代码 | `loadTasks`/`saveTasks`/`withTask`/`SCHEMA`/`spawnError` | 全删 |

顺带删了一句假日志：`ctx.jobs.onSettled 不存在——走 readOutput 兜底`。**根本没有那个兜底**，`readAt` 只读不写账。

### 关于通知这件事

宿主的服务表里**没有**通用「发通知」服务（inspect 全表查过）。但 `agents.get(sessionId)` 能拿到发起会话的活 agent，上面有 `followup`，和 `task_append_message` 同一条通道。所以通知 = 往 owner 会话投一条摘要消息。

只在**协调器自产、前台本来收不到**的终态上投（探活 lost / 重启对账 / 超时清账）。原生 job/subagent 结束本来就会回到前台，再投一条是噪音。

### 一个反直觉的细节

`windowsVerbatimArguments` 这个选项在不同上下文里答案相反：

- 我们自己拼 `cmd /d /s /c <原文>` → **必须** true（否则引号变字面量）
- 独立 argv 调 `taskkill` → **必须** false（否则路径被劈开）

不能一刀切，按 argv 的来源决定。

## 九点八、0.2.3 改了什么

这一版的来源不同：不是我找的问题，是一份别人写的 0.2.1 补丁（Gemini 生成，1900 行）。逐段对比自己的实现后**采纳了七条它比我做得好的**：

| 问题 | 我原来的状态 | 现状 |
|---|---|---|
| GBK 积压时纯 ASCII 旁路 pending | 跨包汉字被劈开 + 乱序（实测出 `"@\n�"`） | 只在无积压时才走快路 |
| `end()` 对残留字节硬走 UTF-8 | 短 GBK 出 `"A��"` | 严格试一次，过不了走 gbk |
| `given` 放行 `current` 这类占位词 | 能过长度检查，`current` 又是默认值 | 显式排除 |
| 父会话 id 被当子会话 id | 该任务永远匹配不上 `subagent/end` | 排除自指 |
| `sweepOnce` 跨会话写别人台账 | A 调 `task_list` 能把 B 的任务标 lost | 传 caller 做归属隔离 |
| `listRecent` 没按 caller 过滤 | 别的会话新建 50 条挤空当前视图 | 传 caller |
| `cancel` 传 `keepInbox: true` | 那是「暂停」语义，队列留着还能被唤醒 | 改 `false`，并兜底 `interruptByParent` |
| 二次登记不拦 | 换 agent 等于把任务绑到别处，原来那个还在跑 | 拒绝换目标（允许补全 session id） |
| 启动对账探活抛错判 lost | 「没问成」被当成「问到了没人」 | 单独接，暂不判断 |
| `sandboxed.env` 未透传 | 只吃 argv 不吃 env = 半套隔离 | 宿主 env 作底、沙箱覆盖 |

前两条是**先复现再修**的：把 0.2.2 的旧解码器单独抄出来跑，确认两个用例都乱码，改完再验。

### 没采纳的

- `settleNotification` 仍只记账 —— 我 0.2.2 已改成真投递，比它进一步
- 没有 `sweepJobsOnce` —— 我 0.2.2 新增的 job 探活它没有
- 把 `db()`/`emitEvent` 等模块级函数全挪进 `apply` —— 思路对（解决热重载互相覆写），但改动 300+ 行、风险集中，记进待办单独做

## 九点九、0.2.4 改了什么

对 0.2.3 做完逐条实测复核后，把最后一批代码级漏洞和边缘回退一次收干净，逐条见 `docs/0.2.4改动记录-20261128.md`：

| 问题 | 0.2.3 的状态 | 现状 |
|---|---|---|
| 原生 `jobs.events` 结算重复通知 | 误传 `selfProduced: true`，每个 job 结束都给发起会话重发一条 `followup` | 去掉 `selfProduced: true`，与 `subagent/end` 和通知设计对齐 |
| `sweepJobsOnce` 跨会话 + 异常计 miss | `task_list` 调 job 探活没传 `caller`，且 `jobs.get` 抛瞬时异常也会累加 `missStreak` 误杀成 `lost` | 传 `caller` 做归属隔离；查询抛错仅记日志跳过，不计 miss |
| `earlyEnds` 回放后仍补投 `pending` | 早到结算已把任务落终态，仍调 `ag.followup` 唤醒已结束子代理；且早到缓存丢弃 `status/reason/outcome` 且无容量上限 | 回放落终态后取消待补投消息（标 `cancelled`，不唤醒子代理）；保留四字段兜底并封顶 200 条 |
| `task_cancel` 兜底 `interruptByParent` 传 `undefined` | 读的是 `t.ownerSessionId`，但 `toTaskHandle(row)` 没有这个字段 | 改为 `own.caller ?? row.ownerSessionId ?? undefined` |
| `task_list` 首次未命中提示是死代码 | 只在 `rows.length === 0` 分支拼接 `suspectNote`，有活动任务时永远看不到 | 非空列表顶部同样带出 `suspectNote` |
| 空 `exec.agent` 仍冒充 `own.owner` | `task_describe` 与 `task_cancel` 的 `jobs.kill` 回退到 `own.owner`，违背 `ownedBy`「不冒充 caller」约定 | 均改为 `own.caller ?? undefined` |
| 超时清账漏掉无 `sessionId` 的 `subagent` | `task_cancel` 把绑定但无 `nativeSessionId` 的任务留在 `cancel_requested` 等超时收尾，但 `sweepTimer` 没处理这类任务 | `sweepTimer` 对超时的未绑定或 `cancel_requested` 无会话 id 子代理落 `lost` 并通知 |
| `dispose()` 遗留悬挂引用 | 顶部注释写明卸载清 `ACTIVE_CTX`，但 `dispose()` 漏清 `ACTIVE_CTX` / `_log` / 内存缓存 | 卸载时按实例比对清理 `ACTIVE_CTX`、`_log`、`missStreak`、`earlyEnds` |
| `tests/v020.mjs:173` 硬编码本机路径 | 写死 `C:/Users/stop/...`，换机跑 `npm test` 直接 `ENOENT` | 改为相对模块路径 `new URL('../index.js', import.meta.url)` |
| 后台命令继承宿主凭据 + Windows 首尾引号断词 | `spawn` 透传 `sandboxed.env` 仍铺在完整 `process.env` 上；Windows `cmd.exe /d /s /c` 遇到首字符为 `"` 的命令（如 `"C:\Program Files\...\node.exe" ...`）会被 `/s` 剥掉首尾引号 | 对齐 DSH `scrubbedParentEnv()` 过滤凭据与 `DSH_*` 后再叠加 `sandboxed.env`；`win32` `danger-full-access` 分支外层统一多包一对 `"` 让 `/s` 剥离 |
| 首次绑定未验证子代理父子归属 | 共享 profile 下会话 B 可首次将别人的子代理 `sessionId` 绑到自己任务上，继而跨会话发指令或取消 | 新增 `resolveSubagentBinding()`（无 `subagents` 服务时不误拒；有服务时结合子树 / `resolveName` / 正向确权父会话元数据核验），并辅以 SQLite 跨会话唯一校验 |
| `jobs.kill` 忽略回执过早报「已取消」 | DSH 的 `jobs.kill()` 可仅返回 `'requested'`（进程仍在 `stopping`），插件直接写 `cancelled` 并告知用户「已取消」 | 消费 `jobs.kill` 回执并复核 `jobs.get` / 同步 settled：`'requested'` 或原生仍运行/停止中时落 `cancel_requested`，等原生终态确认 |
| `config.profile` 支持 + 同名 profile 串库 + 明文留存 + `.migrated` 副本 | host 子进程拿不到 env 时退回 `default/`；`dataDir()` 仅取 basename；命令/追加指令明文入库；旧 `tasks.json` 迁移后留 `.migrated` 副本 | 优先级 `config.profile` → `DSH_PROFILE_DIR`（非默认根目录加 8 位路径指纹）→ `DSH_PROFILE` → `default` 并打来源日志；SQLite 落盘脱敏且 POSIX `0700`/`0600`；迁移 checkpoint 后删源并清遗留 `.migrated` |

顺带收尾：`toTaskHandle()` 补齐 `ownerSessionId`、`task_create` 识别仅有 `exec.agent.session.id` 的宿主、`task_describe`/`task_append_message` 在 `nativeSessionId` 为空时不再拿 agent 名字碰按 session id 索引的注册表、`task_context` 拒绝浮点 `expectedVersion`（如 `1.5`）。

## 九点十、0.2.10 改了什么（装机反馈两个真 bug）

第三方在 DSH **0.2.2-rc.5** 上实测 0.2.8，报了四个问题：两个真 bug（都已复现并修）、两个环境/使用注意（写进下面两节）。逐条见 `docs/0.2.10改动记录-20261128.md`。

| 问题 | 现象 | 修法 |
|---|---|---|
| **沙箱分支引号退化** | `echo "a b"` 输出 `\"a b\"`；`powershell -Command "..."` 只回显不执行 | 命令本体改走环境变量 `COORD_JOB_CMD`，命令行上只留 `%COORD_JOB_CMD%` 占位符 —— `verbatim=false` 仍保护带空格路径，引号问题从根上消失 |
| **job 取消落 failed** | `task_cancel` 之后台账是 `failed / exit 1`，不是 `cancelled` | 两层：producer 端在 `cancel()` 后把 close 结果报成 `killed`（源头给正确事实）；settled 映射补 A07 会合规则（`cancel_requested` → `cancelled`），与 subagent 侧对齐 |

关于第二条的实测细节：`taskkill /T /F` 杀掉 `cmd.exe` 时，`close` 给的是 **`code=1`、`signal=null`**，不是 `killed` —— 所以 producer 报 `exit 1`，宿主原样采纳。退出码仍然保留在 `errorSummary` 里，事实没丢，只是状态归「取消」。

### 测试要在**无沙箱**的普通终端里跑

在 DSH 自己的 `workspace-write` 会话里跑 `tests/regression.mjs`，A1 可能因 `spawn EPERM` 假失败：受限 token 下 `spawn(..., { windowsHide: true })`（CREATE_NO_WINDOW）会被拒，mock 里那条 `run()` 直接同步抛错。**不是代码问题。**

> 说明：这条由报告作者在他那台机器上实测，**本机（`danger-full-access` 会话）没能复现** —— A1 直接通过。按建议写在这里，遇到就用普通终端跑。

### 旧台账不会自动迁移

0.1.x–0.2.3 的 `<homedir>/.dsh/background-task-coordinator/tasks.db` **不会被新版读取**。新版读的是：

```
<profile>/tasks.db              ← 标准 home
<profile>-<hash8>/tasks.db      ← 非默认 DSH_HOME，防同名 profile 串库
```

所以升级后历史看起来「突然空了」，但**不报错**。想保留就手动搬那个文件过去；不搬也不影响新任务。

**没有做自动迁移**：自动搬动别人的数据文件风险大于收益，「空着不报错」比「搬错了才发现」好收拾。

## 九点十一、0.2.11 改了什么（收编两个补丁 + 更正自己的核查）

来源是第三方实测报告新增的第七节，以及一份针对本插件《子代理清理核查》的反批评。逐条见 `docs/0.2.11改动记录-20261128.md`。

| 补丁 | 做什么 | 解决什么 |
|---|---|---|
| **C. 订阅 `agent/disposed`** | 插件级 `ctx.on('agent/disposed')`，按 `agent.id`（= SessionId）找活动任务 | 子代理被外部销毁（父会话关闭/归档/drain）时台账一直 `running` 占配额。`cancel_requested` → `cancelled`，其余 → `lost` |
| **D. 超时补真取消** | 超时分支对**还活着**的 subagent 调 `ag.cancel({kind:'user'}, {keepInbox:false})` | 以前只探活不动手，等一个可能永远不来的 `subagent/end`，任务卡在 `cancel_requested`（issue #1 A4） |

### 为什么补丁 D 必须 `keepInbox: false`

这条是死锁与否的分界。`cancel` 在 `keepInbox: false` 时无条件 `inbox.clear()`，而清空收件箱会发 `agent/inbox/discarded` 事件——`dsh-subagent` 订阅了它（`subagent:1862`），收到就 `wake(activation)` → `poke.resolve()` → 结算观察者重算 → 判 `ready` → 发 `subagent/end`。

用 `true`（`interruptByParent` 走的就是这条）就退回「等 poke」的死等。

六环链条可用 `tests/manual/poke-chain.mjs` 自己复核。

### 生效的前提：插件级 `ctx.on` 跨 scope 收得到

`agent/disposed` 的契约写着 scope-filtered。`dsh-scope:332` 是 `if (tag === void 0) return true;`——**未打 scope 标记的监听器全局放行**，插件顶层 `ctx.on` 属于这类。

本机实证：`task-mwwaq4jb-n5yv` 的终态 note 是 `completed`（`subagent/end` 的 stopReason 原文），证明插件级订阅真能收到子代理事件。

### 边界（重要，别当成探活的替代）

- **`agent/disposed` 只覆盖 subagent，不覆盖 job**（job 没有 agent 生命周期）
- 从没解析出 `nativeSessionId` 的任务匹配不上，仍靠 `sweepOnce` 兜底
- 补丁 D 触发的取消会**丢弃队列里未投递的指令**，摘要里会写明条数

## 十、许可

MIT

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
- **重启不撒谎**：原生执行单元没了的任务标 `interrupted`，绝不虚报 running
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

1. 把 `dsh-background-task-coordinator-0.1.4.tgz`（或 0.1.4.zip，内容一致）放到任意目录。
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
[task-coordinator] 已注册 8 个工具（7 任务 + task_probe 诊断），数据目录 C:\Users\<你>\.dsh\background-task-coordinator
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
4. **数据是一个 SQLite 库**：`~/.dsh/background-task-coordinator/tasks.db`（WAL 模式）。可以直接看（`node:sqlite` 或任意 sqlite3 客户端）、直接删——删了下次启动重建空账，不影响 DSH。旧版的 `tasks.json` 会在首次启动时自动迁进来，迁完改名 `.migrated` 保留。
5. **限额与超时可配**：环境变量 `DSH_COORD_LIMITS`（JSON），如 `{"global":3,"perOwner":2,"timeoutMinutes":120,"sweepSeconds":300}`。超限额的建任务请求被明确拒绝（不绕过）；过 deadline 的活动任务先请求取消，等执行器确认后落终态。

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
- 重启回收：失联任务标 `lost` 并发通知，不复活旧记录

**接口契约核验 15 项全部 VERIFIED**，在 `docs/接口核验表.md`。那份表里还记了两个「看着像问题其实不是」的坑：

- `ctx.jobs 探测：[{"key":"jobs","methods":[]}]`——`methods` 是空的但 `jobs.start()` 调得通。这个服务是受控代理，反射拿不到方法名。**别拿 `methods: []` 判断「服务没挂」。**
- `followup` / `steer` 收的是**消息对象**不是字符串。传裸字符串会抛 `Cannot read properties of undefined (reading 'kind')`，把子代理整轮打成 error。

---

## 九、兼容性

- **DSH 0.2.1-rc.4：全链路实测**（docs/A01-A14验收报告-20261125.md：建 job / 建并绑定 subagent / 查状态 / 读输出 / 取消 / 追加指令 / 限额 / 截断 / 重启对账，14 项）
- **DSH 0.2.2-rc3：适配**（0.1.3 起）。0.2.2 收紧了 job 注册表的 owner 校验（`start(spec)` 强制解析 `spec.owner` 的活 agent，且有主 job 的 kill/readAt/get 按 owner 围栏）——0.1.3 起插件按真实会话 id 传 owner 并全程带 caller。0.1.2 及更早版本在 0.2.2 上 `type=job` 会报 `no job controller serves this agent`。
- Node ≥ 22.16（`node:sqlite` 需要）
- 零核心改动，纯插件层

---

## 十、许可

MIT

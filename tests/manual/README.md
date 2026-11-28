# tests/manual —— 需要真环境的验证脚本

这些不进 `npm test`，因为它们需要的条件比 CI 环境多：真实宿主源码、真 spawn、真取消、真 zstd 文件。**它们不是补充测试，是「当测试只能查字符串而查不出行为」时的第二意见。**

写它们的直接原因：0.2.10 那次我把 `argv[length-5]` 写成 `argv[length-4]`，源码断言（查 `COORD_JOB_CMD` 在不在）**是绿的**，是 `e2e-quoted-cmd.mjs` 跑真 spawn 才抓到的。**只查字符串 = 假绿。**

---

## 先解压宿主源码

`poke-chain.mjs` 和 `close-vs-dispose.mjs` 要读 DSH 宿主自己的实现（`app.asar` 里的 `node_modules`）。这两个脚本验证的是**宿主行为**，不是插件行为，所以必须读真源码。

```bash
# 解压到临时目录（用仓库根的 草稿/asar-extract.mjs）
node ../../草稿/asar-extract.mjs "C:\Program Files\DSH NEXT\resources\app.asar" "%TEMP%\asar-out" \
  "/node_modules/@deepseek-ai/dsh-agent-loop/lib/index.js"

node ../../草稿/asar-extract.mjs "C:\Program Files\DSH NEXT\resources\app.asar" "%TEMP%\asar-out\subagent" \
  "/node_modules/@deepseek-ai/dsh-subagent/lib/index.js"
```

解压后目录应长这样：

```
%TEMP%\asar-out\
  index.js                  ← dsh-agent-loop
  subagent\index.js         ← dsh-subagent
```

路径可用环境变量覆盖：`DSH_ASAR_OUT=<你的解压目录>`。

---

## 每个脚本验什么

### `verbatim-compare.mjs`

**不需要宿主源码。** 同一条带引号命令，两种交付方式的对照：

| 方式 | `echo "quoted ok"` 的结果 |
|---|---|
| 原文直传 + `verbatim=false`（修复前） | `\"quoted ok\"` ← 反斜杠进了输出 |
| 外包引号 + `verbatim=true` | `"quoted ok"` ← 正常 |

还有更严重的一例：`powershell -Command "Write-Output 42"` 在 `verbatim=false` 下**只回显不执行**。

**这条脚本的意义**：证明 0.2.10 修的是真问题，不是理论问题。

### `e2e-quoted-cmd.mjs`

**端到端**：走插件的沙箱分支（`sandboxPolicy.resolve` 返回 `workspace-write`），真跑 `echo "quoted ok"`，断言输出是 `"quoted ok"` 且不含 `\"`。

```
✅ 通过：引号完好，没有被转义成 \"
```

**这条是抓出 `length-4` 那个 bug 的脚本。** 源码断言当时是绿的，这条红了。

### `jobkill-close-code.mjs`

**不需要宿主源码。** 复现 Bug 2 的根因层：真起一个 `ping -n 30`，3 秒后 `taskkill /T /F`：

```
code   = 1
signal = null        ← 不是 killed
```

**这解释了为什么台账落 `failed / exit 1`**：producer 拿到的就是 `exit 1`，不是取消信号。

### `e2e-timeout-cancel.mjs`

**端到端**：验证补丁 D（超时清账补真取消）真的会调 `ag.cancel({kind:'user'}, {keepInbox:false})`。

做法：建任务 → 绑一个假 agent → 把台账 `deadlineAt` 改到过去 → 等维护循环（`sweepSeconds: 1`）跑一轮。

```
ag.cancel 被调用: true
  cause={"kind":"user"}  opts={"keepInbox":false}
台账 status: cancel_requested
errorSummary: 已超 deadline（1 分钟），已下发真取消（keepInbox=false）
```

**这条抓出过一个真 bug**：补丁 D 本来把 `errorSummary` 写对了，但没 `continue`，被后面的通用分支覆盖成笼统的「已请求取消」。测试 34.9 是那个 `continue` 守卫的固化。

**注意 `timeoutMinutes` 有 `min: 1` 的护栏**（`num(lim.timeoutMinutes, 120, 1)`），所以传 `0.02` 会被退回默认 120。脚本用「改台账 deadline」绕开，不是改配置。

### `poke-chain.mjs`

**需要宿主源码。** 验证「对 idle 子代理 `cancel({keepInbox:false})` 会不会促发结算」的完整六环：

```
1. inbox.clear() 调 splice()                    ← agent-loop:93-96
2. splice() 调 mutate(..., discardRemoved=true)  ← agent-loop:159-161
3. mutate() emit 'agent/inbox/discarded'         ← agent-loop:205
4. subagent 订阅了它                              ← subagent:1862
5. handler 是 wakeSettlement                     ← subagent:1855-1857
6. wake() 会 poke.resolve()                      ← subagent:1917
```

**用途**：回应「`inbox.clear()` 不会唤醒结算观察者」这个说法。第 4 环是它漏掉的 —— 收件箱的每次变动（inserted / claimed / discarded）都会唤醒。

### `close-vs-dispose.mjs`

**需要宿主源码。** 验证「结算和销毁是同一个事务」：

```js
await activation.handle.dispose();    // 2025：Agent 被销毁
this.resident.delete(childId);        // 2033：移出驻留表
activation.observer.settle(terminal); // 2041：发 subagent/end
```

**结论**：一旦结算过，agent 已经不在 `ctx.agents` 里。所以「对 idle 子代理 cancel」只在**还没自然结算**的窗口内有效；结算过的靠探活兜底（`getAgentHandle` 查不到 → miss 计数 → 落 `lost`）。

### `whenidle-probe.mjs`

**不需要宿主源码。** 验证 `Promise.race([whenIdle(), setTimeout(0)])` 能不能当零阻塞探针：

```
✅ 1. 真空闲 → true
✅ 2. 正在跑 turn → false
✅ 3. 正在 maintenance(/compact) → false（不误杀）★
✅ 4. maintenance 结束后 → true
✅ 5. 对照：status 在 maintenance 期间报 "idle"（会误判），探针报 false
```

**第 3、5 条是关键**：`agent.status` 把 `maintenance` 折叠成 `idle`，所以**不能用 status 判断**；这个探针能区分。

注：用复刻的 phase 语义，不是真 Agent。`activityDone` / `runMaintenance` 的行为是从源码逐行读出来的。

### `retire-frame-test.mjs`

**需要一个真会话文件**（`session.v4.jsonl.zstd`）。验证「只改几个 zstd frame、其余原字节不动」可不可行：

```
总 frame: 8478
目标 frame #1115  原长 441 字节
改为 type="subagent/retired"（等长：16 → 16 字符）
  重压后: 439 字节
  差: -2 字节
```

**改两个字符，压缩后长度就变了。** 后面的 frame 在文件里的字节偏移全部要重算 —— 等于整包重写。所以「不必动整包 8451 帧」在 zstd 下做不到。

**用法**：

```bash
node tests/manual/retire-frame-test.mjs "<会话目录>/session.v4.jsonl.zstd"
```

（脚本里默认路径是本机家会话，换机器要传参数。）

---

## 一个共同的前提

这些脚本里凡是涉及「真 spawn」的，都要求**当前终端不在 DSH 的受限沙箱里**。在 `workspace-write` 会话里跑，`spawn(..., {windowsHide:true})` 可能返回 `EPERM`（受限 token 下 CREATE_NO_WINDOW 被拒）——那是环境问题，不是代码问题。

**用普通终端跑。**

---

## 为什么这些不写成正式测试

正式测试（`tests/*.mjs`）要能在任何机器上跑，所以不能依赖：

- 宿主 `app.asar` 的具体路径与内部行号（升级就变）
- 真实的会话日志文件（每个人不一样）
- 能真正 spawn / taskkill 的完整权限（CI 或沙箱里可能没有）

**但这不等于「只查字符串就够了」**——0.2.10 的 `length-4` 就是这么漏掉的。所以：正式测试锁行为契约，manual 脚本做真实验证，两边都要有。

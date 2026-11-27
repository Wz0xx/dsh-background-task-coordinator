0.2.1 之后把核验报告剩下的「未修 / 半修」九条全部处理掉。测试 88 → **110 项**。

## 最要紧的两条

**`sweepOnce` 单次 miss 就判死。** `ctx.agents.get` 有瞬时查不到活 agent 的时候（注册表切换、宿主忙），而 `lost` 在 `TERMINAL` 里、**不可逆**——一次抖动就能把正在跑的任务打死，没有任何补救。现在连续两轮都查不到才认，中间只要查回来一次就清零。

**Mode B 秒结竞态。** 子代理可能在前台调 `task_register_delegation` 之前就跑完，事件比绑定先到，以前直接丢弃 → 那条任务永远停在 `running`，等一个已经发生过的结束事件。短任务（「回两个字」这种）几乎必中。现在把早到的事件缓存起来，绑定那一刻回放——走的是同一个结算映射函数，不是另写一份（stopReason 映射是「假成功/假失败」的分界线，两份实现迟早漂开）。

## 其余七条

| 问题 | 后果 | 现状 |
|---|---|---|
| `execSync('taskkill …')` | **同步阻塞宿主事件循环**，杀大进程树卡住几百毫秒 | 改异步 spawn + unref |
| 首行为空的 objective 未拦 | spawn 一条空命令，落 failed 而模型以为在跑 | 建任务前拦下并说明 |
| 失联 job 无运行期恢复 | 结算事件缺失时永远 running，永不超时 | 新增 `sweepJobsOnce`，挂 `task_list` + 维护循环 |
| `task_context` 无 `expectedVersion` | 两个代理各自读写，后者静默覆盖前者 | 暴露版本参数，冲突直接拒 |
| `settleNotification` 只记账 | `lost` 这类自产终态前台收不到 | 真投到发起会话 |
| 死代码 | `loadTasks`/`saveTasks`/`withTask`/`SCHEMA`/`spawnError` | 全删 |

## 关于通知

宿主的服务表里**没有**通用「发通知」服务——这是 cordis inspect 全表查过的，叫 Notification 的那几个都是 MCP 协议类型或账户奖励，无关。

但 `agents.get(sessionId)` 能拿到发起会话的活 agent，上面有 `followup`，和 `task_append_message` 同一条通道。所以通知 = 往 owner 会话投一条摘要消息。

只在**协调器自产、前台本来收不到**的终态上投（探活 lost / 重启对账 / 超时清账）。原生 job/subagent 结束本来就会回到前台，再投一条是噪音。同 `taskId + status` 只投一次，投不出去就如实记「未能投递」，措辞不退回「已送达」。

## 一句假日志删掉了

```
ctx.jobs.onSettled 不存在——结算回收走 task_describe 的 readOutput 兜底，签名待实测
```

**根本没有那个兜底。** `readAt` 只读输出、不写台账。这句话会让读日志的人以为「反正有东西接着」，实际没有。

## 一个反直觉的细节

`windowsVerbatimArguments` 在不同上下文里答案相反：

- 我们自己拼 `cmd /d /s /c <原文>` → **必须 true**（否则引号变字面量）
- 独立 argv 调 `taskkill` → **必须 false**（否则路径被劈开）

不能一刀切，按 argv 来源决定。

## 测试

```
主回归      16/16
下游补丁     9/9
专项       85/85
```

新增 22 项，覆盖本版每一条：

- 单次 miss 不判死 / 查到就清零 / 持续两轮才落 lost
- 事件早到时任务还在 queued / 绑定后回放 / 文案改口 / aborted 回放成 cancelled
- 首行空行拦下 / 无 `execSync` 残留
- 结算事件缺失时 job 探活补账 / 还在跑的不动
- 版本冲突被拒 / 不覆盖别人 / 不传仍兼容
- 原生结算不重复投 / 自产 lost 真投 / 幂等不重投

## 还剩什么（没动的，明确记着）

- `cancel` 传 `keepInbox: true` 偏「暂停」语义，未兜底 `interruptByParent`——本机 0.2.1 上那个方法存在但带 `mode: 'continuable'`，不确定是否等价，需要真机确认
- `sandboxed.env` 未透传、无命令审批门——要改沙箱契约，风险大于收益
- `cancel_requested` 下收到 `stopReason='completed'` 仍判 cancelled（A07 会合规则，刻意的）
- `sweepOnce` 的 miss 计数是内存态，重启清零（刻意：重启后由启动对账统一裁决）
- `task_list({all:true})` 的 `listRecent(50)` 未按 caller 过滤

前两条我判断需要真机或宿主契约配合，不宜盲改。

---

逐条细节见 `docs/0.2.2改动记录-20261127.md`。

这一版的来源不同：不是我找的问题，是一份**别人写的 0.2.1 补丁**（Gemini 生成，1900 行）。我逐段对比自己的 0.2.2 实现，**采纳了七条它比我做得好的**，不采纳的写了理由。

测试 110 → **117 项**。

## 它抓到了我的两个真 bug

**GBK 解码器，积压字节时纯 ASCII 会旁路。** GBK 的次字节可以落在 ASCII 区（0x40–0x7E）。比如「丂」= `81 40` 跨两个 chunk：第一个 chunk 是 81 进缓冲，第二个 chunk 是 40（纯 ASCII）被直接吐出去 —— 字被劈成两半且顺序错乱。实测旧实现输出 `"@\n�"`。

**`end()` 对残留字节硬走 UTF-8。** 「A中」= `41 D6 D0` 一次给完时，`sniff()` 因为尾部截断保护判断不了，数据全留在缓冲。流结束时直接 `toString('utf8')` → `"A��"`。

这两条我是**先复现再改**的：把 0.2.2 的旧解码器单独抄出来跑，确认两个用例都乱码，改完再验（`"丂\n"` 和 `"A中"`）。

## 其余五条

| 问题 | 我原来的状态 | 现状 |
|---|---|---|
| `given` 放行 `current` 这类占位词 | 能过长度检查，`current` 又是 `conversationId` 默认值 | 显式排除 |
| 父会话 id 被当子会话 id | 该任务永远匹配不上 `subagent/end` | 排除自指 |
| `sweepOnce` 跨会话写别人台账 | A 调 `task_list` 能把 B 的任务标 lost | 传 caller 做归属隔离 |
| `listRecent` 没按 caller 过滤 | 别的会话新建 50 条挤空当前视图 | 传 caller |
| `cancel` 传 `keepInbox: true` | 那是「暂停」语义，队列留着还能被唤醒 | 改 `false`，并兜底 `interruptByParent` |

另外三条是它顺带补的：二次登记防覆盖（换 agent 等于把任务绑到别处，原来那个还在跑）、启动对账探活抛错不误判 lost（「没问成」≠「问到了没人」）、`sandboxed.env` 透传（只吃 argv 不吃 env 是半套隔离）。

还有一条微妙的：`ctx.jobs.kill()` 可能在同一调用栈里同步触发 settled 回调，那条路径已经把任务落成 `cancelled` 了。我原来的取消路径会再写一遍，导致重复发事件并覆盖 `errorSummary`。现在写之前重读，已终态就跳过。

## 没采纳的

- **`settleNotification` 仍只记账** —— 我 0.2.2 已改成真投递（`agents.get(owner).followup`），比它进一步
- **没有 `sweepJobsOnce`** —— 我 0.2.2 新增的 job 探活它没有，那解决的是「结算事件根本不存在」的宿主
- **把 `db()`/`emitEvent` 等模块级函数全挪进 `apply`** —— 思路对（解决同进程多实例/热重载互相覆写、误关句柄），但要把五个函数一起搬、改动 300+ 行。不想在「收别人补丁」的版本里做结构性重写，记进待办单独做

## 测试新增 7 项

```
19.1  短 GBK 单包（A中）正确解码（旧实现出 A��）
19.2  次字节落在 ASCII 区的跨包汉字（丂）不乱码（旧实现出 @\n�）
19.3  先 ASCII 后 GBK 不退化
19.4  别人的会话扫描不会动我的任务
19.5  自己的会话查两轮能收掉
19.6  cancel 传 keepInbox: false
19.7  已绑定任务拒绝换目标重登记
```

## 装

下载 `dsh-background-task-coordinator-0.2.3.zip` 或 `.tgz`，按 README 第三节。硬前提仍是组合里有 `@deepseek-ai/dsh-tool-jobs`。

从 0.1.x 升级注意：库路径按 profile 隔离，旧库不会自动迁移，要保留历史请把 `tasks.db` + `-wal` + `-shm` 三个一起拷到 `~/.dsh/background-task-coordinator/<profile>/`。

逐条细节见 `docs/0.2.3改动记录-20261127.md`。

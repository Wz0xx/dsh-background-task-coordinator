0.2.0 发布后收到一份**带行号和复现方法**的逐行核验报告。它的核心结论是：作者确实认真推进了四轮迭代，解决了约 70%–75% 的实质风险，但**在修补过程中新引入了 6 个可复现的退化/Bug**。

我把每一条都对着代码核了一遍。**报告基本是对的 —— 七处退化全部属实，而且都是我在 0.1.8–0.2.0 这三轮里自己引进来的。** 这一版逐条修掉。

## 最严重的一条：越权，而且被新功能放大了

0.2.0 给六个工具补了归属校验，**唯独漏了 `task_register_delegation`**。

后果不是「少一道检查」：

```
1. 攻击者会话知道受害者的 taskId
2. 把受害者的任务绑到自己的子代理上
3. 0.2.0 新加的 pending 补投立刻执行
   → 受害者排队中的指令原样投进攻击者的 agent
```

**新加的「pending 补投」把这个洞从「能看」升级成了「能偷」。** 报告用的复现载荷是 `SECRET_TOKEN=xyz123`。

同一类问题还有一处：`task_describe` 读 job 输出时用 `rowFull.ownerSessionId` 当 caller —— 那是「谁创建的」，不是「谁在调」，等于冒充 owner 穿透 DSH 0.2.2 的 `assertAccess` 围栏。

## 崩溃点：改了底层，三处调用点没跟上

0.1.10 把 `getAgentHandle` 内部的 try/catch 去掉，本意是让调用方区分「查不到」和「查询失败」。但三处没跟着改：

- `sweepOnce` → 一条子代理查询瞬时异常**打崩整个 `task_list`**
- `task_append_message` → 直接崩工具，而且崩在「已删除旧 pending 行」之后，**消息凭空消失**
- 启动对账 → 把异常当「已死」，误判 `lost`

修的时候顺带发现一个更隐蔽的问题：0.2.0 是「进门就删旧行」再探活。现在把删除封成 `mustPurge()`，只在确定要写新行之前才调。

## 迁移把约束丢了

`task_messages_v2` 建表时漏了 `REFERENCES tasks(id)` 和 `status CHECK`。重建后的表**比迁移前更松** —— 能插指向不存在任务的孤儿消息，能写 `status = 'TOTALLY_BOGUS_STATUS'`。而 `ACTIVE`/`TERMINAL` 判定全靠约定，一个手误的 `'runing'` 会让任务永远既不算活动也不算终态。

判据也改了：从「版本号够不够」改成「**看 sqlite_master 的实际 DDL**」。因为 0.2.0 已经把那个残缺表标成了版本 2，光看版本号会永远跳过修复。

## `windowsVerbatimArguments` 开过头了

0.2.0 为修「引号路径被拼坏」加了它，但加成了全局。`sandbox.confine()` 返回的 argv 里常有 `C:\Program Files\...` 这种带空格路径，跳过转义就被劈成多个错误参数。

改成按 argv 来源决定：只有 `danger-full-access`（我们自己拼 `cmd /d /s /c`）才开。

## 另外三处

**`resolveSubagentSessionId` 漏 `caller.id`** —— 而空态兜底造出来的恰好是 `{session:{id}, id}` 形态，导致反查必败。同时 `given` 是「给了就信」，模型乱填的字符串会被当成会话 id 落库。

这里有个取舍要说清楚：报告建议严格校验，我第一版写成「必须是 UUID」，结果把 `sess-F1` 这种合法短 id 也打断了，补投直接失效，测试立刻报红。**过严的校验会打断正常时序**（原生工具刚返回 sessionId 时，agents 注册表往往还没登记）。最终只排除明显是话不是 id 的。

**`config` 对 `task_create` 不生效** —— 它另写了一套只读环境变量的限额，和 `LIMITS_READ()` 各算各的。实测传 `{global:1}` 仍能建第 2 个、`{timeoutMinutes:5}` 时 `deadlineMinutes` 仍落 120。

**P3**：删掉 `lib/storage/{task-store,event-store}.js`（引用已删除的 `lib/core`，导入即 `ERR_MODULE_NOT_FOUND`，一直随包发布）、`currentStage` 停在 `creating-executor`、`task_probe` 直取未 inject 服务、pending 正文截到 500 字（补投等于把指令砍半）、`package.json` 里「资源锁」的虚假声明。

## 测试

三套 **88 项**（16 + 9 + 63），新增 18 项全部针对上述退化：

- 越权完整复现：攻击者登记被拒 + 受害者 pending 没被刷走
- 探活抛异常时 `task_list` 不崩，且不误判 `lost`
- 外键和 CHECK 真的在（插孤儿消息、插非法 status 都必须失败）
- 崩了消息不消失
- **沙箱分支与全权分支各跑一遍带空格路径** —— 专盯 verbatim 回归
- 1200 字长指令补投，投出去的是完整正文

## 还没动的债（记在文档里）

P1-2 残留（Windows `execSync taskkill` 同步阻塞、首行空行未拦截）、P1-3 残留（`keepInbox: true` 偏暂停语义、未兜底 `interruptByParent`）、P2-1（`sweepOnce` 单次 miss 仍判死，但至少不崩了）、P2-3（Mode B 秒结竞态）、P2-5（`task_context` 未暴露 `expectedVersion`）、P2-8（失联 job 运行期无恢复通路）、P2-9（只记账不投递，README 那处说法还没改）。

这些不影响「现在不会再丢结算、不会再越权」，但确实是债。

---

**装**：下载 `dsh-background-task-coordinator-0.2.1.zip` 或 `.tgz`，按 README 第三节。硬前提仍是组合里有 `@deepseek-ai/dsh-tool-jobs`。

**从 0.1.x 升级**：库路径按 profile 隔离了，旧库不会自动迁移，要保留历史请把 `tasks.db` + `-wal` + `-shm` 三个一起拷到 `~/.dsh/background-task-coordinator/<profile>/`。只拷 `tasks.db` 会得到空库 —— 真实数据在 WAL 里。

逐条细节见 `docs/0.2.1改动记录-20261127.md`。

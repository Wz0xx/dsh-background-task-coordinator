# tests/fakebackend —— 假的 OpenAI 兼容后端

一个本地起的假模型服务，用于协调器插件的**端到端回归**。

## 为什么要它

单元测试（`tests/*.mjs`）是直接调插件的工具对象：

```js
await R.task_create.execute({ type: 'job', objective: '...' }, exec)
```

这测不到的东西有一层：**模型是通过 OpenAI function-calling 来用的**。那一层出问题，单测全绿也没用：

- 插件工具的参数描述能不能转成 `tools[].function.parameters`
- 流式 SSE 里 `tool_calls.arguments` 的分片能不能拼回来
- 工具结果以 `role: "tool"` 回传后，模型还能不能继续
- 整条链路上 job 是真 spawn 了、台账是真写了

用真 provider 测这些会花钱、会慢、会因限流而不稳。这个假后端把它们变成确定性的。

## 三个套件

```bash
node tests/fakebackend/run-all.mjs          # 全部
# 或分开
node tests/fakebackend/selftest.mjs         # 协议自检（9 项）
node tests/fakebackend/regression.mjs       # 协调器端到端（14 项）
node tests/fakebackend/compat-check.mjs     # DSH 适配器兼容（6 项）
```

`npm run test:fake` 等价于第一条。

## 剧本（scenario）

请求里带 `[SCENARIO:xxx]` 标记，后端按标记回固定脚本。这样测试不依赖模型"猜"出来的输出。

| 标记 | 回什么 |
|---|---|
| `plain` | 纯文本 `FAKE-OK` |
| `create-job` | 一次 `task_create` 工具调用（`type=job`） |
| `create-subagent` | 一次 `task_create`（`type=subagent`） |
| `list` | 一次 `task_list`（带 `all: true`） |
| `job-then-append` | 建长任务 |
| `error` | HTTP 500 |

**重要**：会发工具调用的剧本，在收到 `role: "tool"` 结果后自动转 `*-after-tool` 收尾，只调一次。
第一版没这个判断，客户端把结果回传后同一段 `[SCENARIO:]` 还在历史里，剧本又返回同一个 tool_calls —— **一次 turn 建了 4 条任务**。

## 端口

默认从 18991 起（各套件用不同端口避开冲突），可用 `FAKE_OPENAI_PORT` 覆盖。

每个套件都自己起、自己关，**不依赖外面有没有跑着一个**。

## 这个假后端不模拟什么（诚实边界）

- **不模拟限流、重试、超时**——那是真 provider 才有的行为
- **不模拟 token 计费**——`usage` 是写死的假数字
- **不模拟推理（reasoning）块**——只回 `content` 和 `tool_calls`
- **不验证 DSH 的 agent loop 本身**——回归驱动里那个 `runTurn` 是我用 60 行写的迷你 loop，不是 DSH 的

第 4 条最要紧：**这是「协调器 × OpenAI 协议」的回归，不是「协调器 × DSH 完整会话」的回归。** 后者要改 `cordis.patch.yml` 加一个 fake provider 并重启 DSH——会打断正在用的会话，所以没做。

## 相关的一个坑（记下来免得再踩）

`regression.mjs` 里的 job 注册表必须放闭包，不能挂 `ctx.__jobs`：

```
Error: cannot get property "__jobs" without inject
```

`tests/mockctx.mjs` 的 Proxy 会拦未登记属性——这行报错本身是好事，说明 mock 忠实地在模拟 cordis 语义。

另一个：`task_list` 默认只列**活动**任务，终态的要传 `all: true`。第一次没传，看到「（无任务）」以为是 bug，其实是设计如此。

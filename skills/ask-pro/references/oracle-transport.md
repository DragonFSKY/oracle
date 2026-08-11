# Dragon Relay transport

准备完整 prompt 文件、冻结附件和调用前已知的稳定 `requestId`。

## 路由顺序

1. 当前运行时实际暴露 MCP 工具时优先使用长阻塞 MCP。
2. MCP 工具未暴露或在任务创建前启动失败时，使用异步 CLI 后备。
3. 任一路径已创建任务后始终复用原 `requestId`，不得因 transport 变化创建第二个任务。

## 长阻塞 MCP

只使用当前运行时实际暴露的两个工具：

```text
mcp__dragon_relay__ask_expert
mcp__dragon_relay__await_expert
```

### 原生直连（主路径）

把 Relay MCP 作为顶层工具直接调用，不要把单次长阻塞咨询包进 `functions.exec`：

1. 若 `mcp__dragon_relay__ask_expert` 已直接暴露，立即调用它。
2. 若工具采用延迟加载且运行时支持原生 `tool_search`，以 `dragon_relay ask_expert await_expert long blocking` 检索并加载 `mcp__dragon_relay` namespace。
3. 确认搜索结果来自 `mcp__dragon_relay` 后，直接调用加载出的顶层 `ask_expert`；其完全限定标识是 `mcp__dragon_relay__ask_expert`。

原生 `tool_search` 只是加载工具，不创建咨询任务。加载完成后必须使用顶层工具调用；不得转入 `functions.exec.ALL_TOOLS` 再包一层调用。

`ask_expert` 必须传入稳定 `requestId`（3–5 段小写连字符 slug）、完整中文 prompt、附件路径和模型提示。它创建或恢复同一个 durable Relay task，并让这一条 MCP 调用通过 SSE 保持阻塞，直到人工端回传结果。

顶层 MCP 调用 pending 时不要运行 `functions.wait`、`wait`、`status`、后台命令、定时器或任何轮询，也不要要求用户发送“继续”。保持工具调用本身 pending；服务端终态事件会主动结束调用。MCP cancellation 或 stdio 中断只停止当前 waiter，不取消远端任务。

若 MCP transport 中断，使用同一 `requestId` 直接调用顶层 `await_expert`。不得换 slug 再调用 `ask_expert`，也不得创建第二个咨询任务。

### `functions.exec` 兼容后备

只有原生 `tool_search` 确实不可用或没有返回 Relay 工具，并且 Relay MCP 未在顶层暴露时，才允许使用此后备。若有 `functions.exec`，在其运行时枚举 `ALL_TOOLS` 并筛选 `dragon_relay`、`ask_expert`、`await_expert`；命中后调用对应的 `tools.mcp__dragon_relay__ask_expert(...)` 或 `tools.mcp__dragon_relay__await_expert(...)`。顶层清单未显示且尚未完成原生搜索或此目录检查，不构成 MCP 不可用证据。

通过 `functions.exec` 调用延迟加载的 Relay MCP 时，必须让外层 code-mode cell 自始至终保持阻塞。`functions.exec` 输入的第一行必须是下面的 pragma；`yield_time_ms` 的单位是毫秒，不能误用 MCP 配置中以秒为单位的 `tool_timeout_sec`：

```javascript
// @exec: {"yield_time_ms": 3153600000000, "max_output_tokens": 30000}
const result = await tools.mcp__dragon_relay__ask_expert({
  requestId,
  prompt,
  files,
  model,
});
text(result);
```

`await_expert` 使用相同的 pragma 和直接 `await` 方式。不要依赖 `functions.exec` 默认的 10 秒 yield；不要把 MCP 调用放进会先返回 session/cell ID 的后台任务。若意外得到 `Script running with cell ID N`，这表示外层 code-mode 调用已经 yield，并不表示 Relay 正在轮询，也不表示需要重新提交任务。不得再次调用 `ask_expert`；只允许对 cell `N` 调用一次 `functions.wait`，同时把该次 wait 的 `yield_time_ms` 设为 `3153600000000`，使它成为一次阻塞恢复而不是周期轮询。

兼容后备调用后不要运行 `wait`、`status`、后台命令、定时器或任何轮询。上一段的一次超长 cell wait 只用于意外 yield 恢复，不得重复执行。

若完成原生 `tool_search` 和上述兼容目录检查后仍没有 `mcp__dragon_relay__ask_expert`，或它在接受任务前明确报告启动/transport 不可用，转入下方 CLI 后备。不要仅因为 MCP 调用仍在 pending 就切换 transport。

同一任务始终复用原 `requestId`；MCP 路径由 SSE 主动返回。

## 异步 CLI 后备

只使用 `dragon-relay`，不使用 `oracle --engine relay`。先确认 `dragon-relay` 可执行，准备与 MCP 路径完全相同的 `prompt_file`、附件、模型和 `request_id`，再构造参数：

```bash
attachments=(/absolute/path/to/frozen-attachment)
relay_args=(
  --prompt "$(cat -- "$prompt_file")"
  --model gpt-5.6
  --slug "$request_id"
)
if ((${#attachments[@]})); then
  relay_args+=(--file "${attachments[@]}")
fi

dragon-relay ask "${relay_args[@]}" --dry-run json
dragon-relay ask "${relay_args[@]}"
```

必须先检查 dry-run 成功且 prompt、模型、附件和 slug 正确，随后只发起一次 live。live 默认为异步：确认输出已经 durable publication 到 `queued`，记录 session/task ID，然后结束当前轮；不启动后台 `wait`、`status`、定时器或轮询。

后续用户要求继续时只执行一次：

```bash
dragon-relay wait "$request_id"
```

若仍 pending，报告当前状态并停止。若已完成，恢复结果并继续原任务。若 live 返回结果不明确，先对原 ID 执行一次 `wait` 查证，不得盲目重交。

MCP 已创建任务但 `await_expert` 不可用时，也只对原 `requestId` 执行上述一次 `wait`，不得发起 CLI `ask`。

---
name: ask-pro
description: 优先通过 Dragon Relay MCP 长阻塞获取外部专家意见，并在 MCP 未暴露或启动失败时使用可恢复的异步 CLI 后备。用户明确提到 askpro、ask pro、ask Oracle、问 Oracle、打包问 Oracle或把仓库给 Oracle 看时使用。代码文本路由到 ask-pro-repomix；原始文件、ZIP、二进制、PDF、图片、fixture 或精确目录结构路由到 ask-pro-zip。
---

# Ask Pro

## 路由

- 代码、架构、缺陷和代码审查：执行 `ask-pro-repomix`。
- 原始文件、二进制、图片、PDF、fixture、归档或精确目录结构：执行 `ask-pro-zip`。
- 用户点名子 Skill 时直接使用该 Skill。

## 调用

完整读取 `references/oracle-transport.md`。

1. 完整读取 `references/prompt-core.md`，按用户目标生成完整的九段式简体中文 prompt；九个核心模块每次都必须保留并具体填写，不能主动精简。保留代码标识、命令和路径原文。
2. 代码审查、Bug、架构、实现计划或复审时再读取 `references/prompt-repo-review.md`。
3. 用户要求审查后实施、修完复审或最终验收时再读取 `references/review-cycle.md`，执行有上限的独立审查闭环。
4. 把最终 prompt 写入权限为 `0600` 的 UTF-8 文件；准备与结论直接相关的冻结附件。完整结构是强制要求，但每一段都必须结合真实任务填写，不能用空泛套话或纯长度代替证据质量。
5. 为同一提交生成调用前已知的稳定 `requestId`；独立回归和最终验收必须使用新 `requestId`。
6. 正式提交前运行 `python3 <ask-pro-skill-dir>/scripts/validate_prompt.py < "$prompt_file"`；九段结构校验失败时不得提交。
7. 优先把 Relay MCP 作为顶层工具直接调用。若 `mcp__dragon_relay__ask_expert` 尚未直接显示但运行时支持原生 `tool_search`，先以 `dragon_relay ask_expert await_expert long blocking` 检索并加载 `mcp__dragon_relay`，随后直接调用加载出的顶层 `ask_expert`。传入同一 `requestId`、完整 prompt、附件和模型，让该工具通过 SSE 长时间阻塞直到返回。单次长阻塞咨询不得放入 `functions.exec`。只有原生 `tool_search` 确实不可用或未返回 Relay 工具时，才按 `oracle-transport.md` 使用 `functions.exec.ALL_TOOLS` 兼容后备。
8. 顶层 MCP 调用 pending 时停止其他动作，不调用 `functions.wait`，不轮询、不启动后台终端、不要求用户发送“继续”。只有兼容后备意外返回 `Script running with cell ID ...` 时，才允许对该 cell 执行一次同样超长的阻塞式 `functions.wait`；不得重提 MCP 或循环 wait。
9. 若 MCP transport 在任务创建后中断，优先用同一 ID 调用 `mcp__dragon_relay__await_expert`；若该工具也不可用，只对同一 ID 执行一次 CLI `wait`，不得新建任务。
10. 若 MCP 工具未暴露或在创建任务前启动失败，按 `oracle-transport.md` 先 dry-run，再执行唯一一次异步 CLI live；记录原 ID 并结束当前轮。后续用户要求继续时只运行一次 `dragon-relay wait <原 ID>`，pending 就停止，不轮询。

## 提示词原则

- 保留用户原始问题和真实验收标准，不替用户扩大目标。
- 每次保留“调查与反证”模块；根因或方案不明确时要求机制不同的竞争性路线，明确问题则说明无需多路线的原因并列出关键验证假设。
- 候选结论形成后转入反证和边界检查，不无限扩张分析。
- 明确“不算完成”、范围锁、证据门和停止条件。
- 不虚构任务可解性，不要求隐藏思维链，不使用“最大算力”“思考若干小时”等无证据措辞。

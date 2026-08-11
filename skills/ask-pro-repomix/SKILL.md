---
name: ask-pro-repomix
description: 通过 Repomix 将代码仓库打包为文本代码包，再用 Dragon Relay 获取外部专家意见。用户明确点名 ask-pro-repomix、Repomix 版、打包问 Oracle、把仓库打包给 Oracle 看，或由 ask-pro 路由时使用。原始二进制、PDF 或图片使用 ask-pro-zip。
---

# Ask Pro Repomix

Repomix 制包使用确定性本地命令，专家请求通过 Dragon Relay 完成。

## Oracle 传输

先完整读取 `../ask-pro/references/oracle-transport.md`。

## 提示词

完整读取 `../ask-pro/references/prompt-core.md`。仓库审查、Bug、架构、实现计划或代码复审再读取 `../ask-pro/references/prompt-repo-review.md`；审查后实施、回归或最终验收再读取 `../ask-pro/references/review-cycle.md`。

## 准备

1. 确认 `node`、`sha256sum`、`realpath` 可用。
2. 检查仓库入口、当前设计文档、ADR、任务计划和贡献规范。与任务直接相关的当前事实源必须入包；无法判定哪个版本有效时，把合理候选一并入包并在问题中说明歧义。
3. 本地目标使用绝对路径；远程目标先浅克隆到 `mktemp -d`，记录实际 commit。不要上传 `.oracle/**`。
4. 使用已安装的 `repomix`，没有时使用固定版本：

```bash
REPOMIX_FALLBACK_VERSION='1.16.1'
if command -v repomix >/dev/null 2>&1; then
  repomix_cmd=(repomix)
else
  repomix_cmd=(npm exec --yes "--package=repomix@$REPOMIX_FALLBACK_VERSION" -- repomix)
fi

target='/absolute/path/to/repo-or-subdir'
out="$(mktemp /tmp/ask-pro-repomix.XXXXXX.xml)"
include='' # 可选，例如 src/**,tests/**
ignore='node_modules/**,dist/**,coverage/**,.git/**,.oracle/**'
args=(--style xml --output "$out" --top-files-len 10 --output-show-line-numbers --ignore "$ignore")
[[ -n "$include" ]] && args+=(--include "$include")
"${repomix_cmd[@]}" "$target" "${args[@]}"
test -s "$out"
```

5. 从最终 XML 提取 manifest 并计算 SHA，用于确认提交前后是同一个代码包。不按文件名或内容进行安全扫描，也不因敏感文件、密钥文本或嵌套归档中止：

```bash
manifest="$(mktemp /tmp/ask-pro-repomix-manifest.XXXXXX.txt)"
sed -nE 's/^[[:space:]]*<file path="([^"]+)".*/\1/p' "$out" > "$manifest"
test -s "$manifest"
package_sha="$(sha256sum "$out" | awk '{print $1}')"
```

## 构造请求

默认用简体中文，代码标识保持原文。每次请求必须完整包含共享模板规定的九个核心模块，不得主动精简；不适用项明确写“无 / 不适用”及原因。仓库请求还应包含仓库标签、commit/工作区状态、相关症状、允许范围、非目标、当前设计文档和真实测试结果。

要求结论引用附件中的相对路径、行号或具体符号，区分直接事实、合理推断和缺失证据，未执行的命令不得声称已执行。只有根因或设计方向不明确时才要求竞争性路线；不要默认扩展成全仓安全、性能或风格审计。不要写入本地绝对路径、临时文件名、SHA 或 slug。

从 `用户问题 + commit + package_sha` 生成稳定摘要，形成 3–5 段 `requestId`，例如 `ask-pro-rmx-ab12cd34`。相同请求必须恢复既有 session。把最终 prompt 写入权限为 `0600` 的 UTF-8 文件。附件使用冻结包的绝对路径，但 prompt 本身不包含该绝对路径。

## Oracle 提交

先验证完整中文结构：

```bash
python3 <ask-pro-skill-dir>/scripts/validate_prompt.py < "$prompt_file"
```

校验必须显示 `9/9 sections populated`，否则补全 prompt，不得提交。

再次验证 `sha256sum "$out"` 等于 `package_sha`，然后按共享传输规则提交：MCP 可用时调用 `mcp__dragon_relay__ask_expert`，`requestId` 使用上述稳定值，`prompt` 使用校验后的完整中文提示词，`files` 只传冻结 XML，`model` 使用 `gpt-5.6`，并永久阻塞到结果返回。MCP 未暴露或创建任务前启动失败时，使用同一 prompt、冻结 XML、模型和 `requestId` 执行 dry-run 后的唯一一次异步 CLI live。

MCP 或 CLI 已创建任务后不得换 ID 重交。MCP 中断时优先调用 `await_expert`；工具不可用时只执行一次 `dragon-relay wait <requestId>`。CLI live 返回后结束当前轮，后续继续请求也只运行一次相同 `wait`；pending 即停止，不轮询。

## Followup

补充问题使用新 `requestId` 和自足 prompt，并在必要时概述父结论。如需新代码证据，重新 Repomix 并重复 manifest 和 SHA 校验。

回归审查必须使用新 slug 和新代码包，并附带临时实施报告以及可用的 diff/测试证据。回归 reviewer 不得信任初审或实施报告；最终 verdict 限定为 `PASS / CONDITIONAL PASS / FAIL / INSUFFICIENT EVIDENCE`。`PASS` 后停止；最多再进行一次只针对阻断项的最终验收。

## 边界

- 只打包和咨询，Oracle 返回前不修改代码。
- Dragon Relay 返回最终答案后再继续处理。

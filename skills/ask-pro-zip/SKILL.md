---
name: ask-pro-zip
description: 生成原始文件 ZIP，再用 Dragon Relay 获取外部专家意见。用户明确点名 ask-pro-zip、ZIP 版、压缩包上传给 Oracle、把原文件一起打包上传，或由 ask-pro 路由时使用。纯代码文本审查优先 ask-pro-repomix。
---

# Ask Pro ZIP

文件选择、ZIP 打包和完整性校验在本地完成，专家请求通过 Dragon Relay 完成。

## Oracle 传输

先完整读取 `../ask-pro/references/oracle-transport.md`。

## 提示词

完整读取 `../ask-pro/references/prompt-core.md`。代码包审查、Bug、架构、实现计划或复审再读取 `../ask-pro/references/prompt-repo-review.md`；审查后实施、回归或最终验收再读取 `../ask-pro/references/review-cycle.md`。

## 准备

1. 确认 `node`、`sha256sum`、`unzip`、`7z`、`realpath` 可用。
2. 所有 Oracle 调用始终显式指定 Relay。
3. 确定根目录和明确的 include/exclude。默认只排除 `.git/**`、`.oracle/**`、`node_modules/**`、`dist/**` 和 `coverage/**` 等版本控制或生成目录，不按敏感文件名增加额外排除项。
4. 默认使用简体中文外层 prompt，并保留代码标识原文。每次请求必须完整包含共享模板规定的九个核心模块，不得主动精简；不适用项明确写“无 / 不适用”及原因。要求结论引用 ZIP 内相对路径和具体符号，区分直接事实、合理推断和缺失证据。不要把本地绝对路径、临时 ZIP 名、SHA 或 slug 写进 prompt。

## 本地生成 ZIP

```bash
root='/absolute/path/to/repo-or-folder'
cd "$root"
prompt='CHANGE_ME_COMPLETE_CHINESE_PROMPT'
bundle_path="$(mktemp /tmp/ask-pro-zip.XXXXXX.zip)"
7z a -tzip -mx=0 "$bundle_path" . \
  '-xr!.git' '-xr!.oracle' '-xr!node_modules' '-xr!dist' '-xr!coverage'
test -f "$bundle_path"
```

## 封存与完整性校验

```bash
manifest="$(mktemp /tmp/ask-pro-zip-manifest.XXXXXX.txt)"
unzip -Z1 "$bundle_path" | tee "$manifest"
test -s "$manifest"

bundle_sha="$(sha256sum "$bundle_path" | awk '{print $1}')"
sealed_bundle="/tmp/ask-pro-zip-${bundle_sha}.zip"
cp -- "$bundle_path" "$sealed_bundle"
chmod 600 "$sealed_bundle"
test "$(sha256sum "$sealed_bundle" | awk '{print $1}')" = "$bundle_sha"
```

manifest 只用于确认打包范围，不对敏感文件名、文件内容或嵌套归档设置阻断条件。

## Oracle 提交

从 `用户问题 + 根目录身份 + bundle_sha` 生成稳定的 3–5 段 `requestId`。把最终 prompt 写入权限为 `0600` 的 UTF-8 文件。上传封存后的 `sealed_bundle`，但 prompt 本身不包含本地绝对路径。

先验证完整中文结构：

```bash
python3 <ask-pro-skill-dir>/scripts/validate_prompt.py < "$prompt_file"
```

校验必须显示 `9/9 sections populated`，否则补全 prompt，不得提交。

再次验证 `sha256sum "$sealed_bundle"` 等于 `bundle_sha`，然后按共享传输规则提交：MCP 可用时调用 `mcp__dragon_relay__ask_expert`，传入稳定 `requestId`、完整 prompt、唯一 ZIP 附件和 `model: gpt-5.6`，并通过 SSE 永久阻塞到结果返回。MCP 未暴露或创建任务前启动失败时，使用同一 prompt、ZIP、模型和 `requestId` 执行 dry-run 后的唯一一次异步 CLI live。

MCP 或 CLI 已创建任务后不得换 ID 重交。MCP 中断时优先调用 `await_expert`；工具不可用时只执行一次 `dragon-relay wait <requestId>`。CLI live 返回后结束当前轮，后续继续请求也只运行一次相同 `wait`；pending 即停止，不轮询。

Followup 使用新 `requestId` 和自足 prompt，不传 `followupSession`；新增附件必须重新完成打包、manifest、封存和 SHA 校验，然后发起一次新任务。人工 relay 不保证自动复用同一 ChatGPT 对话。

回归审查使用新 slug 和修改后的新 ZIP，并附带临时实施报告以及可用的 diff/测试证据。要求独立 reviewer 从原始验收标准重新判断，最终 verdict 限定为 `PASS / CONDITIONAL PASS / FAIL / INSUFFICIENT EVIDENCE`。`PASS` 后停止；最多再进行一次只针对阻断项的最终验收。

## 边界

- 本 Skill 始终上传 ZIP，不伪装成 ChatGPT 原生图片/PDF视觉附件。
- 只打包和咨询，Oracle 返回前不修改源文件。
- Dragon Relay 返回最终答案后再继续处理。

#!/usr/bin/env python3
import re
import sys


REQUIRED_SECTIONS = (
    "任务",
    "已知事实与材料",
    "完成标准",
    "不算完成",
    "范围锁",
    "调查与反证",
    "证据规则",
    "停止条件",
    "输出格式",
)


def main() -> int:
    prompt = sys.stdin.read()
    errors: list[str] = []
    if not prompt.strip():
        errors.append("prompt 为空")
    if not re.search(r"[\u3400-\u9fff]", prompt):
        errors.append("prompt 不包含中文内容")

    for section in REQUIRED_SECTIONS:
        matches = re.findall(
            rf"<{re.escape(section)}>\s*(.*?)\s*</{re.escape(section)}>",
            prompt,
            flags=re.DOTALL,
        )
        if len(matches) != 1:
            errors.append(f"<{section}> 必须且只能出现一次，实际 {len(matches)} 次")
            continue
        if not matches[0].strip():
            errors.append(f"<{section}> 内容为空")

    if errors:
        for error in errors:
            print(f"ERROR: {error}", file=sys.stderr)
        return 1
    print("AskPro prompt structure valid: 9/9 sections populated.")
    return 0


if __name__ == "__main__":
    raise SystemExit(main())

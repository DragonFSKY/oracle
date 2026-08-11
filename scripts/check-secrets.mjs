#!/usr/bin/env node

import { readFileSync } from "node:fs";
import { spawnSync } from "node:child_process";

const tracked = spawnSync("git", ["ls-files", "-z", "--cached", "--others", "--exclude-standard"], {
  encoding: "utf8",
});
if (tracked.status !== 0) {
  process.stderr.write(tracked.stderr || "Unable to list tracked files.\n");
  process.exit(1);
}

const detectors = [
  ["private key", /-----BEGIN (?:RSA |EC |OPENSSH |DSA )?PRIVATE KEY-----/g],
  ["OpenAI-style key", /\bsk-(?:proj-|svcacct-)?[A-Za-z0-9_-]{20,}\b/g],
  ["GitLab token", /\bglpat-[A-Za-z0-9_-]{20,}\b/g],
  ["GitHub token", /\b(?:ghp|gho|ghu|ghs|ghr)_[A-Za-z0-9]{20,}\b/g],
  ["AWS access key", /\b(?:AKIA|ASIA)[A-Z0-9]{16}\b/g],
  ["Google API key", /\bAIza[A-Za-z0-9_-]{35}\b/g],
  ["Slack token", /\bxox[baprs]-[A-Za-z0-9-]{20,}\b/g],
];

const sensitivePath = /(?:^|\/)(?:\.env(?:\..+)?|[^/]+\.(?:pem|key|p12|pfx|jks|keystore))$/i;
const allowedExample = /(?:^|\/)(?:\.env\.example|[^/]+\.env\.example)$/i;
const findings = [];

for (const file of tracked.stdout.split("\0").filter(Boolean)) {
  if (sensitivePath.test(file) && !allowedExample.test(file)) {
    findings.push(`${file}: sensitive filename`);
    continue;
  }
  let content;
  try {
    content = readFileSync(file, "utf8");
  } catch {
    continue;
  }
  if (content.includes("\0")) continue;
  const scannable = content.replace(
    /\bsk-[A-Za-z0-9_-]*(?:secret|fake|test|example|preflight|doctor)[A-Za-z0-9_-]*\b/gi,
    "<redacted-test-fixture>",
  );
  for (const [name, pattern] of detectors) {
    pattern.lastIndex = 0;
    if (pattern.test(scannable)) findings.push(`${file}: ${name}`);
  }
  const literalRelayToken =
    /(?:fixedOperatorToken|OperatorToken)\s*(?:=|:)\s*["'](?!<|\$|%|\{)([^"']{4,})["']/g;
  if (literalRelayToken.test(content)) findings.push(`${file}: hard-coded Relay operator token`);
}

if (findings.length > 0) {
  process.stderr.write("Potential committed secrets detected (values hidden):\n");
  for (const finding of [...new Set(findings)].sort()) process.stderr.write(`- ${finding}\n`);
  process.exit(1);
}

process.stdout.write(
  `Secret check passed for ${tracked.stdout.split("\0").filter(Boolean).length} tracked files.\n`,
);

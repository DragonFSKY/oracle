import { serveRelay } from "./server.js";

function readInteger(name: string, fallback: number, allowZero = false): number {
  const value = process.env[name]?.trim();
  if (!value) return fallback;
  const parsed = Number.parseInt(value, 10);
  if (!Number.isSafeInteger(parsed) || parsed < (allowZero ? 0 : 1)) {
    throw new Error(`${name} must be ${allowZero ? "a non-negative" : "a positive"} integer.`);
  }
  return parsed;
}

await serveRelay({
  host: process.env.ORACLE_RELAY_HOST?.trim() || "127.0.0.1",
  port: readInteger("ORACLE_RELAY_PORT", 19476),
  dataDir: process.env.ORACLE_RELAY_DATA_DIR?.trim() || undefined,
  maxBodyBytes: readInteger("ORACLE_RELAY_MAX_BODY_BYTES", 256 * 1024 * 1024),
  maxAttachmentBytes: readInteger("ORACLE_RELAY_MAX_ATTACHMENT_BYTES", 0, true),
  maxTaskBytes: readInteger("ORACLE_RELAY_MAX_TASK_BYTES", 0, true),
  terminalRetentionMs: readInteger("ORACLE_RELAY_TERMINAL_RETENTION_MS", 24 * 60 * 60 * 1000),
});

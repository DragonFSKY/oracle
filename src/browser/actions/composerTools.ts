import type { BrowserLogger, ChromeClient } from "../types.js";
import { BrowserAutomationError } from "../../oracle/errors.js";
import { buildClickDispatcher } from "./domEvents.js";

export const BROWSER_COMPOSER_TOOL_IDS = ["web-search"] as const;
export type BrowserComposerToolId = (typeof BROWSER_COMPOSER_TOOL_IDS)[number];

export interface ComposerToolDefinition {
  id: BrowserComposerToolId;
  displayName: string;
  menuLabels: readonly string[];
  activeLabels: readonly string[];
}

export interface ComposerToolActivationEvidence {
  id: BrowserComposerToolId;
  menuLabel?: string;
  activeLabel?: string;
  verified: boolean;
}

export const COMPOSER_TOOL_DEFINITIONS: Record<BrowserComposerToolId, ComposerToolDefinition> = {
  "web-search": {
    id: "web-search",
    displayName: "Web Search",
    menuLabels: ["Search the web", "Web search", "搜索网页", "联网搜索"],
    activeLabels: ["Search the web", "Web search", "Search", "搜索网页", "联网搜索", "搜索"],
  },
};

type ActivationOutcome =
  | { status: "activated" | "already-active"; menuLabel?: string; activeLabel?: string }
  | { status: "plus-button-missing" }
  | { status: "dropdown-item-missing"; available?: string[] }
  | {
      status: "pill-not-confirmed";
      menuLabel?: string;
      available?: string[];
      clickPoint?: { x: number; y: number };
    };

export function normalizeBrowserComposerTools(
  values: readonly string[] | undefined,
): BrowserComposerToolId[] {
  if (!values?.length) return [];
  const result: BrowserComposerToolId[] = [];
  for (const raw of values) {
    const normalized = raw.trim().toLowerCase();
    if (!BROWSER_COMPOSER_TOOL_IDS.includes(normalized as BrowserComposerToolId)) {
      throw new Error(
        `Unsupported browser tool ${JSON.stringify(raw)}. Supported tools: ${BROWSER_COMPOSER_TOOL_IDS.join(", ")}.`,
      );
    }
    const id = normalized as BrowserComposerToolId;
    if (!result.includes(id)) result.push(id);
  }
  return result;
}

export async function activateComposerTool(
  Runtime: ChromeClient["Runtime"],
  Input: ChromeClient["Input"],
  definition: ComposerToolDefinition,
  logger: BrowserLogger,
): Promise<ComposerToolActivationEvidence> {
  const outcome = await Runtime.evaluate({
    expression: buildActivateComposerToolExpression(definition),
    awaitPromise: true,
    returnByValue: true,
  });
  let result = outcome.result?.value as ActivationOutcome | undefined;

  if (result?.status === "pill-not-confirmed") {
    if (result.clickPoint) {
      await clickTrustedPoint(Input, result.clickPoint.x, result.clickPoint.y);
    }
    const verified = await verifyComposerTool(Runtime, definition, 1_000);
    if (verified)
      result = { status: "activated", menuLabel: result.menuLabel, activeLabel: verified };
  }

  if (result?.status === "activated" || result?.status === "already-active") {
    logger(
      `${definition.displayName} ${result.status === "already-active" ? "already active" : "activated"}`,
    );
    return {
      id: definition.id,
      menuLabel: result.menuLabel,
      activeLabel: result.activeLabel,
      verified: true,
    };
  }

  const available = result && "available" in result ? result.available : undefined;
  const availableHint = available?.length ? ` Available options: ${available.join(", ")}.` : "";
  const code = result?.status ?? "unexpected-result";
  throw new BrowserAutomationError(
    result?.status === "plus-button-missing"
      ? `Could not find the composer tools button to activate ${definition.displayName}.`
      : `${definition.displayName} could not be activated (${code}).${availableHint}`,
    { stage: "composer-tool-activate", code, tool: definition.id },
  );
}

async function clickTrustedPoint(
  Input: ChromeClient["Input"],
  x: number,
  y: number,
): Promise<void> {
  if (!Input || typeof Input.dispatchMouseEvent !== "function") return;
  await Input.dispatchMouseEvent({ type: "mouseMoved", x, y });
  await Input.dispatchMouseEvent({ type: "mousePressed", x, y, button: "left", clickCount: 1 });
  await Input.dispatchMouseEvent({ type: "mouseReleased", x, y, button: "left", clickCount: 1 });
}

export async function ensureComposerToolsActiveBeforeSend(
  Runtime: ChromeClient["Runtime"],
  Input: ChromeClient["Input"],
  toolIds: readonly BrowserComposerToolId[],
  logger: BrowserLogger,
): Promise<ComposerToolActivationEvidence[]> {
  const evidence: ComposerToolActivationEvidence[] = [];
  for (const id of toolIds) {
    const definition = COMPOSER_TOOL_DEFINITIONS[id];
    const activeLabel = await verifyComposerTool(Runtime, definition, 0);
    if (activeLabel) {
      logger(`${definition.displayName} verified immediately before send`);
      evidence.push({ id, activeLabel, verified: true });
      continue;
    }
    logger(`${definition.displayName} was not active before send; activating it`);
    evidence.push(await activateComposerTool(Runtime, Input, definition, logger));
  }
  return evidence;
}

async function verifyComposerTool(
  Runtime: ChromeClient["Runtime"],
  definition: ComposerToolDefinition,
  timeoutMs: number,
): Promise<string | null> {
  const outcome = await Runtime.evaluate({
    expression: buildVerifyComposerToolExpression(definition, timeoutMs),
    awaitPromise: true,
    returnByValue: true,
  });
  return typeof outcome.result?.value === "string" ? outcome.result.value : null;
}

function buildFindActiveToolExpression(definition: ComposerToolDefinition): string {
  return `const findActiveComposerTool = () => {
    const labels = ${JSON.stringify(definition.activeLabels)}.map(value => String(value).toLowerCase());
    const normalize = value => String(value || '').replace(/\\s+/g, ' ').trim().toLowerCase();
    const visible = node => {
      const rect = node?.getBoundingClientRect?.();
      if (!rect || rect.width <= 0 || rect.height <= 0) return false;
      const style = window.getComputedStyle?.(node);
      return !style || (style.visibility !== 'hidden' && style.display !== 'none');
    };
    const roots = Array.from(document.querySelectorAll(
      '[data-testid="composer"], form:has(#prompt-textarea), form:has([contenteditable="true"])'
    )).filter(visible);
    for (const root of roots) {
      for (const node of root.querySelectorAll(
        '[data-inline-selection-pill], button.__composer-pill, [class*="composer-pill"], button[aria-pressed="true"]'
      )) {
        if (!visible(node)) continue;
        const label = String(node.textContent || node.getAttribute?.('aria-label') || '').replace(/\\s+/g, ' ').trim();
        const normalized = normalize(label);
        if (labels.some(candidate => normalized === candidate || normalized.startsWith(candidate + ' '))) {
          return label;
        }
      }
    }
    return null;
  };`;
}

function buildVerifyComposerToolExpression(
  definition: ComposerToolDefinition,
  timeoutMs: number,
): string {
  return `(async () => {
    ${buildFindActiveToolExpression(definition)}
    const deadline = Date.now() + ${JSON.stringify(Math.max(0, timeoutMs))};
    while (Date.now() < deadline) {
      const label = findActiveComposerTool();
      if (label) return label;
      await new Promise(resolve => setTimeout(resolve, 200));
    }
    return findActiveComposerTool();
  })()`;
}

function buildActivateComposerToolExpression(definition: ComposerToolDefinition): string {
  return `(async () => {
    ${buildClickDispatcher()}
    ${buildFindActiveToolExpression(definition)}
    const normalize = value => String(value || '').replace(/\\s+/g, ' ').trim().toLowerCase();
    const menuLabels = ${JSON.stringify(definition.menuLabels)}.map(normalize);
    const visible = node => {
      const rect = node?.getBoundingClientRect?.();
      if (!rect || rect.width <= 0 || rect.height <= 0) return false;
      const style = window.getComputedStyle?.(node);
      return !style || (style.visibility !== 'hidden' && style.display !== 'none');
    };
    const active = findActiveComposerTool();
    if (active) return { status: 'already-active', activeLabel: active };
    const plus = document.querySelector('[data-testid="composer-plus-btn"]') ||
      Array.from(document.querySelectorAll('button')).find(button => {
        const label = normalize(button.getAttribute?.('aria-label'));
        return label.includes('add files') || label.includes('tools');
      });
    if (!plus) return { status: 'plus-button-missing' };
    dispatchClickSequence(plus);
    await new Promise(resolve => setTimeout(resolve, 300));
    const selector = [
      '[data-radix-collection-item]', '[role="menuitem"]', '[role="menuitemradio"]',
      '[role="option"]', '[cmdk-item]', '.__menu-item', '[class*="menu-item"]'
    ].join(',');
    const candidates = Array.from(document.querySelectorAll(selector)).filter(visible);
    const available = [...new Set(candidates.map(node => String(node.textContent || '').replace(/\\s+/g, ' ').trim()).filter(Boolean))];
    const match = candidates
      .map(node => ({ node, label: String(node.textContent || node.getAttribute?.('aria-label') || '').replace(/\\s+/g, ' ').trim() }))
      .find(({ label }) => {
        const text = normalize(label);
        return menuLabels.some(candidate => text === candidate || text.startsWith(candidate + ' '));
      });
    if (!match) return { status: 'dropdown-item-missing', available };
    match.node.scrollIntoView?.({ block: 'center', inline: 'center' });
    const rect = match.node.getBoundingClientRect?.();
    const clickPoint = rect && rect.width > 0 && rect.height > 0
      ? { x: rect.left + rect.width / 2, y: rect.top + rect.height / 2 }
      : undefined;
    dispatchClickSequence(match.node);
    const deadline = Date.now() + 5000;
    while (Date.now() < deadline) {
      const label = findActiveComposerTool();
      if (label) return { status: 'activated', menuLabel: match.label, activeLabel: label };
      await new Promise(resolve => setTimeout(resolve, 200));
    }
    return { status: 'pill-not-confirmed', menuLabel: match.label, available, clickPoint };
  })()`;
}

export function buildActivateComposerToolExpressionForTest(id: BrowserComposerToolId): string {
  return buildActivateComposerToolExpression(COMPOSER_TOOL_DEFINITIONS[id]);
}

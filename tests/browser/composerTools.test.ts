import { describe, expect, it } from "vitest";
import {
  buildActivateComposerToolExpressionForTest,
  normalizeBrowserComposerTools,
} from "../../src/browser/actions/composerTools.js";

describe("browser composer tools", () => {
  it("normalizes and deduplicates allow-listed tools", () => {
    expect(normalizeBrowserComposerTools(["web-search", " WEB-SEARCH "])).toEqual(["web-search"]);
    expect(() => normalizeBrowserComposerTools(["unknown"])).toThrow(/Unsupported browser tool/);
  });

  it("builds a fail-closed Web Search activation expression", () => {
    const expression = buildActivateComposerToolExpressionForTest("web-search");
    expect(expression).toContain("composer-plus-btn");
    expect(expression).toContain("Search the web");
    expect(expression).toContain("Web search");
    expect(expression).toContain("搜索网页");
    expect(expression).toContain("dropdown-item-missing");
    expect(expression).toContain("pill-not-confirmed");
  });

  it("accepts an already-active Web Search pill without opening the menu", async () => {
    class FakeElement {
      constructor(
        public textContent: string,
        private readonly attributes: Record<string, string> = {},
        private readonly children: FakeElement[] = [],
      ) {}
      getAttribute(name: string): string | null {
        return this.attributes[name] ?? null;
      }
      getBoundingClientRect(): { width: number; height: number } {
        return { width: 100, height: 30 };
      }
      querySelectorAll(): FakeElement[] {
        return this.children;
      }
    }

    const pill = new FakeElement("Search the web");
    const composer = new FakeElement("", {}, [pill]);
    const documentStub = {
      querySelector: () => null,
      querySelectorAll: (selector: string) => {
        if (selector.includes('[data-testid="composer"]')) return [composer];
        return [];
      },
    };
    const expression = buildActivateComposerToolExpressionForTest("web-search");
    const evaluate = new Function(
      "document",
      "window",
      "Element",
      "PointerEvent",
      "MouseEvent",
      `return ${expression};`,
    );

    await expect(
      evaluate(
        documentStub,
        { getComputedStyle: () => ({ visibility: "visible", display: "block" }) },
        FakeElement,
        class {},
        class {},
      ),
    ).resolves.toEqual({ status: "already-active", activeLabel: "Search the web" });
  });
});

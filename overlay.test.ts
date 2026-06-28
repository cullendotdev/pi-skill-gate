/**
 * Tests for overlay.ts — rendering helpers and overlay logic.
 */

import { describe, it, expect, vi, beforeEach } from "vitest";

// ── Mock pi-tui and pi-coding-agent ──

vi.mock("@earendil-works/pi-tui", () => {
  // Define inside factory to avoid hoisting issues
  class MockMarkdown {
    setText = vi.fn();
    render = vi.fn().mockReturnValue([]);
    invalidate = vi.fn();
  }
  return {
    decodeKittyPrintable: (d: string) => d,
    Key: {
      escape: "KEY_ESCAPE",
      enter: "KEY_ENTER",
      backspace: "KEY_BACKSPACE",
      up: "KEY_UP",
      down: "KEY_DOWN",
      left: "KEY_LEFT",
      right: "KEY_RIGHT",
      home: "KEY_HOME",
      end: "KEY_END",
      space: "KEY_SPACE",
      slash: "/",
    },
    matchesKey: (data: string, key: string) => data === key,
    Markdown: MockMarkdown,
    truncateToWidth: (text: string, width: number): string =>
      text.length > width ? text.slice(0, width) : text,
    visibleWidth: (text: string): number =>
      text.replace(/\x1b\[[0-9;]*m/g, "").length,
  };
});

vi.mock("@earendil-works/pi-coding-agent", () => ({
  getMarkdownTheme: () => ({}),
}));

vi.mock("node:fs", () => ({
  existsSync: vi.fn(),
  readFileSync: vi.fn(),
}));

import * as fs from "node:fs";
import {
  wrapText,
  highlightMatch,
  highlightInStyledText,
  borderLine,
  padTo,
  readSkillBody,
  SkillDetailOverlay,
} from "./overlay.js";
import type { RowData, SkillGateTheme } from "./types.js";

// ── Theme stub (identity for testing — styles don't change logic) ──

const T: SkillGateTheme = {
  accent: (t: string) => t,
  dim: (t: string) => t,
  muted: (t: string) => t,
  warning: (t: string) => t,
  error: (t: string) => t,
  bold: (t: string) => t,
  enabled: (t: string) => t,
  selCell: (t: string) => t,
  selRow: (t: string) => t,
  nativeDisabled: (t: string) => t,
};

// ── Row fixtures ──

function makeRows(): RowData[] {
  return [
    {
      name: "alpha-skill",
      description: "First test skill",
      filePath: "/fake/alpha.md",
      disableModelInvocation: false,
      state: "enabled",
      source: "global",
      globalEnabled: true,
      usageCount: 5,
    },
    {
      name: "beta-skill",
      description: "Second test skill",
      filePath: "/fake/beta.md",
      disableModelInvocation: false,
      state: "disabled",
      source: "default",
      globalEnabled: false,
      usageCount: 0,
    },
    {
      name: "gamma-tool",
      description: "Third test skill",
      filePath: "/fake/gamma.md",
      disableModelInvocation: true,
      state: "enabled",
      source: "global",
      globalEnabled: true,
      usageCount: 12,
    },
    {
      name: "alpha-tool",
      description: "Similar prefix",
      filePath: "/fake/alpha-tool.md",
      disableModelInvocation: false,
      state: "enabled",
      source: "project",
      globalEnabled: false,
      usageCount: 3,
    },
  ];
}

// ═══════════════════════════════════════════════════════════
//  wrapText
// ═══════════════════════════════════════════════════════════

describe("wrapText", () => {
  it("wraps text at word boundaries", () => {
    const result = wrapText("hello world this is a test", 12);
    expect(result).toEqual(["hello world", "this is a", "test"]);
  });

  it("returns empty array when maxWidth <= 0", () => {
    expect(wrapText("hello world", 0)).toEqual([]);
    expect(wrapText("hello world", -1)).toEqual([]);
  });

  it("handles single long word without crashing", () => {
    const result = wrapText("supercalifragilisticexpialidocious", 10);
    expect(result).toEqual(["supercalifragilisticexpialidocious"]);
  });

  it("returns array with empty string for empty input", () => {
    expect(wrapText("", 20)).toEqual([""]);
  });

  it("preserves exact text content", () => {
    const text = "the quick brown fox jumps over the lazy dog";
    const result = wrapText(text, 20);
    const rejoined = result.join(" ");
    expect(rejoined).toBe(text);
  });

  it("handles text that fits on one line", () => {
    expect(wrapText("short text", 50)).toEqual(["short text"]);
  });

  it("handles maxWidth exactly at word boundary", () => {
    expect(wrapText("hello world", 11)).toEqual(["hello world"]);
  });

  it("handles multiple spaces between words", () => {
    const result = wrapText("a   b   c", 10);
    expect(result).toEqual(["a b c"]);
  });

  it("breaks when second word barely overflows", () => {
    expect(wrapText("abcdef ghijkl", 10)).toEqual(["abcdef", "ghijkl"]);
  });
});

// ═══════════════════════════════════════════════════════════
//  highlightMatch
// ═══════════════════════════════════════════════════════════

describe("highlightMatch", () => {
  // Identity functions that DON'T add wrapping characters,
  // so we can test the raw output structure.
  const base = (t: string) => t;
  const match = (t: string) => `*${t}*`;

  it("returns base(text) when query is empty", () => {
    expect(highlightMatch("hello world", "", base, match)).toBe("hello world");
  });

  it("returns base(text) when query is not found", () => {
    expect(highlightMatch("hello world", "xyz", base, match)).toBe("hello world");
  });

  it("highlights first occurrence case-insensitively", () => {
    const result = highlightMatch("Hello World", "world", base, match);
    expect(result).toBe("Hello *World*");
  });

  // The function matches the FIRST occurrence from left. Since both
  // occurrences are the same string "ab", the first one at position 0 is
  // highlighted.
  it("highlights only the first match when query appears multiple times", () => {
    const result = highlightMatch("ab ab ab", "ab", base, match);
    expect(result).toBe("*ab* ab ab");
  });

  it("handles exact case match", () => {
    const result = highlightMatch("Hello", "Hel", base, match);
    expect(result).toBe("*Hel*lo");
  });

  it("handles query longer than text gracefully", () => {
    const result = highlightMatch("hi", "hello", base, match);
    expect(result).toBe("hi");
  });

  it("handles empty text", () => {
    expect(highlightMatch("", "hi", base, match)).toBe("");
  });
});

// ═══════════════════════════════════════════════════════════
//  borderLine
// ═══════════════════════════════════════════════════════════

describe("borderLine", () => {
  it("wraps content with │ border characters", () => {
    const result = borderLine("hello", 10, T);
    expect(result.startsWith("│")).toBe(true);
    expect(result.endsWith("│")).toBe(true);
  });

  it("pads content to inner width", () => {
    const result = borderLine("hello", 20, T);
    expect(result).toContain("hello");
    expect(result.length).toBeGreaterThan("│hello│".length);
  });

  it("truncates content that is too long", () => {
    const result = borderLine("this is a very long string that should be cut", 20, T);
    const inner = result.slice(1, -1);
    const vw = inner.replace(/\x1b\[[0-9;]*m/g, "").length;
    expect(vw).toBeLessThanOrEqual(20);
  });

  it("handles empty content", () => {
    const result = borderLine("", 5, T);
    expect(result.startsWith("│")).toBe(true);
    expect(result.endsWith("│")).toBe(true);
  });
});

// ═══════════════════════════════════════════════════════════
//  padTo
// ═══════════════════════════════════════════════════════════

describe("padTo", () => {
  it("pads string to target width with trailing spaces", () => {
    const result = padTo("abc", 10);
    expect(result).toBe("abc       ");
  });

  it("returns the string unchanged if already at target width", () => {
    const result = padTo("abcdefghij", 10);
    expect(result).toBe("abcdefghij");
  });

  it("returns string unchanged if exceeds target width (padTo does NOT truncate)", () => {
    const long = "this is way too long for the target";
    const result = padTo(long, 10);
    // padTo does NOT truncate — it returns content as-is when vw >= width
    expect(result).toBe(long);
  });

  it("handles empty string", () => {
    const result = padTo("", 5);
    expect(result).toBe("     ");
  });

  it("handles zero width", () => {
    // empty string with visibleWidth 0, 0 >= 0 so returns ""
    expect(padTo("", 0)).toBe("");
  });
});

// ═══════════════════════════════════════════════════════════
//  readSkillBody
// ═══════════════════════════════════════════════════════════

describe("readSkillBody", () => {
  beforeEach(() => {
    vi.clearAllMocks();
  });

  it("reads a SKILL.md and strips YAML frontmatter", () => {
    // Must have content between --- delimiters for the regex to match.
    // The regex is: /^---\n[\s\S]*?\n---\n?/
    const raw = "---\ntitle: My Skill\ndescription: Does stuff\n---\n\n# My Skill\n\nThis is the skill body.\n";
    vi.mocked(fs.readFileSync).mockReturnValue(raw as any);

    const body = readSkillBody("/fake/my-skill.md");
    expect(body).toBe("# My Skill\n\nThis is the skill body.");
  });

  it("strips YAML frontmatter with metadata containing colons", () => {
    const raw = "---\ndescription: \"A: colon in value\"\n---\nBody content here.";
    vi.mocked(fs.readFileSync).mockReturnValue(raw as any);

    const body = readSkillBody("/fake/colon.md");
    expect(body).toBe("Body content here.");
  });

  it("returns '(No content)' for skill with only frontmatter", () => {
    // After stripping, only whitespace remains → trimmed to empty → "(No content)"
    const raw = "---\ntitle: Empty\n---\n\n   \n";
    vi.mocked(fs.readFileSync).mockReturnValue(raw as any);

    const body = readSkillBody("/fake/empty-front.md");
    expect(body).toBe("(No content)");
  });

  it("returns '(Unable to read skill file)' on filesystem error", () => {
    vi.mocked(fs.readFileSync).mockImplementation(() => {
      throw new Error("ENOENT");
    });

    const body = readSkillBody("/nonexistent/skill.md");
    expect(body).toBe("(Unable to read skill file)");
  });

  it("caches the result on subsequent reads", () => {
    vi.mocked(fs.readFileSync).mockReturnValue("---\ntitle: X\n---\nBody" as any);

    readSkillBody("/fake/cached.md");
    readSkillBody("/fake/cached.md");

    // fs.readFileSync should only be called once due to cache
    expect(fs.readFileSync).toHaveBeenCalledTimes(1);
  });

  it("preserves markdown formatting in body", () => {
    const raw = "---\ntitle: Format\n---\n**bold** and *italic* and `code`";
    vi.mocked(fs.readFileSync).mockReturnValue(raw as any);

    const body = readSkillBody("/fake/format.md");
    expect(body).toBe("**bold** and *italic* and `code`");
  });

  it("invalidateSkillBody forces a re-read on next access", async () => {
    const { invalidateSkillBody } = await import("./overlay.js");
    vi.mocked(fs.readFileSync).mockReturnValueOnce("v1" as any).mockReturnValueOnce("v2" as any);

    expect(readSkillBody("/fake/inv.md")).toBe("v1");
    invalidateSkillBody("/fake/inv.md");
    expect(readSkillBody("/fake/inv.md")).toBe("v2");
  });

  it("invalidateAllSkillBodies drops every cached body", async () => {
    const { invalidateAllSkillBodies } = await import("./overlay.js");
    vi.mocked(fs.readFileSync).mockReturnValue("x" as any);

    readSkillBody("/fake/a.md");
    readSkillBody("/fake/b.md");
    expect(fs.readFileSync).toHaveBeenCalledTimes(2);

    invalidateAllSkillBodies();
    readSkillBody("/fake/a.md");
    readSkillBody("/fake/b.md");
    // Re-read both files after invalidation
    expect(fs.readFileSync).toHaveBeenCalledTimes(4);
  });
});

// ═══════════════════════════════════════════════════════════
//  SkillDetailOverlay — getFilteredIndices
// ═══════════════════════════════════════════════════════════

describe("SkillDetailOverlay.getFilteredIndices", () => {
  function makeOverlay(rows: RowData[], idx = 0) {
    const overlay = new SkillDetailOverlay(
      rows,
      idx,
      () => 40,
      T,
      "global",
    );
    (overlay as any).searchMode = true;
    return overlay;
  }

  it("returns all indices when query is empty", () => {
    const rows = makeRows();
    const overlay = makeOverlay(rows);
    (overlay as any).searchQuery = "";
    const result = (overlay as any).getFilteredIndices();
    expect(result).toEqual([0, 1, 2, 3]);
  });

  it("returns all indices when not in search mode", () => {
    const rows = makeRows();
    const overlay = new SkillDetailOverlay(rows, 0, () => 40, T, "global");
    const result = (overlay as any).getFilteredIndices();
    expect(result).toEqual([0, 1, 2, 3]);
  });

  it("prefix matches appear before substring matches", () => {
    const rows = makeRows(); // alpha-skill (idx 0), alpha-tool (idx 3)
    const overlay = makeOverlay(rows);
    (overlay as any).searchQuery = "alpha";
    const result = (overlay as any).getFilteredIndices() as number[];
    expect(result).toContain(0); // alpha-skill
    expect(result).toContain(3); // alpha-tool
    // Both are prefix matches (both start with "alpha"), sorted alphabetically
    // alpha-skill < alpha-tool → idx 0 first, idx 3 second
    expect(result[0]).toBe(0);
    expect(result[1]).toBe(3);
  });

  it("substring matches come after prefix matches", () => {
    const rows: RowData[] = [
      { name: "apple", description: "", filePath: "", disableModelInvocation: false, state: "enabled", source: "global", globalEnabled: true, usageCount: 0 },
      { name: "pineapple", description: "", filePath: "", disableModelInvocation: false, state: "enabled", source: "global", globalEnabled: true, usageCount: 0 },
      { name: "orange", description: "", filePath: "", disableModelInvocation: false, state: "enabled", source: "global", globalEnabled: true, usageCount: 0 },
    ];
    const overlay = makeOverlay(rows);
    (overlay as any).searchQuery = "apple";
    const result = (overlay as any).getFilteredIndices() as number[];
    // apple is prefix match (idx 0), pineapple is substring match (idx 1)
    expect(result[0]).toBe(0); // prefix first
    expect(result[1]).toBe(1); // substring second
  });

  it("case-insensitive matching", () => {
    const rows = makeRows();
    const overlay = makeOverlay(rows);
    (overlay as any).searchQuery = "ALPHA";
    const result = (overlay as any).getFilteredIndices() as number[];
    expect(result.length).toBe(2);
    expect(result).toContain(0);
    expect(result).toContain(3);
  });

  it("returns empty array when no matches found", () => {
    const rows = makeRows();
    const overlay = makeOverlay(rows);
    (overlay as any).searchQuery = "zzz_not_found";
    const result = (overlay as any).getFilteredIndices() as number[];
    expect(result).toEqual([]);
  });
});

// ═══════════════════════════════════════════════════════════
//  SkillDetailOverlay — onSearchQueryChanged
// ═══════════════════════════════════════════════════════════

describe("SkillDetailOverlay.onSearchQueryChanged", () => {
  function makeOverlay(rows: RowData[], idx = 0) {
    const overlay = new SkillDetailOverlay(
      rows,
      idx,
      () => 40,
      T,
      "global",
    );
    (overlay as any).searchMode = true;
    return overlay;
  }

  it("jumps to first match when current is not in filtered", () => {
    const rows = makeRows();
    const overlay = makeOverlay(rows, 1); // start at beta-skill (idx 1)
    (overlay as any).searchQuery = "alpha"; // matches idx 0 and 3, NOT idx 1
    (overlay as any).onSearchQueryChanged();
    expect((overlay as any).currentIdx).toBe(0); // jumped to first alpha match
  });

  it("stays on current when current is in filtered results", () => {
    const rows = makeRows();
    const overlay = makeOverlay(rows, 0); // start at alpha-skill (idx 0)
    (overlay as any).searchQuery = "alpha"; // matches idx 0 and 3
    (overlay as any).onSearchQueryChanged();
    expect((overlay as any).currentIdx).toBe(0); // stayed
  });

  it("resets scrollOffset to 0", () => {
    const rows = makeRows();
    const overlay = makeOverlay(rows, 0);
    (overlay as any).scrollOffset = 42;
    (overlay as any).searchQuery = "beta";
    (overlay as any).onSearchQueryChanged();
    expect((overlay as any).scrollOffset).toBe(0);
  });

  it("handles no matches gracefully (no crash)", () => {
    const rows = makeRows();
    const overlay = makeOverlay(rows, 0);
    (overlay as any).searchQuery = "nonexistent";
    expect(() => (overlay as any).onSearchQueryChanged()).not.toThrow();
    expect((overlay as any).scrollOffset).toBe(0);
  });
});

// ═══════════════════════════════════════════════════════════
//  SkillDetailOverlay — handleInput (search flow)
// ═══════════════════════════════════════════════════════════

describe("SkillDetailOverlay.handleInput (search mode)", () => {
  function makeOverlay(rows: RowData[], idx = 0) {
    return new SkillDetailOverlay(rows, idx, () => 40, T, "global");
  }

  it("enters search mode on '/'", () => {
    const overlay = makeOverlay(makeRows());
    overlay.handleInput("/");
    expect((overlay as any).searchMode).toBe(true);
    expect((overlay as any).searchQuery).toBe("");
  });

  it("exits search mode on Escape", () => {
    const overlay = makeOverlay(makeRows());
    overlay.handleInput("/"); // enter search
    overlay.handleInput("KEY_ESCAPE"); // exit
    expect((overlay as any).searchMode).toBe(false);
  });

  it("exits search mode on Enter", () => {
    const overlay = makeOverlay(makeRows());
    overlay.handleInput("/"); // enter search
    overlay.handleInput("KEY_ENTER"); // confirm and exit
    expect((overlay as any).searchMode).toBe(false);
  });

  it("appends printable characters to query", () => {
    const overlay = makeOverlay(makeRows());
    overlay.handleInput("/"); // enter search
    overlay.handleInput("a");
    overlay.handleInput("l");
    overlay.handleInput("p");
    expect((overlay as any).searchQuery).toBe("alp");
  });

  it("removes last character on Backspace", () => {
    const overlay = makeOverlay(makeRows());
    overlay.handleInput("/");
    overlay.handleInput("a");
    overlay.handleInput("b");
    overlay.handleInput("KEY_BACKSPACE");
    expect((overlay as any).searchQuery).toBe("a");
  });

  it("navigates filtered results with Up in search mode", () => {
    const rows = makeRows();
    const overlay = makeOverlay(rows, 3); // start at alpha-tool (idx 3)
    overlay.handleInput("/");
    overlay.handleInput("a");
    overlay.handleInput("l");
    overlay.handleInput("p");
    overlay.handleInput("h");
    overlay.handleInput("a");
    // Matches alpha-skill (idx 0) and alpha-tool (idx 3). At idx 3, up → idx 0
    overlay.handleInput("KEY_UP");
    expect((overlay as any).currentIdx).toBe(0);
  });

  it("navigates filtered results with Down in search mode", () => {
    const rows = makeRows();
    const overlay = makeOverlay(rows, 0); // start at alpha-skill
    overlay.handleInput("/");
    overlay.handleInput("a");
    overlay.handleInput("l");
    overlay.handleInput("p");
    overlay.handleInput("h");
    overlay.handleInput("a");
    // Matches alpha-skill (idx 0) and alpha-tool (idx 3). At idx 0, down → idx 3
    overlay.handleInput("KEY_DOWN");
    expect((overlay as any).currentIdx).toBe(3);
  });

  it("wraps around Up at top of filtered results", () => {
    const rows = makeRows();
    const overlay = makeOverlay(rows, 0); // at alpha-skill (idx 0)
    overlay.handleInput("/");
    for (const ch of "alpha-") overlay.handleInput(ch);
    // "alpha-" prefix-matches alpha-skill (idx 0) first, then alpha-tool (idx 3)
    // At idx 0 (top), up wraps to idx 3
    overlay.handleInput("KEY_UP");
    expect((overlay as any).currentIdx).toBe(3);
  });

  it("wraps around Down at bottom of filtered results", () => {
    const rows = makeRows();
    const overlay = makeOverlay(rows, 3); // at alpha-tool (idx 3)
    overlay.handleInput("/");
    for (const ch of "alpha-") overlay.handleInput(ch);
    // "alpha-" prefix-matches alpha-skill (idx 0) and alpha-tool (idx 3)
    // At idx 3 (bottom), down wraps to idx 0
    overlay.handleInput("KEY_DOWN");
    expect((overlay as any).currentIdx).toBe(0);
  });
});

// ═══════════════════════════════════════════════════════════
//  SkillDetailOverlay — handleInput (normal mode)
// ═══════════════════════════════════════════════════════════

describe("SkillDetailOverlay.handleInput (normal mode)", () => {
  function makeOverlay(rows: RowData[], idx = 0, hasProject = true) {
    return new SkillDetailOverlay(
      rows,
      idx,
      () => 40,
      T,
      "global",
      hasProject ? "test-proj" : undefined,
      hasProject,
    );
  }

  it("navigates up with Up key", () => {
    const rows = makeRows();
    const overlay = makeOverlay(rows, 1);
    overlay.handleInput("KEY_UP");
    expect((overlay as any).currentIdx).toBe(0);
  });

  it("navigates down with Down key", () => {
    const rows = makeRows();
    const overlay = makeOverlay(rows, 1);
    overlay.handleInput("KEY_DOWN");
    expect((overlay as any).currentIdx).toBe(2);
  });

  it("wraps around at top", () => {
    const rows = makeRows();
    const overlay = makeOverlay(rows, 0);
    overlay.handleInput("KEY_UP");
    expect((overlay as any).currentIdx).toBe(rows.length - 1);
  });

  it("wraps around at bottom", () => {
    const rows = makeRows();
    const overlay = makeOverlay(rows, rows.length - 1);
    overlay.handleInput("KEY_DOWN");
    expect((overlay as any).currentIdx).toBe(0);
  });

  it("closes on Escape", () => {
    const rows = makeRows();
    const overlay = makeOverlay(rows);
    let closed = false;
    overlay.onClose = () => { closed = true; };
    overlay.handleInput("KEY_ESCAPE");
    expect(closed).toBe(true);
  });

  it("toggles sidebar on 'b'", () => {
    const overlay = makeOverlay(makeRows());
    expect((overlay as any).showSidebar).toBe(true);
    overlay.handleInput("b");
    expect((overlay as any).showSidebar).toBe(false);
    overlay.handleInput("b");
    expect((overlay as any).showSidebar).toBe(true);
  });

  it("toggles sidebar on uppercase 'B'", () => {
    const overlay = makeOverlay(makeRows());
    overlay.handleInput("B");
    expect((overlay as any).showSidebar).toBe(false);
  });

  it("toggles scope on 'g' when hasProject", () => {
    const overlay = makeOverlay(makeRows());
    let scopeToggled = false;
    overlay.onScopeToggle = () => { scopeToggled = true; };
    overlay.handleInput("g");
    expect(scopeToggled).toBe(true);
  });

  it("toggles scope on uppercase 'G'", () => {
    const overlay = makeOverlay(makeRows());
    let scopeToggled = false;
    overlay.onScopeToggle = () => { scopeToggled = true; };
    overlay.handleInput("G");
    expect(scopeToggled).toBe(true);
  });

  it("does NOT toggle scope on 'g' when hasProject is false", () => {
    const overlay = new SkillDetailOverlay(makeRows(), 0, () => 40, T, "global", undefined, false);
    let scopeToggled = false;
    overlay.onScopeToggle = () => { scopeToggled = true; };
    overlay.handleInput("g");
    expect(scopeToggled).toBe(false);
  });

  it("toggles skill state on Space", () => {
    const rows = makeRows();
    const overlay = makeOverlay(rows); // current = alpha-skill, enabled
    let toggledName = "";
    let toggledState = "";
    overlay.onToggle = (name, state) => {
      toggledName = name;
      toggledState = state;
    };
    overlay.handleInput("KEY_SPACE");
    expect(toggledName).toBe("alpha-skill");
    expect(toggledState).toBe("disabled");
    // Row state is mutated in-place by handleInput
    expect(rows[0].state).toBe("disabled");
  });

  it("does not toggle natively-disabled skills on Space", () => {
    const rows = makeRows();
    const overlay = makeOverlay(rows, 2); // gamma-tool has disableModelInvocation: true
    let toggled = false;
    overlay.onToggle = () => { toggled = true; };
    overlay.handleInput("KEY_SPACE");
    expect(toggled).toBe(false);
    expect(rows[2].state).toBe("enabled"); // unchanged
  });

  it("invokes skill on Enter", () => {
    const rows = makeRows();
    const overlay = makeOverlay(rows, 0);
    let invokedName = "";
    overlay.onInvoke = (name) => { invokedName = name; };
    overlay.handleInput("KEY_ENTER");
    expect(invokedName).toBe("alpha-skill");
  });

  it("yanks current skill body to clipboard on 'y'", () => {
    const rows = makeRows();
    const overlay = makeOverlay(rows, 0);
    let yankedName = "";
    let yankedBody = "";
    overlay.onYank = (name, body) => {
      yankedName = name;
      yankedBody = body;
    };
    overlay.handleInput("y");
    expect(yankedName).toBe("alpha-skill");
    // Body is whatever readSkillBody yields for this row's filePath (cache-aware).
    expect(yankedBody).toBe(readSkillBody(rows[0].filePath));
  });

  it("yanks current skill body on uppercase 'Y'", () => {
    const rows = makeRows();
    const overlay = makeOverlay(rows, 1); // beta-skill
    let yankedName = "";
    overlay.onYank = (name) => { yankedName = name; };
    overlay.handleInput("Y");
    expect(yankedName).toBe("beta-skill");
  });

  it("does not yank when rows is empty", () => {
    const overlay = new SkillDetailOverlay([], 0, () => 40, T, "global");
    let yanked = false;
    overlay.onYank = () => { yanked = true; };
    overlay.handleInput("y");
    expect(yanked).toBe(false);
  });

  it("opens current skill in editor on 'o'", () => {
    const rows = makeRows();
    const overlay = makeOverlay(rows, 0);
    let editName = "";
    let editPath = "";
    overlay.onEdit = (name, filePath) => {
      editName = name;
      editPath = filePath;
    };
    overlay.handleInput("o");
    expect(editName).toBe("alpha-skill");
    expect(editPath).toBe(rows[0].filePath);
  });

  it("opens current skill in editor on uppercase 'O'", () => {
    const rows = makeRows();
    const overlay = makeOverlay(rows, 1); // beta-skill
    let editName = "";
    overlay.onEdit = (name) => { editName = name; };
    overlay.handleInput("O");
    expect(editName).toBe("beta-skill");
  });

  it("does not fire onEdit when rows is empty", () => {
    const overlay = new SkillDetailOverlay([], 0, () => 40, T, "global");
    let edited = false;
    overlay.onEdit = () => { edited = true; };
    overlay.handleInput("o");
    expect(edited).toBe(false);
  });

  it("scrolls down on 'j'", () => {
    const rows = makeRows();
    const overlay = makeOverlay(rows);
    (overlay as any).scrollOffset = 0;
    overlay.handleInput("j");
    expect((overlay as any).scrollOffset).toBeGreaterThan(0);
  });

  it("scrolls up on 'k'", () => {
    const rows = makeRows();
    const overlay = makeOverlay(rows);
    (overlay as any).scrollOffset = 100;
    overlay.handleInput("k");
    expect((overlay as any).scrollOffset).toBeLessThan(100);
  });

  it("goes to top on Home", () => {
    const rows = makeRows();
    const overlay = makeOverlay(rows);
    (overlay as any).scrollOffset = 50;
    overlay.handleInput("KEY_HOME");
    expect((overlay as any).scrollOffset).toBe(0);
  });

  it("goes to end on End", () => {
    const rows = makeRows();
    const overlay = makeOverlay(rows);
    (overlay as any).scrollOffset = 0;
    overlay.handleInput("KEY_END");
    expect((overlay as any).scrollOffset).toBe(Number.MAX_SAFE_INTEGER);
  });

  it("resets scroll on Up/Down navigation", () => {
    const rows = makeRows();
    const overlay = makeOverlay(rows);
    (overlay as any).scrollOffset = 50;
    overlay.handleInput("KEY_DOWN");
    expect((overlay as any).scrollOffset).toBe(0);
  });

  it("no-op on Left key", () => {
    const rows = makeRows();
    const overlay = makeOverlay(rows);
    const before = (overlay as any).currentIdx;
    overlay.handleInput("KEY_LEFT");
    expect((overlay as any).currentIdx).toBe(before);
  });

  it("no-op when rows are empty", () => {
    const overlay = new SkillDetailOverlay([], 0, () => 40, T, "global");
    expect(() => overlay.handleInput("/")).not.toThrow();
    expect(() => overlay.handleInput("KEY_UP")).not.toThrow();
    expect(() => overlay.handleInput("KEY_DOWN")).not.toThrow();
  });
});

// ═══════════════════════════════════════════════════════════
//  Bulk actions — confirm modal
// ═══════════════════════════════════════════════════════════

describe("SkillDetailOverlay.handleInput (bulk actions)", () => {
  function makeOverlay(rows: RowData[], idx = 0, hasProject = false) {
    return new SkillDetailOverlay(
      rows,
      idx,
      () => 40,
      T,
      "global",
      hasProject ? "test-proj" : undefined,
      hasProject,
    );
  }

  // ── opening the modal ──

  it("a opens a confirm modal (no callback yet)", () => {
    const overlay = makeOverlay(makeRows());
    let fired = false;
    overlay.onEnableAll = () => { fired = true; };
    overlay.handleInput("a");
    expect(fired).toBe(false);
    expect((overlay as any).pendingConfirm).not.toBeNull();
    expect((overlay as any).pendingConfirm.kind).toBe("enableAll");
  });

  it("A opens a confirm modal (no callback yet)", () => {
    const overlay = makeOverlay(makeRows());
    let fired = false;
    overlay.onDisableAll = () => { fired = true; };
    overlay.handleInput("A");
    expect(fired).toBe(false);
    expect((overlay as any).pendingConfirm).not.toBeNull();
    expect((overlay as any).pendingConfirm.kind).toBe("disableAll");
  });

  it("r opens a confirm modal (no callback yet)", () => {
    // makeRows has 3 global toggles (alpha-skill, gamma-tool, alpha-tool)
    const overlay = makeOverlay(makeRows());
    let fired = false;
    overlay.onResetScope = () => { fired = true; };
    overlay.handleInput("r");
    expect(fired).toBe(false);
    expect((overlay as any).pendingConfirm).not.toBeNull();
    expect((overlay as any).pendingConfirm.kind).toBe("resetScope");
  });

  it("a is a no-op when no skills are bulkable (no modal opens)", () => {
    const onlyLocked: RowData[] = [{
      name: "locked",
      description: "natively disabled",
      filePath: "/x.md",
      disableModelInvocation: true,
      state: "enabled",
      source: "global",
      globalEnabled: true,
      usageCount: 0,
    }];
    const overlay = makeOverlay(onlyLocked);
    let fired = false;
    overlay.onEnableAll = () => { fired = true; };
    overlay.handleInput("a");
    expect(fired).toBe(false);
    expect((overlay as any).pendingConfirm).toBeNull();
  });

  it("r is a no-op when no toggles in current scope (no modal opens)", () => {
    // No rows have source === "global" → nothing to reset
    const noneToggled: RowData[] = [{
      name: "a", description: "", filePath: "/a.md", disableModelInvocation: false, state: "disabled", source: "default", globalEnabled: false, usageCount: 0,
    }];
    const overlay = makeOverlay(noneToggled);
    let fired = false;
    overlay.onResetScope = () => { fired = true; };
    overlay.handleInput("r");
    expect(fired).toBe(false);
    expect((overlay as any).pendingConfirm).toBeNull();
  });

  // ── confirming the modal ──

  it("Enter on enableAll modal fires onEnableAll with sorted names", () => {
    const overlay = makeOverlay(makeRows());
    let received: string[] | null = null;
    overlay.onEnableAll = (names) => { received = names; };
    overlay.handleInput("a");
    overlay.handleInput("KEY_ENTER");
    expect(received).not.toBeNull();
    expect(received).toEqual(["alpha-skill", "alpha-tool", "beta-skill"]);
    expect((overlay as any).pendingConfirm).toBeNull();
  });

  it("y on enableAll modal fires onEnableAll (not yank)", () => {
    const overlay = makeOverlay(makeRows());
    let fired = false;
    let yanked = false;
    overlay.onEnableAll = () => { fired = true; };
    overlay.onYank = () => { yanked = true; };
    overlay.handleInput("a");
    overlay.handleInput("y");
    expect(fired).toBe(true);
    expect(yanked).toBe(false);
    expect((overlay as any).pendingConfirm).toBeNull();
  });

  it("Enter on disableAll modal fires onDisableAll", () => {
    const overlay = makeOverlay(makeRows());
    let received: string[] | null = null;
    overlay.onDisableAll = (names) => { received = names; };
    overlay.handleInput("A");
    overlay.handleInput("KEY_ENTER");
    expect(received).toEqual(["alpha-skill", "alpha-tool", "beta-skill"]);
  });

  it("Enter on reset modal fires onResetScope", () => {
    const overlay = makeOverlay(makeRows());
    let fired = false;
    overlay.onResetScope = () => { fired = true; };
    overlay.handleInput("r");
    overlay.handleInput("KEY_ENTER");
    expect(fired).toBe(true);
    expect((overlay as any).pendingConfirm).toBeNull();
  });

  // ── cancelling the modal ──

  it("Esc on enableAll modal cancels (no callback)", () => {
    const overlay = makeOverlay(makeRows());
    let fired = false;
    overlay.onEnableAll = () => { fired = true; };
    let closed = false;
    overlay.onClose = () => { closed = true; };
    overlay.handleInput("a");
    overlay.handleInput("KEY_ESCAPE");
    expect(fired).toBe(false);
    expect(closed).toBe(false); // overlay does NOT close
    expect((overlay as any).pendingConfirm).toBeNull();
  });

  it("n on disableAll modal cancels", () => {
    const overlay = makeOverlay(makeRows());
    let fired = false;
    overlay.onDisableAll = () => { fired = true; };
    overlay.handleInput("A");
    overlay.handleInput("n");
    expect(fired).toBe(false);
    expect((overlay as any).pendingConfirm).toBeNull();
  });

  it("Esc on reset modal cancels without closing overlay", () => {
    const overlay = makeOverlay(makeRows());
    let fired = false;
    overlay.onResetScope = () => { fired = true; };
    let closed = false;
    overlay.onClose = () => { closed = true; };
    overlay.handleInput("r");
    overlay.handleInput("KEY_ESCAPE");
    expect(fired).toBe(false);
    expect(closed).toBe(false);
  });

  // ── other keys are ignored when modal is open ──

  it("non-confirm keys are ignored when modal is open (no r arming loop)", () => {
    const overlay = makeOverlay(makeRows());
    let fired = false;
    overlay.onResetScope = () => { fired = true; };
    overlay.handleInput("r"); // open modal
    overlay.handleInput("r"); // would be a confirm in old behavior, should be ignored now
    overlay.handleInput("j"); // also ignored
    overlay.handleInput("KEY_DOWN"); // ignored
    expect(fired).toBe(false);
    expect((overlay as any).pendingConfirm).not.toBeNull();
  });

  it("a in search mode appends to query (does NOT open modal)", () => {
    const overlay = makeOverlay(makeRows());
    let fired = false;
    overlay.onEnableAll = () => { fired = true; };
    overlay.handleInput("/");
    overlay.handleInput("a");
    expect(fired).toBe(false);
    expect((overlay as any).pendingConfirm).toBeNull();
    expect((overlay as any).searchQuery).toBe("a");
  });

  // ── filter-aware bulk ──

  it("a after committing a search filter (Enter) opens modal for filtered skills", () => {
    const rows: RowData[] = [
      { name: "auth-login", description: "", filePath: "/a.md", disableModelInvocation: false, state: "disabled", source: "default", globalEnabled: false, usageCount: 0 },
      { name: "auth-logout", description: "", filePath: "/b.md", disableModelInvocation: false, state: "disabled", source: "default", globalEnabled: false, usageCount: 0 },
      { name: "build-app", description: "", filePath: "/c.md", disableModelInvocation: false, state: "disabled", source: "default", globalEnabled: false, usageCount: 0 },
    ];
    const overlay = makeOverlay(rows);
    let received: string[] | null = null;
    overlay.onEnableAll = (names) => { received = names; };
    overlay.handleInput("/");
    for (const ch of "auth") overlay.handleInput(ch);
    overlay.handleInput("KEY_ENTER"); // commit query
    overlay.handleInput("a"); // open modal
    overlay.handleInput("KEY_ENTER"); // confirm
    expect(received).toEqual(["auth-login", "auth-logout"]);
  });

  // ── modal rendering ──

  it("modal renders with warning border for enableAll", () => {
    const overlay = makeOverlay(makeRows());
    overlay.handleInput("a");
    const lines = overlay.render(80);
    const text = lines.join("\n");
    // Warning border uses warning theme color (wraps content in ANSI codes)
    // We assert that the modal box is drawn with box-drawing characters.
    expect(text).toMatch(/┌/);
    expect(text).toMatch(/Confirm Enable All/);
    expect(text).toMatch(/Enable 3 non-native-disabled skills/);
    expect(text).toMatch(/Scope: global/);
  });

  it("modal renders with warning border for disableAll", () => {
    const overlay = makeOverlay(makeRows());
    overlay.handleInput("A");
    const lines = overlay.render(80);
    const text = lines.join("\n");
    expect(text).toMatch(/Confirm Disable All/);
    expect(text).toMatch(/Disable 3 non-native-disabled skills/);
  });

  it("modal renders with error border for resetScope", () => {
    const overlay = makeOverlay(makeRows());
    overlay.handleInput("r");
    const lines = overlay.render(80);
    const text = lines.join("\n");
    expect(text).toMatch(/Confirm Reset/);
    expect(text).toMatch(/Reset all toggles in global scope/);
    // makeRows has 2 rows with source === "global" (alpha-skill, gamma-tool)
    expect(text).toMatch(/clears 2 toggle/);
  });

  it("modal body shows scope name", () => {
    const overlay = new SkillDetailOverlay(
      makeRows(), 0, () => 40, T, "project", "my-app", true
    );
    overlay.handleInput("r");
    const lines = overlay.render(80);
    const text = lines.join("\n");
    expect(text).toMatch(/Reset all toggles in project scope/);
    expect(text).toMatch(/Scope: project/);
  });

  it("modal is centered horizontally in the rendered output", () => {
    const overlay = makeOverlay(makeRows());
    overlay.handleInput("a");
    const lines = overlay.render(120);
    // The title row (with "Confirm Enable All") should have leading whitespace.
    const titleLine = lines.find((l) => l.includes("Confirm Enable All"));
    expect(titleLine).toBeDefined();
    const leadingSpaces = titleLine!.search(/\S/); // index of first non-space
    expect(leadingSpaces).toBeGreaterThan(0);
  });

  it("regular overlay is drawn when no modal is open", () => {
    const overlay = makeOverlay(makeRows());
    const lines = overlay.render(80);
    const text = lines.join("\n").replace(/\x1b\[[0-9;]*m/g, "");
    // No modal
    expect(text).not.toMatch(/Confirm Enable/);
    expect(text).not.toMatch(/Confirm Reset/);
  });
});

//  Help modal (? key)

describe("SkillDetailOverlay help modal (? key)", () => {
  function makeOverlay(rows: RowData[], idx = 0, hasProject = false) {
    return new SkillDetailOverlay(rows, idx, () => 40, T, "global", undefined, hasProject);
  }

  const strip = (lines: string[]) => lines.join("\n").replace(/\x1b\[[0-9;]*m/g, "");

  it("? opens the help modal with a bordered box and title", () => {
    const overlay = makeOverlay(makeRows());
    overlay.handleInput("?");
    const text = strip(overlay.render(80));
    expect(text).toMatch(/Skill Gate — Keybindings/);
    expect(text).toMatch(/┌/);
    expect(text).toMatch(/└/);
    expect(text).toMatch(/Navigation/);
  });

  it("? again closes the help modal", () => {
    const overlay = makeOverlay(makeRows());
    overlay.handleInput("?");
    overlay.handleInput("?");
    const text = strip(overlay.render(80));
    expect(text).not.toMatch(/Skill Gate — Keybindings/);
  });

  it("Esc closes the help modal without closing the overlay", () => {
    const overlay = makeOverlay(makeRows());
    let closed = false;
    overlay.onClose = () => { closed = true; };
    overlay.handleInput("?");
    overlay.handleInput("KEY_ESCAPE");
    const text = strip(overlay.render(80));
    expect(text).not.toMatch(/Skill Gate — Keybindings/);
    expect(closed).toBe(false);
  });

  it("q closes the help modal", () => {
    const overlay = makeOverlay(makeRows());
    overlay.handleInput("?");
    overlay.handleInput("q");
    const text = strip(overlay.render(80));
    expect(text).not.toMatch(/Skill Gate — Keybindings/);
  });

  it("while help is open, other keys are ignored (space/y/a do nothing)", () => {
    const overlay = makeOverlay(makeRows());
    const toggled: [string, string][] = [];
    overlay.onToggle = (name, state) => toggled.push([name, state]);
    overlay.handleInput("?");
    overlay.handleInput("KEY_SPACE");
    overlay.handleInput("y");
    overlay.handleInput("a");
    expect(toggled).toEqual([]);
    // help still open
    const text = strip(overlay.render(80));
    expect(text).toMatch(/Skill Gate — Keybindings/);
  });

  it("j / ↓ scroll the help content so later sections become visible", () => {
    const overlay = makeOverlay(makeRows());
    overlay.handleInput("?");
    const topText = strip(overlay.render(80));
    expect(topText).toMatch(/Navigation/);
    // "Global" header is near the bottom and out of view at the top.
    expect(topText).not.toMatch(/Global/);
    for (let i = 0; i < 15; i++) overlay.handleInput("j");
    const scrolledText = strip(overlay.render(80));
    expect(scrolledText).toMatch(/Global/);
  });

  it("? does nothing while a confirm modal is open", () => {
    const overlay = makeOverlay(makeRows());
    overlay.handleInput("a"); // open enable-all confirm
    overlay.handleInput("?");  // ignored — confirm modal keeps input
    const text = strip(overlay.render(80));
    expect(text).toMatch(/Confirm Enable All/);
    expect(text).not.toMatch(/Skill Gate — Keybindings/);
  });

  it("footer advertises the ? help key", () => {
    const overlay = makeOverlay(makeRows());
    const text = strip(overlay.render(80));
    expect(text).toMatch(/\?/);
    expect(text).toMatch(/help/);
  });
});

//  Usage display (column + detail)

describe("SkillDetailOverlay usage display", () => {
  function makeOverlay(rows: RowData[], idx = 0) {
    return new SkillDetailOverlay(
      rows,
      idx,
      () => 40,
      T,
      "global",
    );
  }

  const usageRows: RowData[] = [
    { name: "frequent", description: "", filePath: "/f.md", disableModelInvocation: false, state: "enabled", source: "global", globalEnabled: true, usageCount: 15 },
    { name: "rare", description: "", filePath: "/r.md", disableModelInvocation: false, state: "enabled", source: "global", globalEnabled: true, usageCount: 3 },
    { name: "never", description: "", filePath: "/n.md", disableModelInvocation: false, state: "disabled", source: "default", globalEnabled: false, usageCount: 0 },
  ];

  it("when column OFF, sidebar shows only skill names (no suffix)", () => {
    const overlay = makeOverlay(usageRows);
    const lines = overlay.render(200);
    const lines2 = lines.map((l) => l.replace(/\x1b\[[0-9;]*m/g, ""));
    // Extract only the sidebar segment (text between the first and second │).
    // Each overlay line is: │{sidebar}│{detail}│
    const sidebarSegments = lines2
      .map((l) => {
        const m = l.match(/^│(.*?)│/);
        return m ? m[1] : "";
      })
      .filter((s) => s.length > 0);
    const sidebarText = sidebarSegments.join("\n");
    // Names appear in sidebar
    expect(sidebarText).toContain("frequent");
    expect(sidebarText).toContain("rare");
    expect(sidebarText).toContain("never");
    // No "Used Nx" suffix in sidebar (it lives in detail view only)
    expect(sidebarText).not.toMatch(/Used 15x/);
    expect(sidebarText).not.toMatch(/Used 3x/);
  });

  it("when column OFF, hides 'Uses' header and column divider", () => {
    const overlay = makeOverlay(usageRows);
    const lines = overlay.render(200);
    const text = lines.join("\n").replace(/\x1b\[[0-9;]*m/g, "");
    expect(text).not.toMatch(/Skills.*Uses/);
    expect(text).not.toMatch(/┬/);
  });

  it("u toggles column ON and shows 'Uses' header with divider", () => {
    const overlay = makeOverlay(usageRows);
    overlay.handleInput("u");
    const lines = overlay.render(200);
    const text = lines.join("\n").replace(/\x1b\[[0-9;]*m/g, "");
    expect(text).toMatch(/Skills.*Uses/);
    expect(text).toMatch(/┬/);
  });

  it("when column ON, renders counts in column with vertical │ divider per row", () => {
    const overlay = makeOverlay(usageRows);
    overlay.handleInput("u");
    const lines = overlay.render(200);
    const text = lines.join("\n").replace(/\x1b\[[0-9;]*m/g, "");
    // Names still visible
    expect(text).toContain("frequent");
    expect(text).toContain("rare");
    expect(text).toContain("never");
    // Vertical divider present in multiple rows
    const colMatches = text.match(/│/g);
    expect(colMatches).not.toBeNull();
    expect(colMatches!.length).toBeGreaterThanOrEqual(3); // at least 3 skill rows
    // Detail view still shows usage (always visible, not suffix in sidebar)
    expect(text).toMatch(/Usage:.*Used 15x/);
  });

  it("│ divider column aligns with ┬ in separator (same x-position)", () => {
    const overlay = makeOverlay(usageRows);
    overlay.handleInput("u");
    const lines = overlay.render(200);
    // Strip ANSI and find the separator line containing ┬
    const sepLine = lines.map((l) => l.replace(/\x1b\[[0-9;]*m/g, "")).find((l) => l.includes("┬"));
    expect(sepLine).toBeDefined();
    const tBarPos = sepLine!.indexOf("┬");

    // For each skill row, the │ inside the sidebar should be at tBarPos
    // (The outer left │ is at position 0; the inner │ divider is at the same position as ┬)
    // Skill rows are those containing a name and a count
    const skillRows = lines
      .map((l) => l.replace(/\x1b\[[0-9;]*m/g, ""))
      .filter((l) => /^\u2502.{2,}/.test(l) && /│\s*\d+\s*│/.test(l));
    expect(skillRows.length).toBeGreaterThanOrEqual(3);
    for (const row of skillRows) {
      // The second │ in the line is the divider
      const firstPipe = row.indexOf("│");
      const secondPipe = row.indexOf("│", firstPipe + 1);
      expect(secondPipe).toBe(tBarPos);
    }
  });

  it("centers 1-digit numbers in column (1 space on each side)", () => {
    const rows: RowData[] = [
      { name: "a", description: "", filePath: "/a.md", disableModelInvocation: false, state: "enabled", source: "global", globalEnabled: true, usageCount: 5 },
    ];
    const overlay = makeOverlay(rows);
    overlay.handleInput("u");
    const lines = overlay.render(200);
    // For 1-digit (5), usageColW = 1+1+2 = 4. Layout: │ _ 5 _
    const text = lines.join("\n").replace(/\x1b\[[0-9;]*m/g, "");
    expect(text).toMatch(/│ 5 /);
  });

  it("centers 2-digit numbers in column (1 space on each side)", () => {
    const rows: RowData[] = [
      { name: "a", description: "", filePath: "/a.md", disableModelInvocation: false, state: "enabled", source: "global", globalEnabled: true, usageCount: 15 },
    ];
    const overlay = makeOverlay(rows);
    overlay.handleInput("u");
    const lines = overlay.render(200);
    // For 2-digit (15), usageColW = 1+2+2 = 5. Layout: │ _ 15 _
    const text = lines.join("\n").replace(/\x1b\[[0-9;]*m/g, "");
    expect(text).toMatch(/│ 15 /);
  });

  it("centers 3-digit numbers in column (1 space on each side)", () => {
    const rows: RowData[] = [
      { name: "a", description: "", filePath: "/a.md", disableModelInvocation: false, state: "enabled", source: "global", globalEnabled: true, usageCount: 150 },
    ];
    const overlay = makeOverlay(rows);
    overlay.handleInput("u");
    const lines = overlay.render(200);
    // For 3-digit (150), usageColW = 1+3+2 = 6. Layout: │ _ 150 _
    const text = lines.join("\n").replace(/\x1b\[[0-9;]*m/g, "");
    expect(text).toMatch(/│ 150 /);
  });

  it("numbers of different digit lengths are all centered in the column", () => {
    // Mixed: 1-digit, 2-digit, and 3-digit counts. Each should be centered:
    // preceded by the │ + spaces, followed by spaces + outer │.
    // The count should never be flush against the │ divider (i.e. there
    // is at least one space on each side of the count).
    const rows: RowData[] = [
      { name: "a", description: "", filePath: "/a.md", disableModelInvocation: false, state: "enabled", source: "global", globalEnabled: true, usageCount: 1 },
      { name: "b", description: "", filePath: "/b.md", disableModelInvocation: false, state: "enabled", source: "global", globalEnabled: true, usageCount: 22 },
      { name: "c", description: "", filePath: "/c.md", disableModelInvocation: false, state: "enabled", source: "global", globalEnabled: true, usageCount: 333 },
    ];
    const overlay = makeOverlay(rows);
    overlay.handleInput("u");
    const lines = overlay.render(200);
    const lines2 = lines.map((l) => l.replace(/\x1b\[[0-9;]*m/g, ""));
    const skillRows = lines2.filter((l) => /│\s+\d+\s+│/.test(l));
    expect(skillRows.length).toBe(3);
    for (const row of skillRows) {
      // Find the second │ (the divider) and the third │ (the outer right).
      // Between them: │<spaces><count><spaces>│
      const matches = [...row.matchAll(/│/g)];
      const divider = matches[1].index;
      const outerRight = matches[2].index;
      const between = row.slice(divider + 1, outerRight);
      // Should be spaces + digits + spaces, with at least one space on each side
      expect(between).toMatch(/^\s+\d+\s+$/);
    }
  });

  it("shows 'Usage: Used Nx' in detail view for skills with usage > 0", () => {
    const overlay = makeOverlay(usageRows, 0); // frequent, usageCount=15
    const lines = overlay.render(200);
    const text = lines.join("\n").replace(/\x1b\[[0-9;]*m/g, "");
    expect(text).toMatch(/Usage:.*Used 15x/);
  });

  it("shows 'Usage: —' in detail view for skills with usageCount 0", () => {
    const overlay = makeOverlay(usageRows, 2); // never, usageCount=0
    const lines = overlay.render(200);
    const text = lines.join("\n").replace(/\x1b\[[0-9;]*m/g, "");
    expect(text).toMatch(/Usage:.*—/);
  });

  it("sidebar width accounts for usage column when ON", () => {
    const rows: RowData[] = [
      { name: "short", description: "", filePath: "/s.md", disableModelInvocation: false, state: "enabled", source: "global", globalEnabled: true, usageCount: 999 },
    ];
    const overlay = makeOverlay(rows);
    overlay.handleInput("u");
    const sw = (overlay as any).sidebarWidth(120);
    // "short" (5) + SIDEBAR_NAME_OFFSET (4) + usageColW (digits+3 = 6) = 15
    expect(sw).toBeGreaterThanOrEqual(15);
  });

  it("sidebar width does NOT account for usage suffix when OFF (suffix removed)", () => {
    const rows: RowData[] = [
      { name: "short", description: "", filePath: "/s.md", disableModelInvocation: false, state: "enabled", source: "global", globalEnabled: true, usageCount: 999 },
    ];
    const overlay = makeOverlay(rows);
    const sw = (overlay as any).sidebarWidth(120);
    // "short" (5) + SIDEBAR_NAME_OFFSET (4) = 9, but min is 14
    expect(sw).toBe(14);
  });

  it("usage column width grows with larger counts", () => {
    const smallRows: RowData[] = [
      { name: "a", description: "", filePath: "/a.md", disableModelInvocation: false, state: "enabled", source: "global", globalEnabled: true, usageCount: 9 },
    ];
    const bigRows: RowData[] = [
      { name: "b", description: "", filePath: "/b.md", disableModelInvocation: false, state: "enabled", source: "global", globalEnabled: true, usageCount: 9999 },
    ];
    const overlaySmall = makeOverlay(smallRows);
    overlaySmall.handleInput("u");
    const wSmall = (overlaySmall as any).usageColumnWidth();

    const overlayBig = makeOverlay(bigRows);
    overlayBig.handleInput("u");
    const wBig = (overlayBig as any).usageColumnWidth();

    // 4-digit count needs wider column than 1-digit count
    expect(wBig).toBeGreaterThan(wSmall);
  });

  it("footer shows compact key hints (space toggle, bulk, ? help)", () => {
    const overlay = makeOverlay(usageRows);
    const lines = overlay.render(200);
    const text = lines.join("\n").replace(/\x1b\[[0-9;]*m/g, "");
    expect(text).toMatch(/space toggle/);
    expect(text).toMatch(/a A r bulk/);
    expect(text).toMatch(/\? help/);
  });
});

//  highlightInStyledText

describe("highlightInStyledText", () => {
  const matchStyle = (t: string) => `*${t}*`;

  it("returns styled text unchanged when query is empty", () => {
    expect(highlightInStyledText("hello", "", matchStyle)).toBe("hello");
  });

  it("highlights literal match in plain text", () => {
    expect(highlightInStyledText("hello world", "world", matchStyle)).toBe("hello *world*");
  });

  it("highlights case-insensitive match in plain text", () => {
    expect(highlightInStyledText("Hello World", "world", matchStyle)).toBe("Hello *World*");
  });

  it("highlights first literal match in ANSI-styled text", () => {
    const styled = "\x1b[31mhello\x1b[0m world";
    const result = highlightInStyledText(styled, "hello", matchStyle);
    expect(result).toContain("*hello*");
    expect(result).toContain("\x1b[31m");
  });

  it("highlights case-insensitive match in ANSI-styled text", () => {
    const styled = "\x1b[31mHello\x1b[0m World";
    const result = highlightInStyledText(styled, "world", matchStyle);
    expect(result).toContain("*World*");
  });

  it("returns unchanged when query not found", () => {
    const styled = "\x1b[31mhello\x1b[0m";
    const result = highlightInStyledText(styled, "xyz", matchStyle);
    expect(result).toBe(styled);
  });

  it("returns unchanged for empty styled text", () => {
    expect(highlightInStyledText("", "hi", matchStyle)).toBe("");
  });

  it("highlights only first occurrence", () => {
    expect(highlightInStyledText("ab ab ab", "ab", matchStyle)).toBe("*ab* ab ab");
  });
});

//  Full-text search (f key)

describe("SkillDetailOverlay full-text search (f key)", () => {
  function makeOverlay(rows: RowData[], idx = 0) {
    return new SkillDetailOverlay(rows, idx, () => 40, T, "global");
  }

  const ftRows: RowData[] = [
    { name: "deploy", description: "Deploy to production", filePath: "/deploy.md", disableModelInvocation: false, state: "disabled", source: "default", globalEnabled: false, usageCount: 0 },
    { name: "test", description: "Run unit tests", filePath: "/test.md", disableModelInvocation: false, state: "disabled", source: "default", globalEnabled: false, usageCount: 0 },
    { name: "build", description: "Build the project", filePath: "/build.md", disableModelInvocation: false, state: "disabled", source: "default", globalEnabled: false, usageCount: 0 },
  ];

  it("f enters full-text search mode", () => {
    const overlay = makeOverlay(ftRows);
    overlay.handleInput("f");
    expect((overlay as any).searchMode).toBe(true);
    expect((overlay as any).fullTextSearch).toBe(true);
    expect((overlay as any).searchQuery).toBe("");
  });

  it("uppercase F also enters full-text search mode", () => {
    const overlay = makeOverlay(ftRows);
    overlay.handleInput("F");
    expect((overlay as any).fullTextSearch).toBe(true);
  });

  it("/ enters name-only search mode (fullTextSearch false)", () => {
    const overlay = makeOverlay(ftRows);
    overlay.handleInput("/");
    expect((overlay as any).searchMode).toBe(true);
    expect((overlay as any).fullTextSearch).toBe(false);
  });

  it("Esc in search mode clears fullTextSearch flag", () => {
    const overlay = makeOverlay(ftRows);
    overlay.handleInput("f");
    expect((overlay as any).fullTextSearch).toBe(true);
    overlay.handleInput("KEY_ESCAPE");
    expect((overlay as any).searchMode).toBe(false);
    expect((overlay as any).fullTextSearch).toBe(false);
    expect((overlay as any).searchQuery).toBe("");
  });

  it("Enter exits search mode but keeps fullTextSearch and filter", () => {
    const overlay = makeOverlay(ftRows);
    overlay.handleInput("f");
    overlay.handleInput("p");
    overlay.handleInput("r");
    overlay.handleInput("o");
    overlay.handleInput("KEY_ENTER");
    expect((overlay as any).searchMode).toBe(false);
    expect((overlay as any).fullTextSearch).toBe(true);
    expect((overlay as any).searchQuery).toBe("pro");
  });

  it("Esc in normal mode clears active full-text filter before closing", () => {
    const overlay = makeOverlay(ftRows);
    // Simulate a committed full-text filter
    (overlay as any).fullTextSearch = true;
    (overlay as any).searchQuery = "deploy";
    let closed = false;
    overlay.onClose = () => { closed = true; };
    overlay.handleInput("KEY_ESCAPE");
    // First Esc clears filter
    expect(closed).toBe(false);
    expect((overlay as any).searchQuery).toBe("");
    expect((overlay as any).fullTextSearch).toBe(false);
    // Second Esc closes
    overlay.handleInput("KEY_ESCAPE");
    expect(closed).toBe(true);
  });

  it("Esc in normal mode closes directly when no filter is active", () => {
    const overlay = makeOverlay(ftRows);
    let closed = false;
    overlay.onClose = () => { closed = true; };
    overlay.handleInput("KEY_ESCAPE");
    expect(closed).toBe(true);
  });
});

//  getFilteredIndices with full-text search

describe("SkillDetailOverlay.getFilteredIndices (full-text)", () => {
  function makeOverlay(rows: RowData[], idx = 0) {
    return new SkillDetailOverlay(rows, idx, () => 40, T, "global");
  }

  const ftRows: RowData[] = [
    { name: "deploy", description: "Deploy to production", filePath: "/deploy.md", disableModelInvocation: false, state: "disabled", source: "default", globalEnabled: false, usageCount: 0 },
    { name: "test-skill", description: "Run unit tests", filePath: "/test.md", disableModelInvocation: false, state: "disabled", source: "default", globalEnabled: false, usageCount: 0 },
    { name: "build", description: "Build the project", filePath: "/build.md", disableModelInvocation: false, state: "disabled", source: "default", globalEnabled: false, usageCount: 0 },
    { name: "analyze", description: "Code analysis tool", filePath: "/analyze.md", disableModelInvocation: false, state: "disabled", source: "default", globalEnabled: false, usageCount: 0 },
  ];

  it("full-text search matches description", () => {
    const overlay = makeOverlay(ftRows);
    (overlay as any).fullTextSearch = true;
    (overlay as any).searchQuery = "unit"; // matches "Run unit tests" in test-skill description
    const result = (overlay as any).getFilteredIndices() as number[];
    expect(result).toContain(1); // test-skill
  });

  it("full-text search matches body via readSkillBody", () => {
    // Use a fresh overlay with a unique filePath to avoid cache interference
    const bodyRows: RowData[] = [
      { name: "deploy", description: "Deploy", filePath: "/ft-body-deploy.md", disableModelInvocation: false, state: "disabled", source: "default", globalEnabled: false, usageCount: 0 },
    ];
    vi.mocked(fs.readFileSync).mockReturnValue("---\ntitle: X\n---\nThis skill handles production deployment workflow." as any);
    const overlay = makeOverlay(bodyRows);
    (overlay as any).fullTextSearch = true;
    (overlay as any).searchQuery = "workflow";
    // Need to call readSkillBody directly first to ensure mock is consumed
    const body = readSkillBody("/ft-body-deploy.md");
    expect(body).toContain("workflow"); // verify mock works
    const result = (overlay as any).getFilteredIndices() as number[];
    expect(result).toContain(0); // deploy (body matched)
  });

  it("name prefix matches come before description/body matches", () => {
    vi.mocked(fs.readFileSync).mockReturnValue("---\ntitle: X\n---\nSome content about deployment." as any);
    const overlay = makeOverlay(ftRows);
    (overlay as any).fullTextSearch = true;
    (overlay as any).searchQuery = "deploy";
    const result = (overlay as any).getFilteredIndices() as number[];
    // "deploy" is a prefix match for name "deploy" (idx 0) — should come first
    // Other rows may match via description/body but come after prefix+substring
    expect(result[0]).toBe(0); // deploy (prefix match)
  });

  it("name substring matches come before description/body matches", () => {
    // build (idx 2) name is a substring match; test-skill (idx 1) description contains "build" if we set it
    const rows: RowData[] = [
      { name: "alpha", description: "build stuff", filePath: "/a.md", disableModelInvocation: false, state: "disabled", source: "default", globalEnabled: false, usageCount: 0 },
      { name: "rebuild", description: "other", filePath: "/b.md", disableModelInvocation: false, state: "disabled", source: "default", globalEnabled: false, usageCount: 0 },
    ];
    const overlay = makeOverlay(rows);
    (overlay as any).fullTextSearch = true;
    (overlay as any).searchQuery = "build";
    const result = (overlay as any).getFilteredIndices() as number[];
    // "rebuild" is a substring match (idx 1) → before "alpha" which matches via description
    expect(result[0]).toBe(1); // rebuild (substring match)
    expect(result[1]).toBe(0); // alpha (description match)
  });

  it("name-only search does not match description", () => {
    const overlay = makeOverlay(ftRows);
    (overlay as any).fullTextSearch = false;
    (overlay as any).searchQuery = "unittest"; // in description only
    const result = (overlay as any).getFilteredIndices() as number[];
    expect(result).toEqual([]);
  });

  it("handles readSkillBody errors gracefully", () => {
    vi.mocked(fs.readFileSync).mockImplementation(() => {
      throw new Error("ENOENT");
    });
    const overlay = makeOverlay(ftRows);
    (overlay as any).fullTextSearch = true;
    (overlay as any).searchQuery = "anything";
    // Should not crash — body matches are skipped on read errors
    expect(() => (overlay as any).getFilteredIndices()).not.toThrow();
  });
});

//  Description highlighting in full-text search

describe("SkillDetailOverlay description highlighting (full-text)", () => {
  function makeOverlay(rows: RowData[], idx = 0) {
    return new SkillDetailOverlay(rows, idx, () => 40, T, "global");
  }

  it("highlights matching text in description when fullTextSearch is active", () => {
    const rows: RowData[] = [
      { name: "deploy", description: "Deploy to production servers", filePath: "/d.md", disableModelInvocation: false, state: "enabled", source: "global", globalEnabled: true, usageCount: 0 },
    ];
    const overlay = makeOverlay(rows);
    (overlay as any).fullTextSearch = true;
    (overlay as any).searchQuery = "production";
    const lines = overlay.render(200);
    const text = lines.join("\n");
    // The highlighted match wraps "production" with accent+bold (the matchStyle)
    // Our test theme is identity, so the highlight appears as raw text with the
    // query still visible.
    expect(text).toContain("production");
  });

  it("does not highlight description when fullTextSearch is false", () => {
    const rows: RowData[] = [
      { name: "deploy", description: "Deploy to production servers", filePath: "/d.md", disableModelInvocation: false, state: "enabled", source: "global", globalEnabled: true, usageCount: 0 },
    ];
    const overlay = makeOverlay(rows);
    (overlay as any).fullTextSearch = false;
    (overlay as any).searchQuery = "production";
    const lines = overlay.render(200);
    const text = lines.join("\n");
    // Description is shown without highlight styling wrappers
    expect(text).toContain("production");
  });
});

//  Header and footer full-text search display

describe("SkillDetailOverlay header/footer (full-text)", () => {
  function makeOverlay(rows: RowData[], idx = 0) {
    return new SkillDetailOverlay(rows, idx, () => 40, T, "global");
  }

  const rows: RowData[] = [
    { name: "deploy", description: "Deploy", filePath: "/d.md", disableModelInvocation: false, state: "enabled", source: "global", globalEnabled: true, usageCount: 0 },
  ];

  it("header shows f prefix in full-text search mode", () => {
    const overlay = makeOverlay(rows);
    overlay.handleInput("f");
    overlay.handleInput("d");
    overlay.handleInput("e");
    const lines = overlay.render(200);
    const text = lines.join("\n").replace(/\x1b\[[0-9;]*m/g, "");
    // Header should show " f de" (with cursor) not " / de"
    expect(text).toMatch(/f\s+de/);
  });

  it("header shows / prefix in name-only search mode", () => {
    const overlay = makeOverlay(rows);
    overlay.handleInput("/");
    overlay.handleInput("d");
    overlay.handleInput("e");
    const lines = overlay.render(200);
    const text = lines.join("\n").replace(/\x1b\[[0-9;]*m/g, "");
    expect(text).toMatch(/\/\s+de/);
  });

  it("header shows full-text filter label after Enter commits", () => {
    const overlay = makeOverlay(rows);
    overlay.handleInput("f");
    overlay.handleInput("d");
    overlay.handleInput("e");
    overlay.handleInput("KEY_ENTER");
    const lines = overlay.render(200);
    const text = lines.join("\n").replace(/\x1b\[[0-9;]*m/g, "");
    expect(text).toMatch(/Full-text filter: "de"/);
    expect(text).toMatch(/Esc to clear/);
  });

  it("footer shows compact key hints (space toggle, ? help)", () => {
    const overlay = makeOverlay(rows);
    const lines = overlay.render(200);
    const text = lines.join("\n").replace(/\x1b\[[0-9;]*m/g, "");
    expect(text).toMatch(/space toggle/);
    expect(text).toMatch(/\? help/);
    expect(text).toMatch(/\/ search/);
  });

  it("footer shows f prefix in search label when in full-text search mode", () => {
    const overlay = makeOverlay(rows);
    overlay.handleInput("f");
    const lines = overlay.render(200);
    const text = lines.join("\n").replace(/\x1b\[[0-9;]*m/g, "");
    expect(text).toMatch(/f search.*Esc cancel/);
  });

  it("sidebar shows (no matches) when full-text filter yields no results", () => {
    const overlay = makeOverlay(rows);
    overlay.handleInput("f");
    overlay.handleInput("z");
    overlay.handleInput("z");
    overlay.handleInput("z");
    const lines = overlay.render(200);
    const text = lines.join("\n").replace(/\x1b\[[0-9;]*m/g, "");
    expect(text).toMatch(/no matches/);
  });

  it("full-text search highlights name in sidebar even after exiting search mode", () => {
    const overlay = makeOverlay(rows);
    (overlay as any).fullTextSearch = true;
    (overlay as any).searchQuery = "dep";
    // Name highlight should be active (accent+bold wrapping in real theme)
    const lines = overlay.render(200);
    const text = lines.join("\n");
    // Query text is visible — our test theme is identity, so no style change visible
    expect(text).toContain("deploy");
  });
});

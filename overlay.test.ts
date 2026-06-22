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
    },
    {
      name: "beta-skill",
      description: "Second test skill",
      filePath: "/fake/beta.md",
      disableModelInvocation: false,
      state: "disabled",
      source: "default",
      globalEnabled: false,
    },
    {
      name: "gamma-tool",
      description: "Third test skill",
      filePath: "/fake/gamma.md",
      disableModelInvocation: true,
      state: "enabled",
      source: "global",
      globalEnabled: true,
    },
    {
      name: "alpha-tool",
      description: "Similar prefix",
      filePath: "/fake/alpha-tool.md",
      disableModelInvocation: false,
      state: "enabled",
      source: "project",
      globalEnabled: false,
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
      { name: "apple", description: "", filePath: "", disableModelInvocation: false, state: "enabled", source: "global", globalEnabled: true },
      { name: "pineapple", description: "", filePath: "", disableModelInvocation: false, state: "enabled", source: "global", globalEnabled: true },
      { name: "orange", description: "", filePath: "", disableModelInvocation: false, state: "enabled", source: "global", globalEnabled: true },
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

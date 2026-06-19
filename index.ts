/**
 * pi-skill-gate — Interactive skill visibility manager.
 *
 * Overlay-based UI for toggling skill visibility and browsing skill bodies.
 * Uses pi's ResourceLoader API for skill discovery.
 *
 * Persistence: ~/.pi/agent/config/skill-gate.json
 */

import type { ExtensionAPI, Skill } from "@earendil-works/pi-coding-agent";
import { DefaultResourceLoader, getAgentDir, getMarkdownTheme } from "@earendil-works/pi-coding-agent";
import {
  decodeKittyPrintable,
  Key,
  matchesKey,
  Markdown,
  truncateToWidth,
  visibleWidth,
} from "@earendil-works/pi-tui";
import * as fs from "node:fs";
import * as path from "node:path";
import { homedir } from "node:os";

// ---------------------------------------------------------------------------
// Types
// ---------------------------------------------------------------------------

interface SkillGateConfig { skills: Record<string, ToggleState>; }
type ToggleState = "enabled" | "disabled";

// ---------------------------------------------------------------------------
// Config persistence
// ---------------------------------------------------------------------------

const CONFIG_PATH = path.join(homedir(), ".pi", "agent", "config", "skill-gate.json");

function loadConfig(): SkillGateConfig {
  if (!fs.existsSync(CONFIG_PATH)) return { skills: {} };
  try { return JSON.parse(fs.readFileSync(CONFIG_PATH, "utf-8")); }
  catch {
    console.warn(`[skill-gate] Failed to parse ${CONFIG_PATH} — using empty config`);
    return { skills: {} };
  }
}
function saveConfig(c: SkillGateConfig): void {
  fs.mkdirSync(path.dirname(CONFIG_PATH), { recursive: true });
  fs.writeFileSync(CONFIG_PATH, JSON.stringify(c, null, 2), "utf-8");
}

/** Load state for a skill from config. Defaults to "disabled". */
function loadState(name: string, config: SkillGateConfig): ToggleState {
  const raw = config.skills[name];
  return (raw === "enabled" || raw === "disabled") ? raw : "disabled";
}

/** Persist a toggle. Removes the key on "disabled" since that's the default. */
function persistToggle(name: string, value: ToggleState, config: SkillGateConfig): void {
  if (value === "disabled") {
    delete config.skills[name];
  } else {
    config.skills[name] = value;
  }
  saveConfig(config);
}

// ---------------------------------------------------------------------------
// Cached skills from ResourceLoader (populated at session_start)
// ---------------------------------------------------------------------------

let cachedSkills: Skill[] = [];

// ---------------------------------------------------------------------------
// Skill body reader
// ---------------------------------------------------------------------------

const _skillBodyCache = new Map<string, string>();

/** Read the full SKILL.md body (everything after YAML frontmatter). */
function readSkillBody(filePath: string): string {
  if (_skillBodyCache.has(filePath)) return _skillBodyCache.get(filePath)!;
  let result: string;
  try {
    const raw = fs.readFileSync(filePath, "utf-8");
    const body = raw.replace(/^---\n[\s\S]*?\n---\n?/, "").trim();
    result = body || "(No content)";
  } catch {
    result = "(Unable to read skill file)";
  }
  _skillBodyCache.set(filePath, result);
  return result;
}

// ---------------------------------------------------------------------------
// System prompt injection
// ---------------------------------------------------------------------------

function buildVisibleBlock(rows: { name: string; state: ToggleState; description: string; disableModelInvocation: boolean }[]): string | null {
  const visible = rows.filter((r) => !r.disableModelInvocation && r.state === "enabled");
  if (visible.length === 0) return null;
  return `<available_skills>\n${visible.map((r) => `- ${r.name}: ${r.description}`).join("\n")}\n</available_skills>`;
}

// ---------------------------------------------------------------------------
// Theme
// ---------------------------------------------------------------------------

interface SkillGateTheme {
  accent: (t: string) => string;
  dim: (t: string) => string;
  muted: (t: string) => string;
  warning: (t: string) => string;
  error: (t: string) => string;
  bold: (t: string) => string;
  enabled: (t: string) => string;
  selCell: (t: string) => string;
  selRow: (t: string) => string;
  nativeDisabled: (t: string) => string;
}

function makeTheme(piTheme: any): SkillGateTheme {
  return {
    accent: (t: string) => piTheme.fg("accent", t),
    dim: (t: string) => piTheme.fg("dim", t),
    muted: (t: string) => piTheme.fg("muted", t),
    warning: (t: string) => piTheme.fg("warning", t),
    error: (t: string) => piTheme.fg("error", t),
    bold: (t: string) => piTheme.bold ? piTheme.bold(t) : t,
    enabled: (t: string) => piTheme.fg("success", t),
    selCell: (t: string) => piTheme.fg("accent", piTheme.bold ? piTheme.bold(t) : t),
    selRow: (t: string) => piTheme.fg("accent", t),
    nativeDisabled: (t: string) => piTheme.fg("dim", t),
  };
}

// ---------------------------------------------------------------------------
// Table row data
// ---------------------------------------------------------------------------

interface RowData {
  name: string;
  description: string;
  filePath: string;
  disableModelInvocation: boolean;
  state: ToggleState;
}

function wrapText(text: string, maxWidth: number): string[] {
  if (maxWidth <= 0) return [];
  const words = text.split(/\s+/);
  const lines: string[] = [];
  let cur = "";
  for (const word of words) {
    if (!cur) { cur = word; continue; }
    if (cur.length + 1 + word.length <= maxWidth) { cur += " " + word; }
    else { lines.push(cur); cur = word; }
  }
  if (cur) lines.push(cur);
  return lines.length > 0 ? lines : [""];
}

// ---------------------------------------------------------------------------
// Skill Detail Overlay
// ---------------------------------------------------------------------------

/** Fraction of page height to jump on PgUp/PgDn (keep 25% overlap for context). */
const SCROLL_FRACTION = 0.75;

class SkillDetailOverlay {
  private rows: RowData[];
  private currentIdx: number;
  private scrollOffset = 0;
  private getTerminalRows: () => number;
  private theme: SkillGateTheme;
  private md: Markdown;
  private showSidebar = true;
  private searchMode = false;
  private searchQuery = "";

  onClose?: () => void;
  onToggle?: (name: string, state: ToggleState) => void;
  onInvoke?: (name: string) => void;

  constructor(rows: RowData[], initialIdx: number, getTerminalRows: () => number, theme: SkillGateTheme) {
    this.rows = rows;
    this.currentIdx = Math.max(0, Math.min(initialIdx, rows.length - 1));
    this.getTerminalRows = getTerminalRows;
    this.theme = theme;
    this.md = new Markdown("", 2, 0, getMarkdownTheme());
  }

  handleInput(data: string): void {
    if (this.rows.length === 0) return;

    // ── search mode ──
    if (this.searchMode) {
      if (matchesKey(data, Key.escape)) {
        this.searchMode = false;
        this.searchQuery = "";
        return;
      }
      if (matchesKey(data, Key.enter)) {
        this.searchMode = false;
        return;
      }
      if (matchesKey(data, Key.backspace)) {
        this.searchQuery = this.searchQuery.slice(0, -1);
        this.jumpToBestMatch();
        return;
      }
      if (matchesKey(data, Key.up)) {
        this.currentIdx = (this.currentIdx - 1 + this.rows.length) % this.rows.length;
        this.scrollOffset = 0;
        return;
      }
      if (matchesKey(data, Key.down)) {
        this.currentIdx = (this.currentIdx + 1) % this.rows.length;
        this.scrollOffset = 0;
        return;
      }
      if (matchesKey(data, Key.pageUp)) {
        this.scrollOffset = Math.max(0, this.scrollOffset - Math.ceil(this.bodyHeightEstimate() * SCROLL_FRACTION));
        return;
      }
      if (matchesKey(data, Key.pageDown)) {
        this.scrollOffset += Math.ceil(this.bodyHeightEstimate() * SCROLL_FRACTION);
        return;
      }
      if (matchesKey(data, Key.home)) {
        this.scrollOffset = 0;
        return;
      }
      if (matchesKey(data, Key.end)) {
        this.scrollOffset = Number.MAX_SAFE_INTEGER;
        return;
      }
      // Printable characters — append to query
      const ch = decodeKittyPrintable(data);
      const printable = ch ?? data;
      if (printable.length === 1 && printable >= " ") {
        this.searchQuery += printable;
        this.jumpToBestMatch();
        return;
      }
      return; // ignore other keys while searching
    }

    // ── enter search mode on "/" ──
    if (data === "/" || matchesKey(data, Key.slash)) {
      this.searchMode = true;
      this.searchQuery = "";
      return;
    }

    if (matchesKey(data, Key.up)) {
      this.currentIdx = (this.currentIdx - 1 + this.rows.length) % this.rows.length;
      this.scrollOffset = 0;
      return;
    }
    if (matchesKey(data, Key.down)) {
      this.currentIdx = (this.currentIdx + 1) % this.rows.length;
      this.scrollOffset = 0;
      return;
    }
    if (matchesKey(data, Key.left)) {
      // no action — use up/down to navigate
      return;
    }
    if (matchesKey(data, Key.escape)) {
      this.onClose?.();
      return;
    }
    if (data === "b" || data === "B") {
      this.showSidebar = !this.showSidebar;
      return;
    }
    if (matchesKey(data, Key.space)) {
      const row = this.rows[this.currentIdx];
      if (row && !row.disableModelInvocation) {
        row.state = row.state === "enabled" ? "disabled" : "enabled";
        this.onToggle?.(row.name, row.state);
      }
      return;
    }
    if (matchesKey(data, Key.enter)) {
      const row = this.rows[this.currentIdx];
      if (row) this.onInvoke?.(row.name);
      return;
    }
    if (matchesKey(data, Key.pageUp)) {
      this.scrollOffset = Math.max(0, this.scrollOffset - Math.ceil(this.bodyHeightEstimate() * SCROLL_FRACTION));
      return;
    }
    if (matchesKey(data, Key.pageDown)) {
      this.scrollOffset += Math.ceil(this.bodyHeightEstimate() * SCROLL_FRACTION);
      return;
    }
    if (matchesKey(data, Key.home)) {
      this.scrollOffset = 0;
      return;
    }
    if (matchesKey(data, Key.end)) {
      this.scrollOffset = Number.MAX_SAFE_INTEGER;
      return;
    }
  }

  /** Jump to the skill whose name best matches the search query. */
  private jumpToBestMatch(): void {
    const q = this.searchQuery.toLowerCase();
    if (!q) {
      this.currentIdx = 0;
      this.scrollOffset = 0;
      return;
    }
    const idx = this.rows.findIndex((r) => r.name.toLowerCase().includes(q));
    if (idx >= 0) {
      this.currentIdx = idx;
      this.scrollOffset = 0;
    }
  }

  // ── sidebar width (based on longest skill name + ▶ indicator) ──
  private sidebarWidth(): number {
    const maxLen = Math.max(...this.rows.map((r) => r.name.length), 0);
    return Math.max(14, Math.min(24, maxLen + 4));
  }

  /** Rough estimate of available body lines for scroll calculations. */
  private bodyHeightEstimate(): number {
    return Math.max(8, Math.floor(this.getTerminalRows() * 0.5));
  }

  // ── render sidebar column (height lines, sidebarW wide) ──
  private renderSidebar(height: number, sidebarW: number): string[] {
    const T = this.theme;
    const lines: string[] = [];
    const skillArea = Math.max(0, height - 2); // header + separator

    // Auto-scroll to keep selected skill visible
    let sbScroll = 0;
    if (this.rows.length > skillArea) {
      sbScroll = Math.max(0, this.currentIdx - Math.floor(skillArea / 2));
      sbScroll = Math.min(sbScroll, this.rows.length - skillArea);
    }

    const leftLabel = T.dim(" Skills");
    const idxLabel = T.accent(`[${this.currentIdx + 1}/${this.rows.length}]`);
    const leftVw = visibleWidth(leftLabel);
    const idxVw = visibleWidth(idxLabel);
    const gap = Math.max(1, sidebarW - leftVw - idxVw);
    const sbHeader = leftLabel + " ".repeat(gap) + idxLabel;
    lines.push(sbHeader);
    lines.push(T.dim("─".repeat(sidebarW)));

    for (let i = 0; i < skillArea; i++) {
      const ri = i + sbScroll;
      const r = this.rows[ri];
      if (r) {
        const isCurrent = ri === this.currentIdx;
        const arrow = isCurrent ? " " + T.accent("▶") : "  ";
        const name = truncateToWidth(r.name, sidebarW - 4);
        const label = arrow + " " + name;
        let styled: string;
        if (isCurrent && !r.disableModelInvocation && r.state === "enabled") {
          // Green name with accent arrow for visibility
          styled = " " + T.accent("▶") + " " + T.enabled(name);
        } else if (isCurrent) {
          styled = T.accent(label);
        } else if (r.disableModelInvocation) {
          styled = T.nativeDisabled(label);
        } else if (r.state === "enabled") {
          styled = T.enabled(label);
        } else {
          styled = T.dim(label);
        }
        // Pad by visible width (ANSI escape codes inflate .length, breaking .padEnd)
        const vw = visibleWidth(styled);
        lines.push(vw < sidebarW ? styled + " ".repeat(sidebarW - vw) : styled);
      } else {
        lines.push(" ".repeat(sidebarW));
      }
    }

    return lines;
  }

  // ── render detail column (unbordered — borders added by merge or full-width path) ──
  // footerLines: how many footer lines we expect (used for body-budget subtraction).
  private renderDetail(detailW: number, contentBudget: number, footerLines = 1): {
    descLines: string[];
    bodyLines: string[];
    mdMeta: { bodyLength: number; remaining: number; maxOffset: number; needsScrollbar: boolean; thumbH: number; thumbStart: number; gutterW: number; contentW: number };
  } {
    const T = this.theme;
    const row = this.rows[this.currentIdx]!;
    const padW = Math.max(detailW - 4, 12);

    // ── description section ──
    const descLines: string[] = [];

    // Skill name
    descLines.push(" " + T.accent(T.bold(row.name)));

    // Status line
    const native = row.disableModelInvocation;
    if (native) {
      descLines.push(" " + T.bold("Status: ") + T.nativeDisabled("(natively disabled)"));
    } else {
      const st = row.state === "enabled" ? T.enabled("enabled") : T.error("disabled");
      descLines.push(" " + T.bold("Status: ") + st + T.dim("  [space to toggle]"));
    }

    if (row.description) {
      descLines.push(T.bold(" Description:"));
      for (const dl of wrapText(row.description, padW)) {
        descLines.push("  " + T.muted(dl));
      }
      descLines.push("");
    }

    // ── budget: ensure total overlay height stays within bounds ──
    // Desc + prompt header(2) + body + borderline(1) + footer(N) = descLines + bodyLines + 3 + N
    // All of this must fit within contentBudget lines.
    const MIN_BODY = 6; // minimum visible body lines
    const BODY_CHROME = 3 + footerLines; // prompt header(2) + borderline(1) + footer(N)
    const maxDesc = contentBudget - MIN_BODY - BODY_CHROME;
    if (descLines.length > maxDesc) {
      descLines.length = maxDesc;
      descLines[maxDesc - 1] = "  " + T.dim("…");
    }
    const remaining = Math.max(MIN_BODY, contentBudget - descLines.length - BODY_CHROME);
    const body = readSkillBody(row.filePath);

    // Loop: render, measure gutter + scroll, adjust contentW, repeat until stable.
    // The gutter expands at 100/1000-line thresholds; scrollbar can appear/disappear
    // when contentW shrinks/grows. A three-pass loop covers all edge cases.
    let gutterW = 4;
    let scrollW = 1;
    let needsScrollbar = true;
    // contentW must be positive — Markdown.render() uses String.repeat(width)
    // internally and will crash with a negative or zero value.
    const MIN_CONTENT_W = 10;
    let contentW = Math.max(MIN_CONTENT_W, detailW - gutterW - scrollW);
    this.md.setText(body);
    let mdLines = this.md.render(contentW);
    for (let pass = 0; pass < 3; pass++) {
      const prevGutterW = gutterW;
      const prevScrollW = scrollW;
      gutterW = Math.max(3, String(mdLines.length).length + 2);
      needsScrollbar = mdLines.length > remaining;
      scrollW = needsScrollbar ? 1 : 0;
      if (gutterW === prevGutterW && scrollW === prevScrollW) break;
      contentW = Math.max(MIN_CONTENT_W, detailW - gutterW - scrollW);
      this.md.setText(body);
      mdLines = this.md.render(contentW);
    }

    const maxOffset = Math.max(0, mdLines.length - remaining);
    this.scrollOffset = Math.max(0, Math.min(this.scrollOffset, maxOffset));

    const thumbH = needsScrollbar ? Math.max(1, Math.round(remaining * remaining / Math.max(1, mdLines.length))) : 0;
    const thumbStart = needsScrollbar && maxOffset > 0 ? Math.round(this.scrollOffset / maxOffset * (remaining - thumbH)) : 0;

    const gutterFmt = (n: number) => T.dim(String(n).padStart(gutterW - 2) + " │");

    const bodyLines: string[] = [];
    const endLine = Math.min(this.scrollOffset + remaining, mdLines.length);
    for (let i = this.scrollOffset; i < endLine; i++) {
      const rel = i - this.scrollOffset;
      const gutter = gutterFmt(i + 1);

      let sc = "";
      if (needsScrollbar) {
        const isThumb = rel >= thumbStart && rel < thumbStart + thumbH;
        sc = isThumb ? T.accent("█") : T.dim("░");
      }

      const mdLine = mdLines[i];
      const mdVw = visibleWidth(mdLine);
      const paddedMd = mdVw < contentW ? mdLine + " ".repeat(contentW - mdVw) : truncateToWidth(mdLine, contentW);
      bodyLines.push(gutter + paddedMd + sc);
    }

    // Fill remaining
    const shown = endLine - this.scrollOffset;
    for (let i = shown; i < remaining; i++) {
      let sc = "";
      if (needsScrollbar) {
        sc = (i >= thumbStart && i < thumbStart + thumbH) ? T.accent("█") : T.dim("░");
      }
      bodyLines.push(" ".repeat(gutterW) + " ".repeat(contentW) + sc);
    }

    return {
      descLines,
      bodyLines,
      mdMeta: { bodyLength: mdLines.length, remaining, maxOffset, needsScrollbar, thumbH, thumbStart, gutterW, contentW },
    };
  }

  render(width: number): string[] {
    const T = this.theme;
    const row = this.rows[this.currentIdx];
    if (!row) return [T.warning(" No skill selected")];

    const innerW = Math.max(width - 2, 20);
    const lines: string[] = [];

    // ── top border ──
    lines.push(T.dim("┌" + "─".repeat(innerW) + "┐"));

    // ── title bar (full width) ──
    const vc = this.rows.filter((r) => !r.disableModelInvocation && r.state === "enabled").length;
    const tc = this.rows.length;
    lines.push(borderLine(" " + T.accent(T.bold(" Skill Gate")) + T.dim(` ── ${vc}/${tc} skills enabled`), innerW, T));
    const subtitleW = innerW - 2; // account for leading spaces + border
    let headerLines: number;
    if (this.searchMode) {
      // ── search bar (replaces subtitle when active) ──
      const cursor = this.theme.accent("█");
      const searchLabel = this.theme.dim(" /") + " " + this.searchQuery + cursor;
      lines.push(borderLine(searchLabel, innerW, T));
      headerLines = 1; // search bar
    } else {
      const subtitle = "Control which skills the model can see. Enabled skills are injected into the system prompt; disabled skills are hidden.";
      const subtitleLines = wrapText(subtitle, subtitleW);
      for (const sl of subtitleLines) {
        lines.push(borderLine(T.muted("  " + sl), innerW, T));
      }
      headerLines = subtitleLines.length;
    }

    lines.push(T.dim("│" + T.dim("─".repeat(innerW)) + "│"));

    // ── dynamic height: match maxHeight "80%" overlay option ──
    const termRows = this.getTerminalRows();
    const overlayMax = Math.max(12, Math.floor(termRows * 0.8));
    const chrome = 3 + headerLines; // top border, title, header lines, separator
    const bottom = 1;                         // bottom border
    const contentBudget = Math.max(10, overlayMax - chrome - bottom);

    // ── layout: sidebar (toggleable) + detail ──
    // Fall back to full-width when the detail column would be too narrow.
    const sidebarW = this.sidebarWidth();
    const detailW = innerW - sidebarW - 1;
    const useSidebar = this.showSidebar && detailW >= 20;

    if (useSidebar) {

      // Two-pass rendering: compute footer lines first, then re-allocate body budget.
      // This keeps the overlay height stable when the footer wraps to multiple lines.
      let { descLines, bodyLines, mdMeta } = this.renderDetail(detailW, contentBudget, 1);
      let wrappedFooter = this.footerLines(mdMeta, detailW);
      if (wrappedFooter.length > 1) {
        const adjustedBudget = contentBudget - (wrappedFooter.length - 1);
        ({ descLines, bodyLines, mdMeta } = this.renderDetail(detailW, adjustedBudget, wrappedFooter.length));
        wrappedFooter = this.footerLines(mdMeta, detailW);
      }

      // Body area height = description + prompt header + body + borderline + footer
      const promptHeader = [" " + T.bold("Prompt:"), ""];
      const bodyHeight = descLines.length + promptHeader.length + bodyLines.length + 1 + wrappedFooter.length; // +1 for borderline + N for footer

      const sidebarLines = this.renderSidebar(bodyHeight, sidebarW);

      // Merge detail: desc + prompt + body + borderline + footer
      const detailAll: string[] = [
        ...descLines.map((l) => padTo(l, detailW)),
        ...promptHeader.map((l) => padTo(l, detailW)),
        ...bodyLines.map((l) => padTo(l, detailW)),
        padTo(T.dim("─".repeat(detailW)), detailW),
        ...wrappedFooter.map((l) => padTo(l, detailW)),
      ];

      // Ensure sidebar matches detail height
      while (sidebarLines.length < detailAll.length) sidebarLines.push(" ".repeat(sidebarW));
      while (detailAll.length < sidebarLines.length) detailAll.push(" ".repeat(detailW));

      for (let i = 0; i < sidebarLines.length; i++) {
        lines.push(T.dim("│") + sidebarLines[i] + T.dim("│") + detailAll[i] + T.dim("│"));
      }
    } else {
      // ── full-width (no sidebar) ──
      let { descLines, bodyLines, mdMeta } = this.renderDetail(innerW, contentBudget, 1);
      let wrappedFooter = this.footerLines(mdMeta, innerW - 2);
      if (wrappedFooter.length > 1) {
        const adjustedBudget = contentBudget - (wrappedFooter.length - 1);
        ({ descLines, bodyLines, mdMeta } = this.renderDetail(innerW, adjustedBudget, wrappedFooter.length));
        wrappedFooter = this.footerLines(mdMeta, innerW - 2);
      }

      for (const dl of descLines) lines.push(borderLine(dl, innerW, T));
      lines.push(borderLine(" " + T.bold("Prompt:"), innerW, T));
      lines.push(borderLine("", innerW, T));
      for (const bl of bodyLines) lines.push(T.dim("│") + bl + T.dim("│"));
      lines.push(T.dim("│" + T.dim("─".repeat(innerW)) + "│"));
      for (const fl of wrappedFooter) lines.push(borderLine(fl, innerW, T));
    }

    // ── bottom border ──
    lines.push(T.dim("└" + "─".repeat(innerW) + "┘"));

    return lines;
  }

  /** Wrap the footer text to fit maxW and return styled lines. */
  private footerLines(meta: { bodyLength: number; remaining: number; maxOffset: number }, maxW: number): string[] {
    // Build the raw left-side text (scroll info + keybindings).
    const hasMore = meta.bodyLength > meta.remaining;
    let left: string;
    if (this.searchMode) {
      left = " / search · Esc cancel · Enter confirm";
    } else if (hasMore) {
      const pct = meta.maxOffset > 0 ? Math.round((this.scrollOffset / meta.maxOffset) * 100) : 0;
      const up = this.scrollOffset > 0 ? "↑" : " ";
      const endLine = Math.min(this.scrollOffset + meta.remaining, meta.bodyLength);
      const dn = endLine < meta.bodyLength ? "↓" : " ";
      left = ` ${up} ${pct}% ${dn}  PgUp/PgDn · Home/End · / search · b sidebar · enter invoke · Esc close`;
    } else {
      left = " ↑↓ skill · / search · b sidebar · enter invoke · Esc close";
    }
    const idx = this.theme.accent(`[${this.currentIdx + 1}/${this.rows.length}]`);

    // Wrap the left text, leaving room for the index on the last line.
    const idxVw = visibleWidth(idx);
    const lastLineW = maxW - idxVw - 1;

    let wrapped: string[];
    if (lastLineW > 10) {
      // Wrap everything at full width so the first lines use the full space.
      wrapped = wrapText(left, maxW);
      if (wrapped.length === 1) {
        // Check whether the index fits on this single line.
        const lVw = visibleWidth(wrapped[0]);
        if (lVw + 1 + idxVw <= maxW) {
          // Fits — right-align the index inline.
          const gap = maxW - lVw - idxVw;
          wrapped[0] = wrapped[0] + " ".repeat(gap) + idx;
        } else {
          // Doesn't fit — push the index to its own line, right-aligned.
          wrapped.push(" ".repeat(Math.max(0, maxW - idxVw)) + idx);
        }
      } else {
        // Multi-line: put the index on the last line, right-aligned.
        // Re-wrap the last line to make room for the index.
        const last = wrapped[wrapped.length - 1];
        const lastRewrapped = wrapText(last, lastLineW);
        wrapped[wrapped.length - 1] = lastRewrapped[0];
        // Append remaining rewrapped lines (edge case) + index on final line.
        for (let i = 1; i < lastRewrapped.length; i++) wrapped.push(lastRewrapped[i]);
        const finalVw = visibleWidth(wrapped[wrapped.length - 1]);
        if (finalVw + 1 + idxVw <= maxW) {
          const finalGap = maxW - finalVw - idxVw;
          wrapped[wrapped.length - 1] += " ".repeat(finalGap) + idx;
        } else {
          wrapped.push(" ".repeat(Math.max(0, maxW - idxVw)) + idx);
        }
      }
    } else {
      // Extremely narrow – wrap everything at full width, index on its own line.
      wrapped = wrapText(left, maxW);
      wrapped.push(" ".repeat(Math.max(0, maxW - idxVw)) + idx);
    }

    return wrapped.map((l) => this.theme.dim(l));
  }

  private footerLine(detailW: number, meta: { bodyLength: number; remaining: number; maxOffset: number }): string {
    const raw = this.footerText(meta, detailW - 2);
    const styled = this.theme.dim(raw);
    const vw = visibleWidth(styled);
    return vw < detailW ? styled + " ".repeat(detailW - vw) : truncateToWidth(styled, detailW);
  }

  private footerText(meta: { bodyLength: number; remaining: number; maxOffset: number }, maxW: number): string {
    const hasMore = meta.bodyLength > meta.remaining;
    let left: string;
    if (hasMore) {
      const pct = meta.maxOffset > 0 ? Math.round((this.scrollOffset / meta.maxOffset) * 100) : 0;
      const up = this.scrollOffset > 0 ? "↑" : " ";
      const endLine = Math.min(this.scrollOffset + meta.remaining, meta.bodyLength);
      const dn = endLine < meta.bodyLength ? "↓" : " ";
      left = ` ${up} ${pct}% ${dn}  PgUp/PgDn · Home/End · b sidebar · enter invoke · Esc close`;
    } else {
      left = " ↑↓ skill · b sidebar · enter invoke · Esc close";
    }
    const idx = this.theme.accent(`[${this.currentIdx + 1}/${this.rows.length}]`);
    const leftVw = visibleWidth(left);
    const idxVw = visibleWidth(idx);
    const gap = Math.max(1, maxW - leftVw - idxVw);
    return left + " ".repeat(gap) + idx;
  }

  invalidate(): void {
    this.md.invalidate();
  }
}

/** Wrap a content line with │ border characters, padding to innerW visible width. */
function borderLine(content: string, innerW: number, T: SkillGateTheme): string {
  const vw = visibleWidth(content);
  const padded = vw < innerW ? content + " ".repeat(innerW - vw) : truncateToWidth(content, innerW);
  return T.dim("│") + padded + T.dim("│");
}

/** Pad a string to the given visible width with trailing spaces. */
function padTo(content: string, width: number): string {
  const vw = visibleWidth(content);
  return vw < width ? content + " ".repeat(width - vw) : content;
}

// ---------------------------------------------------------------------------
// Extension
// ---------------------------------------------------------------------------

export default function (pi: ExtensionAPI) {
  // Populate skill cache from ResourceLoader at session start (before any agent).
  // Walks agentDir for skills/ directories that includeDefaults doesn't cover
  // (e.g. pi-hermes-memory/skills/, projects-memory/*/skills/).
  pi.on("session_start", async (_event, ctx) => {
    const agentDir = getAgentDir();
    const additionalSkillPaths: string[] = [];

    // Directories that never contain skills or are covered by includeDefaults
    const skipDirs = new Set(["skills", "extensions", "npm", "config", "tmp", "bin", "sessions", "tools", "git"]);
    for (const entry of fs.readdirSync(agentDir, { withFileTypes: true })) {
      if (!entry.isDirectory() || skipDirs.has(entry.name)) continue;
      if (entry.name.startsWith(".")) continue;
      const sd = path.join(agentDir, entry.name, "skills");
      if (fs.existsSync(sd)) additionalSkillPaths.push(sd);
    }

    // Project-memory skills (pi-hermes-memory: projects-memory/<project>/skills/)
    const pmd = path.join(agentDir, "projects-memory");
    if (fs.existsSync(pmd)) {
      for (const entry of fs.readdirSync(pmd, { withFileTypes: true })) {
        if (!entry.isDirectory()) continue;
        const sd = path.join(pmd, entry.name, "skills");
        if (fs.existsSync(sd)) additionalSkillPaths.push(sd);
      }
    }

    const loader = new DefaultResourceLoader({
      cwd: ctx.cwd,
      agentDir,
      additionalSkillPaths,
    });
    await loader.reload();
    cachedSkills = loader.getSkills().skills;
  });

  // ── System prompt hook ──
  pi.on("before_agent_start", async (event, ctx) => {
    const config = loadConfig();
    const rows: RowData[] = cachedSkills.map((s) => {
      const state = loadState(s.name, config);
      return {
        name: s.name,
        description: s.description,
        filePath: s.filePath,
        disableModelInvocation: s.disableModelInvocation,
        state,
      };
    });
    let prompt = event.systemPrompt.replace(/\n<available_skills>[\s\S]*?<\/available_skills>\n/g, "\n");
    const block = buildVisibleBlock(rows);
    if (block) {
      if (prompt.includes("</memory-policy>")) {
        prompt = prompt.replace("</memory-policy>\n", `</memory-policy>\n${block}\n`);
      } else { prompt += `\n${block}\n`; }
    }
    return { systemPrompt: prompt };
  });

  // ── /skill-gate command ──
  pi.registerCommand("skill-gate", {
    description: "Manage which skills the model can see",
    handler: async (_args, ctx) => {
      const config = loadConfig();
      const skills = cachedSkills;
      if (skills.length === 0) { ctx.ui.notify("No skills discovered", "warning"); return; }

      const stateMap = new Map<string, ToggleState>();
      for (const s of skills) stateMap.set(s.name, loadState(s.name, config));

      const sortRows = (): RowData[] => {
        const data: RowData[] = skills.map((s) => ({
          name: s.name,
          description: s.description,
          filePath: s.filePath,
          disableModelInvocation: s.disableModelInvocation,
          state: stateMap.get(s.name)!,
        }));
        data.sort((a, b) => a.name.localeCompare(b.name));
        return data;
      };

      let lastSkill: string | undefined;

      while (true) {
        const rows = sortRows();

        // Open the detail overlay directly
        const outcome = await new Promise<{ type: "close" } | { type: "invoke"; name: string }>((resolve) => {
          ctx.ui.custom((tui, piTheme, _kb, done) => {
            const T = makeTheme(piTheme);
            const initIdx = lastSkill ? rows.findIndex((r) => r.name === lastSkill) : 0;
            const overlay = new SkillDetailOverlay(rows, Math.max(0, initIdx), () => tui.terminal.rows, T);
            overlay.onClose = () => { done(null); resolve({ type: "close" }); };
            overlay.onInvoke = (name) => { done(null); resolve({ type: "invoke", name }); };
            overlay.onToggle = (name, state) => {
              stateMap.set(name, state);
              persistToggle(name, state, config);
              tui.requestRender();
            };
            return {
              render: (w: number) => overlay.render(w),
              invalidate: () => overlay.invalidate(),
              handleInput: (d: string) => {
                overlay.handleInput(d);
                tui.requestRender();
              },
            };
          }, {
            overlay: true,
            overlayOptions: {
              width: "80%",
              minWidth: 45,
              maxHeight: "80%",
              anchor: "center",
              margin: 2,
            },
          });
        });

        if (outcome.type === "close") return;

        if (outcome.type === "invoke") {
          const ok = await ctx.ui.confirm(`Invoke ${outcome.name}?`, "The full skill content will be added to the chat.");
          if (ok) {
            ctx.ui.setEditorText(`/skill:${outcome.name} `);
            ctx.ui.notify(`Loaded /skill:${outcome.name}`, "info");
            return;
          }
          lastSkill = outcome.name;
          continue;
        }
      }
    },
  });
}


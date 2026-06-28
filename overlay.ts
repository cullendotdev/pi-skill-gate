/**
 * SkillDetailOverlay — TUI overlay for browsing/toggling skill visibility.
 *
 * Renders a sidebar+detail layout with markdown body, search, scroll,
 * and per-project scope indicators.
 */

import { getMarkdownTheme } from "@earendil-works/pi-coding-agent";
import {
  decodeKittyPrintable,
  Key,
  matchesKey,
  Markdown,
  truncateToWidth,
  visibleWidth,
} from "@earendil-works/pi-tui";
import * as fs from "node:fs";
import type { EditScope, RowData, SkillGateTheme, ToggleState } from "./types.js";

// ── Constants ──

/** Fraction of page height to jump on k/j (keep 25% overlap for context). */
const SCROLL_FRACTION = 0.75;

// Sidebar layout constants
const SIDEBAR_ARROW_WIDTH = 2;       // " ▶" or "  " selector prefix
const SIDEBAR_CURRENT_PAD = 1;       // extra space after arrow on current row
const SIDEBAR_NAME_OFFSET = SIDEBAR_ARROW_WIDTH + SIDEBAR_CURRENT_PAD + 1; // = 4: worst-case prefix + safety margin

// ── Helpers ──

/**
 * Highlight the first occurrence of query in ANSI-styled text.
 * Searches visible text (stripped of ANSI codes) and wraps the match region.
 */
export function highlightInStyledText(styled: string, query: string, matchStyle: (t: string) => string): string {
  if (!query) return styled;
  // Case-sensitive literal match first — avoids ANSI-code interference.
  const qi = styled.indexOf(query);
  if (qi >= 0) {
    return styled.slice(0, qi) + matchStyle(query) + styled.slice(qi + query.length);
  }
  // Case-insensitive fallback: ANSI codes contain no lowercase letters, so
  // toLowerCase() preserves their byte offsets and indexOf is safe.
  const lower = styled.toLowerCase();
  const li = lower.indexOf(query.toLowerCase());
  if (li < 0) return styled;
  return styled.slice(0, li) + matchStyle(styled.slice(li, li + query.length)) + styled.slice(li + query.length);
}

export function wrapText(text: string, maxWidth: number): string[] {
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

/** Highlight the first occurrence of query in text using ANSI styles. */
export function highlightMatch(text: string, query: string, baseStyle: (t: string) => string, matchStyle: (t: string) => string): string {
  if (!query) return baseStyle(text);
  const lower = text.toLowerCase();
  const qi = lower.indexOf(query.toLowerCase());
  if (qi < 0) return baseStyle(text);
  return baseStyle(text.slice(0, qi)) + matchStyle(text.slice(qi, qi + query.length)) + baseStyle(text.slice(qi + query.length));
}

/** Wrap a content line with │ border characters, padding to innerW visible width. */
export function borderLine(content: string, innerW: number, T: SkillGateTheme): string {
  const vw = visibleWidth(content);
  const padded = vw < innerW ? content + " ".repeat(innerW - vw) : truncateToWidth(content, innerW);
  return T.dim("│") + padded + T.dim("│");
}

/** Pad a string to the given visible width with trailing spaces. */
export function padTo(content: string, width: number): string {
  const vw = visibleWidth(content);
  return vw < width ? content + " ".repeat(width - vw) : content;
}

// ── Skill body reader ──

const _skillBodyCache = new Map<string, string>();

/** Read the full SKILL.md body (everything after YAML frontmatter). */
export function readSkillBody(filePath: string): string {
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

/** Drop a single cached body (call after the file is edited on disk). */
export function invalidateSkillBody(filePath: string): void {
  _skillBodyCache.delete(filePath);
}

/** Drop every cached body (e.g. after the user edits any skill). */
export function invalidateAllSkillBodies(): void {
  _skillBodyCache.clear();
}

// ── Overlay ──

/** State of the confirm modal shown for bulk actions. */
type PendingConfirm =
  | { kind: "enableAll"; names: string[]; count: number; scope: EditScope }
  | { kind: "disableAll"; names: string[]; count: number; scope: EditScope }
  | { kind: "resetScope"; count: number; scope: EditScope };

export class SkillDetailOverlay {
  private rows: RowData[];
  private currentIdx: number;
  private scrollOffset = 0;
  private getTerminalRows: () => number;
  private theme: SkillGateTheme;
  private md: Markdown;
  private showSidebar = true;
  private showUsageColumn = false;
  private searchMode = false;
  private searchQuery = "";
  private fullTextSearch = false; // when true, search also matches description + body
  private editingScope: EditScope;
  private projectName?: string;
  private hasProject: boolean;
  private pendingConfirm: PendingConfirm | null = null;
  private showHelp = false;
  private helpScroll = 0;

  onClose?: () => void;
  onToggle?: (name: string, state: ToggleState) => void;
  onInvoke?: (name: string) => void;
  onScopeToggle?: () => void;
  onEnableAll?: (names: string[]) => void;
  onDisableAll?: (names: string[]) => void;
  onResetScope?: () => void;
  /** Yank (copy) the current skill's SKILL.md body to the clipboard. */
  onYank?: (name: string, body: string) => void;
  /** Open the current skill's SKILL.md in $VISUAL / $EDITOR. The overlay
   *  closes itself before the editor is launched; the host re-opens it
   *  after the editor exits so the body cache is re-read from disk. */
  onEdit?: (name: string, filePath: string) => void;

  constructor(rows: RowData[], initialIdx: number, getTerminalRows: () => number, theme: SkillGateTheme, editingScope: EditScope, projectName?: string, hasProject = false) {
    this.rows = rows;
    this.currentIdx = Math.max(0, Math.min(initialIdx, rows.length - 1));
    this.getTerminalRows = getTerminalRows;
    this.theme = theme;
    this.md = new Markdown("", 2, 0, getMarkdownTheme());
    this.editingScope = editingScope;
    this.projectName = projectName;
    this.hasProject = hasProject;
  }

  setEditingScope(scope: EditScope): void {
    this.editingScope = scope;
  }

  handleInput(data: string): void {
    if (this.rows.length === 0) return;

    // ── pending reset: r confirms, Esc cancels (does NOT close overlay) ──
    if (this.pendingConfirm) {
      // Modal open: only Enter/y confirms, Esc/n cancels. All other keys
      // (including r, arrows, j/k) are ignored — no accidental confirmations.
      if (matchesKey(data, Key.enter) || data === "y" || data === "Y") {
        const pc = this.pendingConfirm;
        this.pendingConfirm = null;
        if (pc.kind === "enableAll") this.onEnableAll?.(pc.names);
        else if (pc.kind === "disableAll") this.onDisableAll?.(pc.names);
        else if (pc.kind === "resetScope") this.onResetScope?.();
        return;
      }
      if (matchesKey(data, Key.escape) || data === "n" || data === "N") {
        this.pendingConfirm = null;
        return;
      }
      return; // ignore everything else while modal is open
    }

    // ── help mode: ? toggles; Esc/?/q closes; ↑↓/k/j scroll ──
    if (data === "?") {
      this.showHelp = !this.showHelp;
      this.helpScroll = 0;
      return;
    }
    if (this.showHelp) {
      if (matchesKey(data, Key.escape) || data === "q" || data === "Q" || data === "?") {
        this.showHelp = false;
        this.helpScroll = 0;
        return;
      }
      if (matchesKey(data, Key.up) || data === "k") {
        this.helpScroll = Math.max(0, this.helpScroll - 1);
        return;
      }
      if (matchesKey(data, Key.down) || data === "j") {
        this.helpScroll += 1;
        return;
      }
      return; // ignore everything else while help is open
    }

    // ── search mode ──
    if (this.searchMode) {
      // Bulk keys are NOT intercepted in search mode — printable chars append
      // to the query. To bulk-apply to a filtered set: type query → Enter
      // (commits query, filter persists) → press a/A/r.
      if (matchesKey(data, Key.escape)) {
        this.searchMode = false;
        this.searchQuery = "";
        this.fullTextSearch = false;
        return;
      }
      if (matchesKey(data, Key.enter)) {
        this.searchMode = false;
        return;
      }
      if (matchesKey(data, Key.backspace)) {
        this.searchQuery = this.searchQuery.slice(0, -1);
        this.onSearchQueryChanged();
        return;
      }
      if (matchesKey(data, Key.up)) {
        const f = this.getFilteredIndices();
        const pos = f.indexOf(this.currentIdx);
        if (pos > 0) this.currentIdx = f[pos - 1];
        else if (f.length > 0) this.currentIdx = f[f.length - 1];
        this.scrollOffset = 0;
        return;
      }
      if (matchesKey(data, Key.down)) {
        const f = this.getFilteredIndices();
        const pos = f.indexOf(this.currentIdx);
        if (pos >= 0 && pos < f.length - 1) this.currentIdx = f[pos + 1];
        else if (f.length > 0) this.currentIdx = f[0];
        this.scrollOffset = 0;
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
        this.onSearchQueryChanged();
        return;
      }
      return; // ignore other keys while searching
    }

    // ── enter search mode on "/" (name-only) or "f" (full-text) ──
    if (data === "/" || matchesKey(data, Key.slash)) {
      this.searchMode = true;
      this.searchQuery = "";
      this.fullTextSearch = false;
      return;
    }
    if (data === "f" || data === "F") {
      this.searchMode = true;
      this.searchQuery = "";
      this.fullTextSearch = true;
      return;
    }

    // ── bulk actions: open a confirm modal (excluded while a modal is open) ──
    if (data === "a") {
      const names = this.getBulkableNames();
      if (names.length > 0) {
        this.pendingConfirm = { kind: "enableAll", names, count: names.length, scope: this.editingScope };
      }
      return;
    }
    if (data === "A") {
      const names = this.getBulkableNames();
      if (names.length > 0) {
        this.pendingConfirm = { kind: "disableAll", names, count: names.length, scope: this.editingScope };
      }
      return;
    }
    if (data === "r") {
      const count = this.countScopeToggles();
      if (count > 0) {
        this.pendingConfirm = { kind: "resetScope", count, scope: this.editingScope };
      }
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
      // If a filter is active (from a previous search), clear it first
      if (this.searchQuery) {
        this.searchQuery = "";
        this.fullTextSearch = false;
        this.onSearchQueryChanged();
        return;
      }
      this.onClose?.();
      return;
    }
    if (data === "b" || data === "B") {
      this.showSidebar = !this.showSidebar;
      return;
    }
    if (data === "u" || data === "U") {
      this.showUsageColumn = !this.showUsageColumn;
      return;
    }
    if ((data === "g" || data === "G") && this.hasProject) {
      this.onScopeToggle?.();
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
    if (data === "y" || data === "Y") {
      const row = this.rows[this.currentIdx];
      if (row) this.onYank?.(row.name, readSkillBody(row.filePath));
      return;
    }
    if (data === "o" || data === "O") {
      const row = this.rows[this.currentIdx];
      if (row) this.onEdit?.(row.name, row.filePath);
      return;
    }
    if (data == "k") {
      this.scrollOffset = Math.max(0, this.scrollOffset - Math.ceil(this.bodyHeightEstimate() * SCROLL_FRACTION));
      return;
    }
    if (data == "j") {
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

  /** Compute filtered skill indices ordered by match quality (prefix first, then substring).
 *  The filter is active whenever `searchQuery` is non-empty, regardless of
 *  whether `searchMode` is on — this lets the sidebar keep filtering after
 *  the user commits a search with Enter.
 *
 *  When `fullTextSearch` is true, matches also scan description and skill body
 *  (SKILL.md content) in addition to the skill name. */
  private getFilteredIndices(): number[] {
    const q = this.searchQuery.toLowerCase();
    if (!q) return this.rows.map((_, i) => i);
    const prefix: number[] = [];
    const substr: number[] = [];
    const descBody: number[] = []; // description/body matches (full-text only)
    for (let i = 0; i < this.rows.length; i++) {
      const r = this.rows[i];
      const name = r.name.toLowerCase();
      if (name.startsWith(q)) {
        prefix.push(i);
      } else if (name.includes(q)) {
        substr.push(i);
      } else if (this.fullTextSearch) {
        // Search description and skill body
        const desc = r.description.toLowerCase();
        if (desc.includes(q)) {
          descBody.push(i);
          continue;
        }
        try {
          const body = readSkillBody(r.filePath).toLowerCase();
          if (body.includes(q)) {
            descBody.push(i);
          }
        } catch {
          // skip on read errors
        }
      }
    }
    prefix.sort((a, b) => this.rows[a].name.localeCompare(this.rows[b].name));
    substr.sort((a, b) => this.rows[a].name.localeCompare(this.rows[b].name));
    descBody.sort((a, b) => this.rows[a].name.localeCompare(this.rows[b].name));
    return [...prefix, ...substr, ...descBody];
  }

  /** Called when the search query changes: jump to the best match. */
  private onSearchQueryChanged(): void {
    const filtered = this.getFilteredIndices();
    if (filtered.length === 0) { this.scrollOffset = 0; return; }
    if (!filtered.includes(this.currentIdx)) {
      this.currentIdx = filtered[0];
    }
    this.scrollOffset = 0;
  }

  /** Names of skills the bulk actions should target: visible (filter-aware)
   *  AND not natively-disabled. Returns sorted names. */
  private getBulkableNames(): string[] {
    const filtered = this.getFilteredIndices();
    return filtered
      .map((i) => this.rows[i])
      .filter((r) => !r.disableModelInvocation)
      .map((r) => r.name)
      .sort((a, b) => a.localeCompare(b));
  }

  /** Count of toggles in the current scope: rows whose `source` matches.
   *  Global scope counts rows with a global toggle (source === "global");
   *  project scope counts rows with a project override (source === "project"). */
  private countScopeToggles(): number {
    if (this.editingScope === "global") {
      return this.rows.filter((r) => r.source === "global").length;
    }
    return this.rows.filter((r) => r.source === "project").length;
  }

  // ── sidebar width (based on longest skill name + ▶ indicator) ──
  // Capped at 30% of terminal width so detail column always has room.
  private usageColumnWidth(): number {
    if (!this.showUsageColumn) return 0;
    const maxCount = Math.max(...this.rows.map((r) => r.usageCount), 0);
    const digits = String(maxCount).length;
    // Column: │ (1) + count (digits) + 1 space on each side for centering
    return 1 + digits + 2;
  }

  private sidebarWidth(terminalWidth: number): number {
    const maxLen = Math.max(...this.rows.map((r) => r.name.length), 0);
    // Extra room for ·G / ·P indicators when project-context is active
    const indicatorPad = this.hasProject ? 3 : 0;
    const usageColW = this.usageColumnWidth();
    const natural = maxLen + SIDEBAR_NAME_OFFSET + indicatorPad + usageColW;
    const cap = Math.max(14, Math.floor(terminalWidth * 0.30));
    return Math.max(14, Math.min(natural, cap));
  }

  /** Rough estimate of available body lines for scroll calculations. */
  private bodyHeightEstimate(): number {
    return Math.max(8, Math.floor(this.getTerminalRows() * 0.5));
  }

  // ── render sidebar column (height lines, sidebarW wide) ──
  // When in search mode, only matching skills are shown with highlighted search terms.
  private renderSidebar(height: number, sidebarW: number): string[] {
    const T = this.theme;
    const lines: string[] = [];
    const skillArea = Math.max(0, height - 2); // header + separator

    const filtered = this.getFilteredIndices();
    const total = filtered.length;

    // Auto-scroll to keep selected skill visible
    let sbScroll = 0;
    if (total > skillArea) {
      const selPos = filtered.indexOf(this.currentIdx);
      sbScroll = Math.max(0, selPos - Math.floor(skillArea / 2));
      sbScroll = Math.min(sbScroll, total - skillArea);
    }

    const usageColW = this.usageColumnWidth();

    if (this.showUsageColumn) {
      // Two-column header with Skills + Uses labels
      const skillsLabel = T.dim(" Skills");
      const idxLabel = T.accent(`[${this.currentIdx + 1}/${this.rows.length}]`);
      const usesLabel = T.dim("Uses");
      const leftPart = skillsLabel + " " + idxLabel;
      const leftVw = visibleWidth(leftPart);
      const usesVw = visibleWidth(usesLabel);
      const gap = Math.max(1, sidebarW - leftVw - usesVw);
      lines.push(leftPart + " ".repeat(gap) + usesLabel);
      // Separator with ┬ at column boundary
      const skillsSepW = sidebarW - usageColW;
      lines.push(T.dim("─".repeat(skillsSepW)) + T.dim("┬") + T.dim("─".repeat(usageColW - 1)));
    } else {
      // Single-column header (no usage column)
      const leftLabel = T.dim(" Skills");
      const idxLabel = T.accent(`[${this.currentIdx + 1}/${this.rows.length}]`);
      const leftVw = visibleWidth(leftLabel);
      const idxVw = visibleWidth(idxLabel);
      const gap = Math.max(1, sidebarW - leftVw - idxVw);
      lines.push(leftLabel + " ".repeat(gap) + idxLabel);
      lines.push(T.dim("─".repeat(sidebarW)));
    }

    if (total === 0 && (this.searchMode || this.fullTextSearch)) {
      // No matches
      const msg = T.dim(" (no matches)");
      lines.push(msg + " ".repeat(Math.max(0, sidebarW - visibleWidth(msg))));
    } else {
      // Account for potential ·G/·P indicator when computing name truncation
      const indicatorBudget = this.hasProject ? visibleWidth(T.dim(" ·G")) : 0;

      for (let i = 0; i < skillArea; i++) {
        const li = i + sbScroll;
        const ri = filtered[li];
        if (ri !== undefined) {
          const r = this.rows[ri];
          const isCurrent = ri === this.currentIdx;
          const arrow = isCurrent ? " " + T.accent("▶") : "  ";

          // Determine base styling for this row
          let baseStyle: (t: string) => string;
          if (r.disableModelInvocation) {
            baseStyle = (t) => T.nativeDisabled(t);
          } else if (r.state === "enabled") {
            baseStyle = (t) => T.enabled(t);
          } else if (r.source === "project" && r.globalEnabled) {
            // Enabled globally but explicitly disabled by project override
            baseStyle = (t) => T.error(t);
          } else {
            baseStyle = (t) => T.dim(t);
          }

          // Highlight search match within the name
          let styledName: string;
          if ((this.searchMode || this.fullTextSearch) && this.searchQuery) {
            styledName = highlightMatch(r.name, this.searchQuery, baseStyle, (t) => T.accent(T.bold(t)));
          } else {
            styledName = baseStyle(r.name);
          }

          if (this.showUsageColumn) {
            // Column mode: no suffix, name truncated to make room for │ + count
            styledName = truncateToWidth(styledName, sidebarW - SIDEBAR_NAME_OFFSET - indicatorBudget - usageColW);
          } else {
            // No suffix; name uses full sidebar width minus arrow + indicator pad
            styledName = truncateToWidth(styledName, sidebarW - SIDEBAR_NAME_OFFSET - indicatorBudget);
          }

          // Build final row
          let styled: string;
          if (isCurrent) {
            styled = T.accent(arrow + " " + styledName);
          } else {
            styled = arrow + styledName;
          }

          // Source inheritance indicator
          if (!r.disableModelInvocation) {
            if (this.editingScope === "project" && r.source === "global") {
              styled += T.dim(" ·G");
            } else if (this.editingScope === "global" && r.source === "project") {
              styled += T.dim(" ·P");
            }
          }

          // Dedicated usage column with vertical │ divider
          if (usageColW > 0) {
            // Pad name+indicator with spaces so the │ sits at sidebarW - usageColW
            // (same column as the ┬ in the separator and aligned with "Uses" header)
            const dividerPos = sidebarW - usageColW;
            const currentVw = visibleWidth(styled);
            const padToDivider = Math.max(0, dividerPos - currentVw);
            styled += " ".repeat(padToDivider);
            // Now append the │ divider + centered count column
            const countStr = String(r.usageCount);
            const digits = countStr.length;
            // Center the count in (usageColW - 1) chars (after the │)
            // With 1 space on each side, this works for 1-, 2-, 3-digit counts
            const leftPad = Math.max(1, Math.floor((usageColW - 1 - digits) / 2));
            const rightPad = Math.max(1, usageColW - 1 - digits - leftPad);
            styled += T.dim("│") + " ".repeat(leftPad) + T.dim(countStr) + " ".repeat(rightPad);
            lines.push(styled);
          } else {
            // No column: pad the row to sidebarW
            const vw = visibleWidth(styled);
            lines.push(vw < sidebarW ? styled + " ".repeat(sidebarW - vw) : styled);
          }
        } else {
          lines.push(" ".repeat(sidebarW));
        }
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
      let sourceCtx = "";
      let toggleHint = T.dim("  [space to toggle]");
      if (this.editingScope === "project" && row.source === "global") {
        sourceCtx = T.dim(" · inherited from global");
        toggleHint = T.dim("  [space to override]");
      } else if (this.editingScope === "global" && row.source === "project") {
        sourceCtx = T.dim(" · overridden at project level");
      }
      descLines.push(" " + T.bold("Status: ") + st + sourceCtx + toggleHint);
    }

    // Usage count
    if (row.usageCount > 0) {
      descLines.push(" " + T.bold("Usage: ") + T.dim(`Used ${row.usageCount}x`));
    } else {
      descLines.push(" " + T.bold("Usage: ") + T.dim("—"));
    }

    if (row.description) {
      descLines.push(T.bold(" Description:"));
      const hlActive = this.fullTextSearch && this.searchQuery;
      for (const dl of wrapText(row.description, padW)) {
        if (hlActive) {
          descLines.push("  " + highlightMatch(dl, this.searchQuery, (t) => T.muted(t), (t) => T.accent(T.bold(t))));
        } else {
          descLines.push("  " + T.muted(dl));
        }
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
    // when contentW shrinks/grows. Converges in ≤3 passes; cap at 5 for safety.
    let gutterW = 4;
    let scrollW = 1;
    let needsScrollbar = true;
    // contentW must be positive — Markdown.render() uses String.repeat(width)
    // internally and will crash with a negative or zero value.
    const MIN_CONTENT_W = 10;
    const MAX_CONVERGE_PASSES = 5;
    let contentW = Math.max(MIN_CONTENT_W, detailW - gutterW - scrollW);
    this.md.setText(body);
    let mdLines = this.md.render(contentW);
    for (let pass = 0; pass < MAX_CONVERGE_PASSES; pass++) {
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

      let mdLine = mdLines[i];
      if (this.fullTextSearch && this.searchQuery) {
        mdLine = highlightInStyledText(mdLine, this.searchQuery, (t) => T.accent(T.bold(t)));
      }
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

    // ── title bar + header ──
    const headerLines = this.renderTopSection(innerW, lines);

    // ── separator ──
    lines.push(T.dim("│" + T.dim("─".repeat(innerW)) + "│"));

    // ── layout ──
    const contentBudget = this.computeContentBudget(headerLines);
    const sidebarW = this.sidebarWidth(width);
    const detailW = innerW - sidebarW - 1;
    const useSidebar = this.showSidebar && detailW >= 20;

    if (useSidebar) {
      this.renderSidebarLayout(innerW, sidebarW, detailW, contentBudget, lines);
    } else {
      this.renderFullWidthLayout(innerW, contentBudget, lines);
    }

    // ── bottom border ──
    lines.push(T.dim("└" + "─".repeat(innerW) + "┘"));

    // ── confirm modal overlay (replaces rows in the center of the overlay) ──
    if (this.pendingConfirm) {
      this.composeModal(lines, this.renderModal(width), width);
    }

    // ── help modal overlay (centered, scrollable) ──
    if (this.showHelp) {
      this.composeModal(lines, this.renderHelpModal(width, lines.length), width);
    }

    return lines;
  }

  /** Compose a pre-built modal box onto the rendered overlay lines, centered
   *  both horizontally and vertically. Lines outside the modal are padded so
   *  they remain plain background. */
  private composeModal(lines: string[], modal: { lines: string[]; width: number; height: number }, width: number): void {
    const startRow = Math.max(0, Math.floor((lines.length - modal.height) / 2));
    const colOffset = Math.max(0, Math.floor((width - modal.width) / 2));
    const padLeft = " ".repeat(colOffset);
    const padRight = " ".repeat(Math.max(0, width - colOffset - modal.width));
    for (let i = 0; i < modal.lines.length; i++) {
      const r = startRow + i;
      if (r >= 0 && r < lines.length) {
        lines[r] = padLeft + modal.lines[i] + padRight;
      }
    }
  }

  /** Build the confirm modal box. Returns lines + dimensions for the
   *  caller to position over the background. Border color is warning for
   *  enable/disable actions and error for reset (destructive). */
  private renderModal(width: number): { lines: string[]; width: number; height: number } {
    const T = this.theme;
    const pc = this.pendingConfirm!;
    const border = pc.kind === "resetScope" ? T.error : T.warning;

    // Title
    const title =
      pc.kind === "enableAll" ? "Confirm Enable All" :
        pc.kind === "disableAll" ? "Confirm Disable All" :
          "Confirm Reset";

    // Body lines (plain text; styled at render time)
    const bodyLines: string[] = [];
    if (pc.kind === "enableAll" || pc.kind === "disableAll") {
      const verb = pc.kind === "enableAll" ? "Enable" : "Disable";
      bodyLines.push(`${verb} ${pc.count} non-native-disabled skills?`);
    } else {
      bodyLines.push(`Reset all toggles in ${pc.scope} scope?`);
      if (pc.count > 0) {
        bodyLines.push(`This clears ${pc.count} toggle${pc.count === 1 ? "" : "s"}.`);
      }
    }
    bodyLines.push(`Scope: ${pc.scope}`);

    const footerText = "Enter/y confirm · Esc/n cancel";

    // Compute width — auto-fit content with sensible bounds
    const longest = Math.max(title.length, ...bodyLines.map((l) => l.length), footerText.length);
    const innerW = longest + 2; // 1 space padding on each side
    const boxW = innerW + 2; // +2 for left/right borders

    // Helper: build a content row with colored border
    const row = (content: string) => {
      const vw = visibleWidth(content);
      const padded = vw < innerW ? content + " ".repeat(innerW - vw) : truncateToWidth(content, innerW);
      return border("│") + padded + border("│");
    };

    const horiz = (left: string, right: string) =>
      border(left + "─".repeat(boxW - 2) + right);

    const lines: string[] = [];
    lines.push(horiz("┌", "┐"));
    lines.push(row(" " + T.accent(T.bold(title))));
    lines.push(row(""));
    for (const bl of bodyLines) lines.push(row(" " + bl));
    lines.push(row(""));
    lines.push(row(" " + T.dim(footerText)));
    lines.push(horiz("└", "┘"));

    return { lines, width: boxW, height: lines.length };
  }

  /** Build the scrollable help modal listing every keybind. The box is
   *  auto-sized to the widest row (capped to the overlay width) and centered;
   *  when it would be taller than the overlay, ↑/↓/k/j scroll the content. */
  private renderHelpModal(width: number, availableHeight: number): { lines: string[]; width: number; height: number } {
    const T = this.theme;
    const border = (s: string) => T.dim(s);
    const padX = 1;
    const keyGap = 2;

    const sections: { title: string; entries: [string, string][] }[] = [
      { title: "Navigation", entries: [
        ["↑  ↓", "Move between skills (sidebar)"],
        ["k  j", "Scroll skill body up / down"],
        ["Home / End", "Jump to top / bottom of body"],
      ] },
      { title: "Search", entries: [
        ["/", "Name-only search"],
        ["f", "Full-text search (name + body)"],
        ["↑  ↓", "Next / previous match (in search)"],
        ["Enter", "Commit search (filter persists)"],
        ["Backspace", "Delete last char"],
        ["Esc", "Clear query / leave search"],
      ] },
      { title: "Skill actions", entries: [
        ["Space", "Toggle current skill on/off"],
        ["Enter", "Invoke skill (load /skill:name)"],
        ["y", "Yank skill body to clipboard"],
        ["o", "Open skill file in $VISUAL / $EDITOR"],
      ] },
      { title: "View & scope", entries: [
        ["b", "Toggle sidebar"],
        ["u", "Toggle usage column"],
        ["g", "Switch global ↔ project scope (project only)"],
      ] },
      { title: "Bulk (filtered set)", entries: [
        ["a", "Enable all non-native-filtered skills"],
        ["A", "Disable all non-native-filtered skills"],
        ["r", "Reset all toggles in current scope"],
      ] },
      { title: "Confirm modal", entries: [
        ["Enter / y", "Confirm the pending bulk action"],
        ["Esc / n", "Cancel the pending bulk action"],
      ] },
      { title: "Global", entries: [
        ["?", "Toggle this help"],
        ["Esc", "Close the overlay"],
      ] },
    ];

    // Style the body content lines (pre-baked with theme colors). These are
    // rebuilt whenever invalidate() runs (e.g. theme change) because we
    // re-call renderHelpModal on every render.
    const titleText = "Skill Gate — Keybindings";
    const footerText = "? Esc close · ↑↓ k j scroll";
    const styledTitle = T.accent(T.bold(titleText));
    const styledFooter = T.dim(footerText);

    type BodyLine = { kind: "blank" | "header" | "entry"; key?: string; desc?: string; text?: string };
    const body: BodyLine[] = [];
    body.push({ kind: "blank" });
    for (const s of sections) {
      body.push({ kind: "header", text: s.title });
      for (const [k, d] of s.entries) body.push({ kind: "entry", key: k, desc: d });
      body.push({ kind: "blank" });
    }
    body.push({ kind: "blank" });

    // Auto-fit box width to widest content (capped to the overlay width).
    let rawMax = Math.max(
      visibleWidth(titleText),
      visibleWidth(footerText),
    );
    for (const s of sections) {
      rawMax = Math.max(rawMax, visibleWidth(s.title));
      for (const [k, d] of s.entries) {
        rawMax = Math.max(rawMax, visibleWidth(k) + keyGap + visibleWidth(d));
      }
    }
    let innerW = rawMax + 2 * padX;
    innerW = Math.min(innerW, Math.max(width - 2, 20));
    const boxW = innerW + 2;

    // Compute the key column width so descriptions align.
    let keyCol = 0;
    for (const s of sections) for (const [k] of s.entries) keyCol = Math.max(keyCol, visibleWidth(k));
    // The entry line is `padX spaces + key + keyGap spaces + desc`. If it overflows
    // innerW, wrap/truncate the description to fit.
    const descMax = innerW - padX - keyCol - keyGap - padX;

    // Build the content lines for the body, handling wrap/truncate of descriptions.
    const contentLines: string[] = [];
    const row = (content: string) => {
      const vw = visibleWidth(content);
      const padded = vw < innerW ? content + " ".repeat(innerW - vw) : truncateToWidth(content, innerW, "");
      return border("│") + padded + border("│");
    };
    const horiz = (l: string, r: string) => border(l + "─".repeat(boxW - 2) + r);

    // We render the box around content; for scrolling, only the inner content
    // portion scrolls (top border + title pin, footer + bottom border pin).
    const pinnedTopLines: string[] = [
      horiz("┌", "┐"),
      row(" ".repeat(padX) + styledTitle),
      row(""),
    ];
    const pinnedBottomLines: string[] = [
      row(""),
      row(" ".repeat(padX) + styledFooter),
      horiz("└", "┘"),
    ];

    for (const b of body) {
      if (b.kind === "blank") {
        contentLines.push(row(""));
      } else if (b.kind === "header") {
        contentLines.push(row(" ".repeat(padX) + T.accent(T.bold(b.text!))));
      } else {
        const keyPart = b.key! + " ".repeat(keyCol - visibleWidth(b.key!) + keyGap);
        // Wrap the description to descMax, prefix each wrapped line with the
        // key column (only the first line shows the key; continuation lines
        // use blank space so descriptions stay aligned).
        const descLines = descMax > 4 ? wrapText(b.desc!, descMax) : [truncateToWidth(b.desc!, Math.max(1, innerW - padX - keyCol - keyGap - padX))];
        for (let i = 0; i < descLines.length; i++) {
          const prefix = i === 0 ? keyPart : " ".repeat(keyCol + keyGap);
          contentLines.push(row(" ".repeat(padX) + T.dim(prefix) + T.muted(descLines[i]!)));
        }
      }
    }

    // Determine the visible window into contentLines based on available height.
    const pinnedH = pinnedTopLines.length + pinnedBottomLines.length;
    const availInner = Math.max(0, availableHeight - pinnedH);
    const visibleCount = Math.min(contentLines.length, availInner);
    const maxScroll = Math.max(0, contentLines.length - visibleCount);
    const start = Math.min(this.helpScroll, maxScroll);
    if (this.helpScroll > maxScroll) this.helpScroll = maxScroll; // clamp
    const window = contentLines.slice(start, start + visibleCount);

    const lines = [...pinnedTopLines, ...window, ...pinnedBottomLines];
    return { lines, width: boxW, height: lines.length };
  }

  /** Render title bar + subtitle/search/scope header. Returns header line count. */
  private renderTopSection(innerW: number, lines: string[]): number {
    const T = this.theme;

    // Title bar
    const vc = this.rows.filter((r) => !r.disableModelInvocation && r.state === "enabled").length;
    const tc = this.rows.length;
    const projLabel = this.projectName ? T.dim(` · ${this.projectName}`) : "";
    lines.push(borderLine(" " + T.accent(T.bold(" Skill Gate")) + projLabel + T.dim(` ── ${vc}/${tc} skills enabled`), innerW, T));

    // Header: search bar, scope indicator, or subtitle
    if (this.searchMode) {
      const cursor = this.theme.accent("█");
      const prefix = this.fullTextSearch ? T.dim(" f") : T.dim(" /");
      const searchLabel = prefix + " " + this.searchQuery + cursor;
      lines.push(borderLine(searchLabel, innerW, T));
      return 1;
    }
    // When a full-text filter is active (committed via Enter), show a hint
    if (this.fullTextSearch && this.searchQuery) {
      const filterLabel = T.dim(`  Full-text filter: "${this.searchQuery}"`) + T.muted("  [Esc to clear]");
      lines.push(borderLine(filterLabel, innerW, T));
      return 1;
    }
    if (this.hasProject) {
      const otherScope = this.editingScope === "global" ? "project" : "global";
      let scopeColor = this.editingScope === "global" ? T.enabled : T.warning
      const scopeLabel =
        T.dim(`  Editing: `) +
        scopeColor(this.editingScope) +
        T.muted(`  [g] to edit ${otherScope}`);
      lines.push(borderLine(scopeLabel, innerW, T));
      return 1;
    }
    const subtitle = "Control which skills the model can see. Enabled skills are injected into the system prompt; disabled skills are hidden.";
    const subtitleLines = wrapText(subtitle, innerW - 2);
    for (const sl of subtitleLines) {
      lines.push(borderLine(T.muted("  " + sl), innerW, T));
    }
    return subtitleLines.length;
  }

  /** Compute available content budget for body+footer, accounting for chrome. */
  private computeContentBudget(headerLines: number): number {
    const termRows = this.getTerminalRows();
    const overlayMax = Math.max(12, Math.floor(termRows * 0.8));
    const chrome = 3 + headerLines; // top border, title, header, separator
    const bottom = 1;               // bottom border
    return Math.max(10, overlayMax - chrome - bottom);
  }

  /** Render body with sidebar. */
  private renderSidebarLayout(innerW: number, sidebarW: number, detailW: number, contentBudget: number, lines: string[]): void {
    const T = this.theme;

    // Two-pass rendering: compute footer lines first, then re-allocate body budget.
    let { descLines, bodyLines, mdMeta } = this.renderDetail(detailW, contentBudget, 1);
    let wrappedFooter = this.footerLines(mdMeta, detailW);
    if (wrappedFooter.length > 1) {
      const adjustedBudget = contentBudget - (wrappedFooter.length - 1);
      ({ descLines, bodyLines, mdMeta } = this.renderDetail(detailW, adjustedBudget, wrappedFooter.length));
      wrappedFooter = this.footerLines(mdMeta, detailW);
    }

    const promptHeader = [" " + T.bold("Prompt:"), ""];
    const bodyHeight = descLines.length + promptHeader.length + bodyLines.length + 1 + wrappedFooter.length;
    const sidebarLines = this.renderSidebar(bodyHeight, sidebarW);

    const detailAll: string[] = [
      ...descLines.map((l) => padTo(l, detailW)),
      ...promptHeader.map((l) => padTo(l, detailW)),
      ...bodyLines.map((l) => padTo(l, detailW)),
      padTo(T.dim("─".repeat(detailW)), detailW),
      ...wrappedFooter.map((l) => padTo(l, detailW)),
    ];

    // Balance sidebar and detail height
    while (sidebarLines.length < detailAll.length) sidebarLines.push(" ".repeat(sidebarW));
    while (detailAll.length < sidebarLines.length) detailAll.push(" ".repeat(detailW));

    for (let i = 0; i < sidebarLines.length; i++) {
      lines.push(T.dim("│") + sidebarLines[i] + T.dim("│") + detailAll[i] + T.dim("│"));
    }
  }

  /** Render body in full-width mode (no sidebar). */
  private renderFullWidthLayout(innerW: number, contentBudget: number, lines: string[]): void {
    const T = this.theme;

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

  /** Wrap the footer text to fit maxW and return styled lines. */
  private footerLines(meta: { bodyLength: number; remaining: number; maxOffset: number }, maxW: number): string[] {
    // Build the raw left-side text (scroll info + keybindings). When a
    // confirm modal is open, the modal itself shows the relevant key hints,
    // so the footer just shows neutral scroll/nav info.
    const hasMore = meta.bodyLength > meta.remaining;
    const bulkKeys = " · a A r bulk";
    const helpKey = " · ? help";
    const searchKey = this.fullTextSearch ? "f" : "/";
    let left: string;
    if (this.searchMode) {
      left = ` ${searchKey} search · Esc cancel · Enter confirm${helpKey}`;
    } else if (hasMore) {
      const pct = meta.maxOffset > 0 ? Math.round((this.scrollOffset / meta.maxOffset) * 100) : 0;
      const up = this.scrollOffset > 0 ? "↑" : " ";
      const endLine = Math.min(this.scrollOffset + meta.remaining, meta.bodyLength);
      const dn = endLine < meta.bodyLength ? "↓" : " ";
      left = ` ${up} ${pct}% ${dn}  k/j scroll · space toggle · / search${bulkKeys}${helpKey} · o open · y yank · enter invoke · Esc close`;
    } else {
      left = ` ↑↓ skills · space toggle · / search${bulkKeys}${helpKey} · o open · y yank · enter invoke · Esc close`;
    }
    const idx = this.searchMode
      ? (() => {
        const fi = this.getFilteredIndices();
        const pos = fi.indexOf(this.currentIdx);
        return this.theme.accent(`[${pos >= 0 ? pos + 1 : 0}/${fi.length}]`);
      })()
      : this.theme.accent(`[${this.currentIdx + 1}/${this.rows.length}]`);

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

  invalidate(): void {
    this.md.invalidate();
  }
}

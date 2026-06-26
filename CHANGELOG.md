# Changelog

## 0.8.2 — 2026-06-26

### Added
- **Help modal (`?`)** — press `?` anywhere in the overlay (except over a
  confirm modal) to open a bordered, centered keybindings reference. Scroll
  with `↑/↓` or `k/j`; close with `?`, `Esc`, or `q`. The modal auto-sizes to
  the widest key/description and is tappable from search mode too. The footer
  now advertises `? help`.
- 8 new tests (220 total, up from 212)

## 0.8.1 — 2026-06-26

### Added
- **Yank body to clipboard** — press `y` (or `Y`) in the overlay to copy the
  current skill's full `SKILL.md` body (everything after the YAML frontmatter)
  to the system clipboard. A notification confirms the copy. Uses pi's
  cross-platform `copyToClipboard` (native addon / `pbcopy` / `wl-copy` /
  `xclip` / OSC 52 fallbacks).

---

## 0.8.0 — 2026-06-25

### Added
- **Full-text search** — press `f` (or `F`) to search through skill descriptions and
  SKILL.md body content in addition to skill names. The sidebar filters to show only
  matching skills, and matching text is highlighted in both the description section
  and the rendered markdown body.
- **`highlightInStyledText` helper** — highlights the first occurrence of a query
  within ANSI-styled text (rendered markdown), with case-insensitive fallback.
  Exported for reuse.
- **Full-text filter label** — after committing a full-text search with Enter, the
  header shows a persistent `Full-text filter: "..."` label with an `[Esc to clear]`
  hint. The filter survives exiting search mode.
- **Esc clears filter before closing** — when a search filter is active in normal
  mode, the first Esc clears it; the second Esc closes the overlay.
- 30 new tests (209 total, up from 179)

### Changed
- Header now distinguishes full-text search (`f`) from name-only search (`/`) in
  the search bar prefix.
- Footer key hints updated to show `f full-text` alongside the existing `/ search`.
- Sidebar name highlighting now persists with a full-text filter even after exiting
  search mode.

---

## 0.7.0 — 2026-06-23

### Added
- **Usage analytics** — every `/skill:name` invocation is counted via the `input` event hook and persisted to `~/.pi/agent/config/skill-gate-analytics.json`
- **`Usage:` line in detail view** — always visible below Status; shows `Used Nx` (dimmed) or `—` for never-used skills
- **Toggleable "Uses" column in sidebar** — press `u` to show a dedicated column with a vertical `│` divider aligned to the `┬` in the separator. Numbers are centered; column width auto-sizes for 1-, 2-, and 3-digit counts
- Exported persistence helpers: `loadAnalytics`, `saveAnalytics`, `incrementSkillUsage`, `invalidateAnalyticsCache`
- 33 new tests (179 total, up from 146)

### Changed
- Sidebar header now shows a two-column layout (`Skills [n/m] Uses`) with a `┬` divider when the column is enabled; default single-column layout when `u` is off
- `RowData` gained a `usageCount: number` field

---

## 0.6.0 — 2026-06-23

### Added
- **Bulk actions** in the overlay: `a` enables all non-native-disabled skills, `A` disables them, `r` resets the current scope. Bulk respects the active search filter
- **Confirm modals** for all bulk actions: warning border (yellow) for enable/disable, error border (red) for reset. `Enter` / `y` confirms, `Esc` / `n` cancels. All other keys are ignored while a modal is open to prevent accidental double-confirms
- `persistBulkToggle()` and `resetScope()` exported persistence helpers — single-write bulk operations with project-override pruning
- `invalidateConfigCache()` for external edits to `skill-gate.json` mid-session
- 45 new tests (146 total, up from 101)

### Changed
- **Search filter persists** past search mode: pressing `Enter` commits the query, but the sidebar and bulk actions keep filtering until the query is cleared with `Esc`
- `loadConfig()` now caches the parsed config in memory; `persistToggle` and `saveConfig` keep the cache in sync, so `before_agent_start` makes zero filesystem reads per agent turn
- Bulk actions alphabetize the affected skill list for deterministic ordering

---

## 0.5.0 — 2026-06-22

### Added
- Comprehensive test suite (101 tests) using vitest
  - Config persistence: `loadConfig`, `saveConfig`, `loadEffectiveState`, `persistToggle`
  - System prompt injection: `buildVisibleBlock`
  - Rendering helpers: `wrapText`, `highlightMatch`, `borderLine`, `padTo`
  - Skill body reader: `readSkillBody`
  - Overlay logic: `getFilteredIndices`, `onSearchQueryChanged`, `handleInput` (search + normal modes)
- `test` and `test:watch` npm scripts
- `vitest.config.ts` for test configuration

### Changed
- Exported previously-private functions for testability: `loadConfig`, `saveConfig`, `loadEffectiveState`, `persistToggle`, `buildVisibleBlock`, `makeTheme`, `wrapText`, `highlightMatch`, `borderLine`, `padTo`, `readSkillBody`
- Updated `tsconfig.json` to include test files
- Fixed `package.json` `"files"` field to include `overlay.ts` and `types.ts` (regression from 0.4.0 refactor)

---

## 0.4.0 — 2026-06-22

### Changed
- **Modular refactoring**: Split 1011-line `index.ts` into three files:
  - `index.ts` (266 lines) — config persistence, skill discovery, system prompt hook, command handler
  - `overlay.ts` (704 lines) — `SkillDetailOverlay` class + rendering helpers
  - `types.ts` (46 lines) — shared interfaces: `ToggleState`, `EditScope`, `RowData`, `SkillVisibility`, `SkillGateTheme`, `SkillGateConfig`
- Extracted `SkillVisibility` interface; `buildVisibleBlock` no longer forces dummy `source`/`globalEnabled` fields
- Decomposed `render()` into `renderTopSection()`, `computeContentBudget()`, `renderSidebarLayout()`, `renderFullWidthLayout()`
- Named sidebar constants (`SIDEBAR_ARROW_WIDTH`, `SIDEBAR_CURRENT_PAD`, `SIDEBAR_NAME_OFFSET`) replace magic numbers
- Adaptive sidebar width capped at 30% of terminal width (was hardcoded 28)
- Added convergence loop safety: `MAX_CONVERGE_PASSES = 5`

### Removed
- Dead code: orphaned `footerLine()`/`footerText()` methods (27 lines)

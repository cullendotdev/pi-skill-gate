# Changelog

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

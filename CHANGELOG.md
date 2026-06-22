# Changelog

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

/**
 * pi-skill-gate — Interactive skill visibility manager.
 *
 * Overlay-based UI for toggling skill visibility and browsing skill bodies.
 * Uses pi's ResourceLoader API for skill discovery.
 *
 * Persistence: ~/.pi/agent/config/skill-gate.json
 * Supports per-project overrides via the "projects" key, keyed by absolute path.
 */

import type { ExtensionAPI, Skill } from "@earendil-works/pi-coding-agent";
import { copyToClipboard, DefaultResourceLoader, getAgentDir } from "@earendil-works/pi-coding-agent";
import * as fs from "node:fs";
import * as path from "node:path";
import { homedir } from "node:os";
import { spawn } from "node:child_process";
import type { EditScope, RowData, SkillAnalytics, SkillGateConfig, SkillGateTheme, SkillVisibility, ToggleState } from "./types.js";
import { SkillDetailOverlay, invalidateAllSkillBodies } from "./overlay.js";

// ── Config persistence ──

const CONFIG_PATH = path.join(homedir(), ".pi", "agent", "config", "skill-gate.json");
const ANALYTICS_PATH = path.join(homedir(), ".pi", "agent", "config", "skill-gate-analytics.json");

/**
 * In-memory cache of the parsed config. `before_agent_start` runs on every
 * agent turn, but the config is only ever mutated via `persistToggle` (which
 * updates this cache) — so a cached read is always up-to-date within a
 * session. Use `invalidateConfigCache()` for external edits to the file.
 */
let cachedConfig: SkillGateConfig | null = null;

/** Drop the in-memory config cache. Call after external edits to the file. */
export function invalidateConfigCache(): void {
  cachedConfig = null;
}

export function loadConfig(): SkillGateConfig {
  if (cachedConfig) return cachedConfig;
  let parsed: SkillGateConfig;
  if (!fs.existsSync(CONFIG_PATH)) {
    parsed = { skills: {}, projects: {} };
  } else {
    try {
      const raw = JSON.parse(fs.readFileSync(CONFIG_PATH, "utf-8"));
      parsed = { skills: raw.skills || {}, projects: raw.projects || {} };
    } catch {
      console.warn(`[skill-gate] Failed to parse ${CONFIG_PATH} — using empty config`);
      parsed = { skills: {}, projects: {} };
    }
  }
  cachedConfig = parsed;
  return cachedConfig;
}

export function saveConfig(c: SkillGateConfig): void {
  fs.mkdirSync(path.dirname(CONFIG_PATH), { recursive: true });
  fs.writeFileSync(CONFIG_PATH, JSON.stringify(c, null, 2), "utf-8");
  // Keep the cache in sync with what we just persisted.
  cachedConfig = c;
}

/** Resolve effective state: project override → global → default "disabled". */
export function loadEffectiveState(name: string, config: SkillGateConfig, projectPath?: string): { state: ToggleState; source: "global" | "project" | "default" } {
  if (projectPath) {
    const proj = config.projects?.[projectPath]?.skills?.[name];
    if (proj === "enabled" || proj === "disabled") return { state: proj, source: "project" };
  }
  const raw = config.skills[name];
  if (raw === "enabled" || raw === "disabled") return { state: raw, source: "global" };
  return { state: "disabled", source: "default" };
}

/** Persist a toggle to the given scope. Cleans up redundant project overrides
 *  (entries that match the global effective state are removed). */
export function persistToggle(name: string, value: ToggleState, config: SkillGateConfig, scope: EditScope, projectPath?: string): void {
  if (scope === "global") {
    if (value === "disabled") {
      delete config.skills[name];
    } else {
      config.skills[name] = value;
    }
  } else if (scope === "project" && projectPath) {
    if (!config.projects) config.projects = {};
    if (!config.projects[projectPath]) config.projects[projectPath] = { skills: {} };
    const proj = config.projects[projectPath];
    // If the new value matches what global would give, remove the override (clean).
    const globalEff = config.skills[name] === "enabled" ? "enabled" : "disabled";
    if (value === globalEff) {
      delete proj.skills[name];
    } else {
      proj.skills[name] = value;
    }
    // Prune empty project sections
    if (Object.keys(proj.skills).length === 0) delete config.projects[projectPath];
  }
  saveConfig(config);
}

/** Bulk version of `persistToggle`. Applies the same value to many skills in a
 *  single write. Mirrors `persistToggle`'s cleanup: project overrides that
 *  match the global effective state are pruned, and empty project sections
 *  are removed. Returns the number of skills whose state actually changed
 *  (zero changes = zero writes). */
export function persistBulkToggle(
  names: string[],
  value: ToggleState,
  config: SkillGateConfig,
  scope: EditScope,
  projectPath?: string,
): number {
  let applied = 0;
  if (scope === "global") {
    for (const name of names) {
      if (value === "disabled") {
        if (config.skills[name] !== undefined) {
          delete config.skills[name];
          applied++;
        }
      } else if (config.skills[name] !== value) {
        config.skills[name] = value;
        applied++;
      }
    }
  } else if (scope === "project" && projectPath) {
    if (!config.projects) config.projects = {};
    if (!config.projects[projectPath]) config.projects[projectPath] = { skills: {} };
    const proj = config.projects[projectPath];
    for (const name of names) {
      const globalEff = config.skills[name] === "enabled" ? "enabled" : "disabled";
      if (value === globalEff) {
        if (proj.skills[name] !== undefined) {
          delete proj.skills[name];
          applied++;
        }
      } else if (proj.skills[name] !== value) {
        proj.skills[name] = value;
        applied++;
      }
    }
    if (Object.keys(proj.skills).length === 0) delete config.projects[projectPath];
  }
  if (applied > 0) saveConfig(config);
  return applied;
}

/** Reset all toggles in the given scope. Global clears `config.skills`; project
 *  removes the project entry (leaves the projects map as an empty object,
 *  matching the convention used by `persistToggle`). Returns the number of
 *  toggles cleared (zero = no save). Does NOT cascade across scopes. */
export function resetScope(
  config: SkillGateConfig,
  scope: EditScope,
  projectPath?: string,
): number {
  let cleared = 0;
  if (scope === "global") {
    cleared = Object.keys(config.skills).length;
    if (cleared > 0) config.skills = {};
  } else if (scope === "project" && projectPath) {
    const proj = config.projects?.[projectPath];
    if (proj) {
      cleared = Object.keys(proj.skills).length;
      if (cleared > 0) delete config.projects[projectPath];
    }
  }
  if (cleared > 0) saveConfig(config);
  return cleared;
}

// ── Analytics persistence ──

let cachedAnalytics: SkillAnalytics | null = null;

export function invalidateAnalyticsCache(): void {
  cachedAnalytics = null;
}

export function loadAnalytics(): SkillAnalytics {
  if (cachedAnalytics) return cachedAnalytics;
  let parsed: SkillAnalytics;
  if (!fs.existsSync(ANALYTICS_PATH)) {
    parsed = { counts: {} };
  } else {
    try {
      const raw = JSON.parse(fs.readFileSync(ANALYTICS_PATH, "utf-8"));
      parsed = { counts: raw.counts || {} };
    } catch {
      console.warn(`[skill-gate] Failed to parse ${ANALYTICS_PATH} — using empty counts`);
      parsed = { counts: {} };
    }
  }
  cachedAnalytics = parsed;
  return cachedAnalytics;
}

export function saveAnalytics(a: SkillAnalytics): void {
  fs.mkdirSync(path.dirname(ANALYTICS_PATH), { recursive: true });
  fs.writeFileSync(ANALYTICS_PATH, JSON.stringify(a, null, 2), "utf-8");
  cachedAnalytics = a;
}

/** Increment usage count for one or more skill names. Returns the number of
 *  skills actually incremented (zero = no write). */
export function incrementSkillUsage(names: string[]): number {
  const a = loadAnalytics();
  let changed = 0;
  const seen = new Set<string>();
  for (const name of names) {
    if (seen.has(name)) continue;
    seen.add(name);
    if (!a.counts[name]) {
      a.counts[name] = 1;
    } else {
      a.counts[name]++;
    }
    changed++;
  }
  if (changed > 0) saveAnalytics(a);
  return changed;
}

// ── Cached skills from ResourceLoader (populated at session_start) ──

let cachedSkills: Skill[] = [];

// ── System prompt injection ──

function escapeXml(value: string): string {
  return value
    .replace(/&/g, "&amp;")
    .replace(/</g, "&lt;")
    .replace(/>/g, "&gt;")
    .replace(/"/g, "&quot;")
    .replace(/'/g, "&apos;");
}

export function buildVisibleBlock(rows: SkillVisibility[]): string | null {
  const visible = rows.filter((r) => !r.disableModelInvocation && r.state === "enabled");
  if (visible.length === 0) return null;
  const skills = visible.map((r) => `  <skill>
    <name>${escapeXml(r.name)}</name>
    <description>${escapeXml(r.description)}</description>
    <location>${escapeXml(r.filePath)}</location>
  </skill>`).join("\n");
  return `<available_skills>\n${skills}\n</available_skills>`;
}

// ── Theme factory ──

export function makeTheme(piTheme: any): SkillGateTheme {
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

// ── Extension ──

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

  // ── Analytics: count /skill:name invocations ──
  pi.on("input", async (event, _ctx) => {
    // Match /skill:name patterns (skill names are alphanumeric plus hyphens/underscores)
    const matches = event.text.matchAll(/\/skill:([\w-]+)/g);
    const names = new Set<string>();
    for (const m of matches) names.add(m[1]);
    if (names.size > 0) incrementSkillUsage([...names]);
    return { action: "continue" };
  });

  // ── System prompt hook ──
  pi.on("before_agent_start", async (event, ctx) => {
    const config = loadConfig();
    const projectPath = ctx.cwd !== homedir() ? ctx.cwd : undefined;
    const rows: SkillVisibility[] = cachedSkills.map((s) => {
      const { state } = loadEffectiveState(s.name, config, projectPath);
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

      const projectPath = ctx.cwd !== homedir() ? ctx.cwd : undefined;
      const projectName = projectPath ? path.basename(projectPath) : undefined;

      const stateMap = new Map<string, ToggleState>();
      const sourceMap = new Map<string, "global" | "project" | "default">();
      for (const s of skills) {
        const { state, source } = loadEffectiveState(s.name, config, projectPath);
        stateMap.set(s.name, state);
        sourceMap.set(s.name, source);
      }

      const buildRows = (): RowData[] => {
        const analytics = loadAnalytics();
        const data: RowData[] = skills.map((s) => ({
          name: s.name,
          description: s.description,
          filePath: s.filePath,
          disableModelInvocation: s.disableModelInvocation,
          state: stateMap.get(s.name)!,
          source: sourceMap.get(s.name)!,
          globalEnabled: config.skills[s.name] === "enabled",
          usageCount: analytics.counts[s.name] || 0,
        }));
        data.sort((a, b) => a.name.localeCompare(b.name));
        return data;
      };

      let lastSkill: string | undefined;

      while (true) {
        let editingScope: EditScope = "global";
        let rows = buildRows();

        // Open the detail overlay directly
        const outcome = await new Promise<
          { type: "close" } | { type: "invoke"; name: string } | { type: "edit"; name: string; filePath: string }
        >((resolve) => {
          let overlay: SkillDetailOverlay;

          /** Refresh effective state for one skill after a mutation. */
          const refreshSkill = (name: string) => {
            const { state, source } = loadEffectiveState(name, config, projectPath);
            stateMap.set(name, state);
            sourceMap.set(name, source);
            const row = rows.find((r) => r.name === name);
            if (row) {
              row.state = state;
              row.source = source;
              row.globalEnabled = config.skills[name] === "enabled";
            }
          };

          ctx.ui.custom((tui, piTheme, _kb, done) => {
            const T = makeTheme(piTheme);
            const initIdx = lastSkill ? rows.findIndex((r) => r.name === lastSkill) : 0;
            overlay = new SkillDetailOverlay(rows, Math.max(0, initIdx), () => tui.terminal.rows, T, editingScope, projectName, !!projectPath);
            overlay.onClose = () => { done(null); resolve({ type: "close" }); };
            overlay.onInvoke = (name) => { done(null); resolve({ type: "invoke", name }); };
            overlay.onEdit = (name, filePath) => { done(null); resolve({ type: "edit", name, filePath }); };
            overlay.onYank = async (name, body) => {
              try {
                await copyToClipboard(body);
                ctx.ui.notify(`Yanked ${name} body to clipboard`, "info");
              } catch {
                ctx.ui.notify(`Failed to copy ${name} body to clipboard`, "error");
              }
            };
            overlay.onToggle = (name, state) => {
              persistToggle(name, state, config, editingScope, projectPath);
              refreshSkill(name);
              tui.requestRender();
            };
            overlay.onScopeToggle = () => {
              editingScope = editingScope === "global" ? "project" : "global";
              overlay.setEditingScope(editingScope);
              tui.requestRender();
            };
            overlay.onEnableAll = (names) => {
              const count = persistBulkToggle(names, "enabled", config, editingScope, projectPath);
              if (count > 0) {
                for (const n of names) refreshSkill(n);
                ctx.ui.notify(`Enabled ${count} skills in ${editingScope}`, "info");
              } else {
                ctx.ui.notify("Nothing to enable", "info");
              }
              tui.requestRender();
            };
            overlay.onDisableAll = (names) => {
              const count = persistBulkToggle(names, "disabled", config, editingScope, projectPath);
              if (count > 0) {
                for (const n of names) refreshSkill(n);
                ctx.ui.notify(`Disabled ${count} skills in ${editingScope}`, "info");
              } else {
                ctx.ui.notify("Nothing to disable", "info");
              }
              tui.requestRender();
            };
            overlay.onResetScope = () => {
              const count = resetScope(config, editingScope, projectPath);
              // Refresh every skill — global reset clears all sources, project
              // reset removes overrides and may cascade defaults back in.
              for (const s of skills) refreshSkill(s.name);
              if (count > 0) {
                ctx.ui.notify(`Reset ${count} toggles in ${editingScope}`, "info");
              } else {
                ctx.ui.notify("Nothing to reset", "info");
              }
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

        if (outcome.type === "edit") {
          // Launch $VISUAL / $EDITOR on the skill file. The overlay is already
          // closed (onEdit called `done(null)`) — the editor will inherit the
          // terminal because we use stdio: "inherit" and don't await. After
          // it exits we re-open the overlay; the body cache is invalidated
          // so the next read reflects any on-disk edits.
          const editorCmd = process.env.VISUAL || process.env.EDITOR;
          if (!editorCmd) {
            ctx.ui.notify("No editor configured. Set $VISUAL or $EDITOR.", "warning");
            lastSkill = outcome.name;
            continue;
          }
          if (!fs.existsSync(outcome.filePath)) {
            ctx.ui.notify(`Skill file not found: ${outcome.filePath}`, "error");
            lastSkill = outcome.name;
            continue;
          }
          const [editor, ...editorArgs] = editorCmd.split(" ");
          await new Promise<void>((resolve) => {
            // Notify on stderr via a small footer-style message — but the TUI
            // is paused while the editor owns the terminal, so we just rely
            // on the spawn itself. If the editor binary is missing, the
            // 'error' event fires and we resolve immediately.
            const child = spawn(editor, [...editorArgs, outcome.filePath], {
              stdio: "inherit",
              shell: process.platform === "win32",
            });
            child.on("error", () => resolve());
            child.on("close", () => resolve());
          });
          // Force a re-read of every skill body the next time the overlay
          // renders — the user may have edited the file (or any of its
          // siblings via a multi-file editor command).
          invalidateAllSkillBodies();
          lastSkill = outcome.name;
          continue;
        }
      }
    },
  });
}

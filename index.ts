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
import { DefaultResourceLoader, getAgentDir } from "@earendil-works/pi-coding-agent";
import * as fs from "node:fs";
import * as path from "node:path";
import { homedir } from "node:os";
import type { EditScope, RowData, SkillGateConfig, SkillGateTheme, SkillVisibility, ToggleState } from "./types.js";
import { SkillDetailOverlay } from "./overlay.js";

// ── Config persistence ──

const CONFIG_PATH = path.join(homedir(), ".pi", "agent", "config", "skill-gate.json");

export function loadConfig(): SkillGateConfig {
  if (!fs.existsSync(CONFIG_PATH)) return { skills: {}, projects: {} };
  try {
    const raw = JSON.parse(fs.readFileSync(CONFIG_PATH, "utf-8"));
    return { skills: raw.skills || {}, projects: raw.projects || {} };
  }
  catch {
    console.warn(`[skill-gate] Failed to parse ${CONFIG_PATH} — using empty config`);
    return { skills: {}, projects: {} };
  }
}
export function saveConfig(c: SkillGateConfig): void {
  fs.mkdirSync(path.dirname(CONFIG_PATH), { recursive: true });
  fs.writeFileSync(CONFIG_PATH, JSON.stringify(c, null, 2), "utf-8");
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

// ── Cached skills from ResourceLoader (populated at session_start) ──

let cachedSkills: Skill[] = [];

// ── System prompt injection ──

export function buildVisibleBlock(rows: SkillVisibility[]): string | null {
  const visible = rows.filter((r) => !r.disableModelInvocation && r.state === "enabled");
  if (visible.length === 0) return null;
  return `<available_skills>\n${visible.map((r) => `- ${r.name}: ${r.description}`).join("\n")}\n</available_skills>`;
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

  // ── System prompt hook ──
  pi.on("before_agent_start", async (event, ctx) => {
    const config = loadConfig();
    const projectPath = ctx.cwd !== homedir() ? ctx.cwd : undefined;
    const rows: SkillVisibility[] = cachedSkills.map((s) => {
      const { state } = loadEffectiveState(s.name, config, projectPath);
      return {
        name: s.name,
        description: s.description,
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
        const data: RowData[] = skills.map((s) => ({
          name: s.name,
          description: s.description,
          filePath: s.filePath,
          disableModelInvocation: s.disableModelInvocation,
          state: stateMap.get(s.name)!,
          source: sourceMap.get(s.name)!,
          globalEnabled: config.skills[s.name] === "enabled",
        }));
        data.sort((a, b) => a.name.localeCompare(b.name));
        return data;
      };

      let lastSkill: string | undefined;

      while (true) {
        let editingScope: EditScope = "global";
        let rows = buildRows();

        // Open the detail overlay directly
        const outcome = await new Promise<{ type: "close" } | { type: "invoke"; name: string }>((resolve) => {
          let overlay: SkillDetailOverlay;

          ctx.ui.custom((tui, piTheme, _kb, done) => {
            const T = makeTheme(piTheme);
            const initIdx = lastSkill ? rows.findIndex((r) => r.name === lastSkill) : 0;
            overlay = new SkillDetailOverlay(rows, Math.max(0, initIdx), () => tui.terminal.rows, T, editingScope, projectName, !!projectPath);
            overlay.onClose = () => { done(null); resolve({ type: "close" }); };
            overlay.onInvoke = (name) => { done(null); resolve({ type: "invoke", name }); };
            overlay.onToggle = (name, state) => {
              persistToggle(name, state, config, editingScope, projectPath);
              // Recompute effective state for the toggled skill
              const { state: newState, source: newSource } = loadEffectiveState(name, config, projectPath);
              stateMap.set(name, newState);
              sourceMap.set(name, newSource);
              // Update the row in-place for immediate re-render
              const row = rows.find(r => r.name === name);
              if (row) { row.state = newState; row.source = newSource; row.globalEnabled = config.skills[name] === "enabled"; }
              tui.requestRender();
            };
            overlay.onScopeToggle = () => {
              editingScope = editingScope === "global" ? "project" : "global";
              overlay.setEditingScope(editingScope);
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

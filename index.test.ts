/**
 * Tests for index.ts — config persistence and system prompt injection.
 */

import { describe, it, expect, vi, beforeEach, afterEach } from "vitest";

// ── Mock filesystem (factory inline to avoid hoisting issues) ──

vi.mock("node:fs", () => ({
  existsSync: vi.fn(),
  readFileSync: vi.fn(),
  writeFileSync: vi.fn(),
  mkdirSync: vi.fn(),
}));

vi.mock("node:os", () => ({
  homedir: () => "/home/test-user",
}));

import * as fs from "node:fs";
import {
  loadConfig,
  saveConfig,
  loadEffectiveState,
  persistToggle,
  persistBulkToggle,
  resetScope,
  buildVisibleBlock,
  invalidateConfigCache,
  loadAnalytics,
  saveAnalytics,
  incrementSkillUsage,
  invalidateAnalyticsCache,
} from "./index.js";
import type { SkillGateConfig, SkillAnalytics, SkillVisibility } from "./types.js";

const CONFIG_PATH = "/home/test-user/.pi/agent/config/skill-gate.json";
const ANALYTICS_PATH = "/home/test-user/.pi/agent/config/skill-gate-analytics.json";

// ── Helpers ──

function emptyConfig(): SkillGateConfig {
  return { skills: {}, projects: {} };
}

beforeEach(() => {
  vi.clearAllMocks();
  // Reset the module-level config cache between tests so each test gets a
  // clean slate (otherwise a warm cache from a prior test would skip disk I/O).
  invalidateConfigCache();
  invalidateAnalyticsCache();
});

// ═══════════════════════════════════════════════════════════
//  loadConfig
// ═══════════════════════════════════════════════════════════

describe("loadConfig", () => {
  it("returns empty config when no config file exists", () => {
    vi.mocked(fs.existsSync).mockReturnValue(false);
    const cfg = loadConfig();
    expect(cfg).toEqual({ skills: {}, projects: {} });
    expect(fs.existsSync).toHaveBeenCalledWith(CONFIG_PATH);
  });

  it("parses valid JSON config", () => {
    vi.mocked(fs.existsSync).mockReturnValue(true);
    vi.mocked(fs.readFileSync).mockReturnValue(
      JSON.stringify({
        defaultState: "enabled",
        skills: { mySkill: "enabled", otherSkill: "disabled" },
        projects: { "/home/test-user/proj": { skills: { mySkill: "disabled" } } },
      }) as any
    );
    const cfg = loadConfig();
    expect(cfg).toEqual({
      defaultState: "enabled",
      skills: { mySkill: "enabled", otherSkill: "disabled" },
      projects: { "/home/test-user/proj": { skills: { mySkill: "disabled" } } },
    });
  });

  it("tolerates missing 'skills' key", () => {
    vi.mocked(fs.existsSync).mockReturnValue(true);
    vi.mocked(fs.readFileSync).mockReturnValue(JSON.stringify({}) as any);
    const cfg = loadConfig();
    expect(cfg).toEqual({ skills: {}, projects: {} });
  });

  it("tolerates missing 'projects' key", () => {
    vi.mocked(fs.existsSync).mockReturnValue(true);
    vi.mocked(fs.readFileSync).mockReturnValue(
      JSON.stringify({ skills: { a: "enabled" } }) as any
    );
    const cfg = loadConfig();
    expect(cfg).toEqual({ skills: { a: "enabled" }, projects: {} });
  });

  it("returns empty config on corrupt JSON", () => {
    const warnSpy = vi.spyOn(console, "warn").mockImplementation(() => {});
    vi.mocked(fs.existsSync).mockReturnValue(true);
    vi.mocked(fs.readFileSync).mockReturnValue("{invalid json!!!}" as any);
    const cfg = loadConfig();
    expect(cfg).toEqual({ skills: {}, projects: {} });
    expect(warnSpy).toHaveBeenCalledWith(
      expect.stringContaining("[skill-gate] Failed to parse")
    );
    warnSpy.mockRestore();
  });
});

// ═══════════════════════════════════════════════════════════
//  saveConfig
// ═══════════════════════════════════════════════════════════

describe("saveConfig", () => {
  it("creates parent directories", () => {
    saveConfig(emptyConfig());
    expect(fs.mkdirSync).toHaveBeenCalledWith(
      "/home/test-user/.pi/agent/config",
      { recursive: true }
    );
  });

  it("writes valid JSON with 2-space indent", () => {
    const cfg: SkillGateConfig = {
      skills: { alpha: "enabled" },
      projects: { "/some/project": { skills: { alpha: "disabled" } } },
    };
    saveConfig(cfg);
    expect(fs.writeFileSync).toHaveBeenCalledWith(
      CONFIG_PATH,
      JSON.stringify(cfg, null, 2),
      "utf-8"
    );
    // Verify the written string parses back correctly
    const written = vi.mocked(fs.writeFileSync).mock.calls[0][1] as string;
    expect(() => JSON.parse(written)).not.toThrow();
    const parsed = JSON.parse(written);
    expect(parsed).toEqual(cfg);
  });

  it("writes empty config correctly", () => {
    const cfg = emptyConfig();
    saveConfig(cfg);
    expect(fs.writeFileSync).toHaveBeenCalledWith(
      CONFIG_PATH,
      JSON.stringify(cfg, null, 2),
      "utf-8"
    );
  });
});

// ═══════════════════════════════════════════════════════════
//  loadEffectiveState
// ═══════════════════════════════════════════════════════════

describe("loadEffectiveState", () => {
  const cfg: SkillGateConfig = {
    skills: { alpha: "enabled", beta: "disabled" },
    projects: {
      "/home/test-user/proj": {
        skills: { alpha: "disabled", gamma: "enabled" },
      },
      "/home/test-user/other": {
        skills: { beta: "disabled" }, // same as global, redundant
      },
    },
  };

  it("project override wins over global", () => {
    // alpha is globally enabled but project-disabled
    const res = loadEffectiveState("alpha", cfg, "/home/test-user/proj");
    expect(res).toEqual({ state: "disabled", source: "project" });
  });

  it("global wins over default", () => {
    const res = loadEffectiveState("alpha", cfg);
    expect(res).toEqual({ state: "enabled", source: "global" });
  });

  it("project override wins when skill only exists at project level", () => {
    // gamma only exists at project level
    const res = loadEffectiveState("gamma", cfg, "/home/test-user/proj");
    expect(res).toEqual({ state: "enabled", source: "project" });
  });

  it("missing key returns disabled with default source", () => {
    const res = loadEffectiveState("nonexistent", cfg);
    expect(res).toEqual({ state: "disabled", source: "default" });
  });

  it("uses the configured default state", () => {
    const res = loadEffectiveState("nonexistent", { ...cfg, defaultState: "enabled" });
    expect(res).toEqual({ state: "enabled", source: "default" });
  });

  it("absent projectPath falls through to global", () => {
    const res = loadEffectiveState("beta", cfg); // no projectPath given
    expect(res).toEqual({ state: "disabled", source: "global" });
  });

  it("project with no override for the skill falls through to global", () => {
    // beta has no override in proj (only in 'other'), but is globally disabled
    const res = loadEffectiveState("beta", cfg, "/home/test-user/proj");
    expect(res).toEqual({ state: "disabled", source: "global" });
  });

  it("unknown project path falls through to global", () => {
    const res = loadEffectiveState("alpha", cfg, "/some/unknown/path");
    expect(res).toEqual({ state: "enabled", source: "global" });
  });
});

// ═══════════════════════════════════════════════════════════
//  persistToggle
// ═══════════════════════════════════════════════════════════

describe("persistToggle", () => {
  it("global enable: sets config.skills[name]", () => {
    const cfg = emptyConfig();
    persistToggle("mySkill", "enabled", cfg, "global");
    expect(cfg.skills["mySkill"]).toBe("enabled");
    expect(fs.writeFileSync).toHaveBeenCalledTimes(1);
  });

  it("global disable: deletes config.skills[name]", () => {
    const cfg: SkillGateConfig = {
      skills: { mySkill: "enabled" },
      projects: {},
    };
    persistToggle("mySkill", "disabled", cfg, "global");
    expect(cfg.skills["mySkill"]).toBeUndefined();
    expect(fs.writeFileSync).toHaveBeenCalledTimes(1);
  });

  it("global disable on non-existent key is a no-op delete", () => {
    const cfg = emptyConfig();
    persistToggle("missing", "disabled", cfg, "global");
    expect(cfg.skills["missing"]).toBeUndefined();
  });

  it("stores only exceptions when the default is enabled", () => {
    const cfg: SkillGateConfig = { defaultState: "enabled", skills: {}, projects: {} };
    persistToggle("mySkill", "disabled", cfg, "global");
    expect(cfg.skills["mySkill"]).toBe("disabled");

    persistToggle("mySkill", "enabled", cfg, "global");
    expect(cfg.skills["mySkill"]).toBeUndefined();
  });

  it("project enable: sets config.projects[path].skills[name]", () => {
    const cfg = emptyConfig();
    persistToggle("mySkill", "enabled", cfg, "project", "/home/test-user/proj");
    expect(cfg.projects!["/home/test-user/proj"]!.skills["mySkill"]).toBe(
      "enabled"
    );
  });

  it("project override: creates projects structure when absent", () => {
    const cfg: SkillGateConfig = { skills: {}, projects: {} };
    persistToggle("mySkill", "enabled", cfg, "project", "/home/test-user/proj");
    expect(cfg.projects).toBeDefined();
    expect(cfg.projects!["/home/test-user/proj"]!.skills["mySkill"]).toBe("enabled");
  });

  it("prunes project override when it matches global effective state", () => {
    // Global is enabled; setting project override to "enabled" too — should prune
    const cfg: SkillGateConfig = {
      skills: { mySkill: "enabled" },
      projects: { "/home/test-user/proj": { skills: { mySkill: "disabled" } } },
    };
    persistToggle("mySkill", "enabled", cfg, "project", "/home/test-user/proj");
    // The override should be removed because it now matches global
    expect(
      cfg.projects!["/home/test-user/proj"]?.skills["mySkill"]
    ).toBeUndefined();
  });

  it("project override remains when it differs from global", () => {
    const cfg: SkillGateConfig = {
      skills: { mySkill: "disabled" },
      projects: {},
    };
    persistToggle("mySkill", "enabled", cfg, "project", "/home/test-user/proj");
    expect(cfg.projects!["/home/test-user/proj"]!.skills["mySkill"]).toBe(
      "enabled"
    );
  });

  it("prunes a project override that matches an enabled default", () => {
    const cfg: SkillGateConfig = {
      defaultState: "enabled",
      skills: {},
      projects: { "/home/test-user/proj": { skills: { mySkill: "disabled" } } },
    };
    persistToggle("mySkill", "enabled", cfg, "project", "/home/test-user/proj");
    expect(cfg.projects!["/home/test-user/proj"]).toBeUndefined();
  });

  it("prunes empty project section after last override removed", () => {
    const cfg: SkillGateConfig = {
      skills: {},
      projects: { "/home/test-user/proj": { skills: { mySkill: "disabled" } } },
    };
    // Global is disabled (missing key → disabled). Setting project to disabled
    // matches global, so the override should be pruned.
    persistToggle("mySkill", "disabled", cfg, "project", "/home/test-user/proj");
    expect(cfg.projects!["/home/test-user/proj"]).toBeUndefined();
  });

  it("project scope without projectPath is ignored gracefully", () => {
    const cfg = emptyConfig();
    // scope=project but no projectPath — should not throw or create projects
    persistToggle("mySkill", "enabled", cfg, "project");
    expect(cfg.skills).toEqual({});
    // projects wasn't created because persistToggle only creates projects
    // when projectPath is provided and scope is project
    expect(cfg.projects).toEqual({});
  });
});

// ═══════════════════════════════════════════════════════════
//  persistBulkToggle
// ═══════════════════════════════════════════════════════════

describe("persistBulkToggle", () => {
  it("enables multiple skills globally in a single write", () => {
    const cfg = emptyConfig();
    const n = persistBulkToggle(["a", "b", "c"], "enabled", cfg, "global");
    expect(n).toBe(3);
    expect(cfg.skills).toEqual({ a: "enabled", b: "enabled", c: "enabled" });
    expect(fs.writeFileSync).toHaveBeenCalledTimes(1);
  });

  it("disables multiple skills globally (deletes keys, single write)", () => {
    const cfg: SkillGateConfig = {
      skills: { a: "enabled", b: "enabled", c: "enabled", d: "enabled" },
      projects: {},
    };
    const n = persistBulkToggle(["a", "b"], "disabled", cfg, "global");
    expect(n).toBe(2);
    expect(cfg.skills).toEqual({ c: "enabled", d: "enabled" });
    expect(fs.writeFileSync).toHaveBeenCalledTimes(1);
  });

  it("stores disabled exceptions when the default is enabled", () => {
    const cfg: SkillGateConfig = { defaultState: "enabled", skills: {}, projects: {} };
    const n = persistBulkToggle(["a", "b"], "disabled", cfg, "global");
    expect(n).toBe(2);
    expect(cfg.skills).toEqual({ a: "disabled", b: "disabled" });
    expect(fs.writeFileSync).toHaveBeenCalledTimes(1);
  });

  it("setting same value twice is a no-op (no save)", () => {
    const cfg: SkillGateConfig = {
      skills: { a: "enabled" },
      projects: {},
    };
    const n = persistBulkToggle(["a"], "enabled", cfg, "global");
    expect(n).toBe(0);
    expect(fs.writeFileSync).toHaveBeenCalledTimes(0);
  });

  it("mixed: applies only where state changes (still single write)", () => {
    const cfg: SkillGateConfig = {
      skills: { a: "enabled", b: "enabled", c: "disabled" },
      projects: {},
    };
    // a is already enabled (no-op); c is disabled (no-op); b → c becomes enabled
    // Wait, persistBulkToggle sets all listed to the same value, so:
    // a: already enabled, no-op
    // b: already enabled, no-op
    // c: currently disabled, becomes enabled → applied
    const n = persistBulkToggle(["a", "b", "c"], "enabled", cfg, "global");
    expect(n).toBe(1);
    expect(cfg.skills).toEqual({ a: "enabled", b: "enabled", c: "enabled" });
    expect(fs.writeFileSync).toHaveBeenCalledTimes(1);
  });

  it("project scope: sets multiple overrides in a single write", () => {
    const cfg = emptyConfig();
    const n = persistBulkToggle(["a", "b"], "enabled", cfg, "project", "/proj");
    expect(n).toBe(2);
    expect(cfg.projects!["/proj"]!.skills).toEqual({ a: "enabled", b: "enabled" });
    expect(fs.writeFileSync).toHaveBeenCalledTimes(1);
  });

  it("project scope: prunes overrides that match global", () => {
    const cfg: SkillGateConfig = {
      skills: { a: "enabled" },
      projects: { "/proj": { skills: { a: "disabled" } } },
    };
    const n = persistBulkToggle(["a"], "enabled", cfg, "project", "/proj");
    expect(n).toBe(1); // a was disabled at project → enabled at project (matches global, pruned)
    expect(cfg.projects!["/proj"]?.skills["a"]).toBeUndefined();
  });

  it("project scope: prunes the entire project entry when emptied", () => {
    const cfg: SkillGateConfig = {
      skills: {},
      projects: { "/proj": { skills: { a: "enabled" } } },
    };
    persistBulkToggle(["a"], "disabled", cfg, "project", "/proj");
    // Global is "disabled" (default); project override matching → pruned
    expect(cfg.projects!["/proj"]).toBeUndefined();
  });

  it("project scope: skips entirely when projectPath missing", () => {
    const cfg = emptyConfig();
    const n = persistBulkToggle(["a", "b"], "enabled", cfg, "project");
    expect(n).toBe(0);
    expect(fs.writeFileSync).toHaveBeenCalledTimes(0);
    expect(cfg.projects).toEqual({});
  });
});

// ═══════════════════════════════════════════════════════════
//  resetScope
// ═══════════════════════════════════════════════════════════

describe("resetScope", () => {
  it("global: clears all global skill toggles", () => {
    const cfg: SkillGateConfig = {
      skills: { a: "enabled", b: "disabled", c: "enabled" },
      projects: { "/proj": { skills: { d: "enabled" } } },
    };
    const n = resetScope(cfg, "global");
    expect(n).toBe(3);
    expect(cfg.skills).toEqual({});
    // Projects untouched
    expect(cfg.projects!["/proj"]!.skills["d"]).toBe("enabled");
  });

  it("project: removes the project entry entirely", () => {
    const cfg: SkillGateConfig = {
      skills: { a: "enabled" },
      projects: { "/proj": { skills: { b: "disabled", c: "enabled" } } },
    };
    const n = resetScope(cfg, "project", "/proj");
    expect(n).toBe(2);
    expect(cfg.projects!["/proj"]).toBeUndefined();
    expect(cfg.skills["a"]).toBe("enabled");
  });

  it("project: only removes the named project, leaves others", () => {
    const cfg: SkillGateConfig = {
      skills: {},
      projects: {
        "/proj-a": { skills: { x: "enabled" } },
        "/proj-b": { skills: { y: "enabled" } },
      },
    };
    resetScope(cfg, "project", "/proj-a");
    expect(cfg.projects!["/proj-a"]).toBeUndefined();
    expect(cfg.projects!["/proj-b"]!.skills["y"]).toBe("enabled");
  });

  it("returns 0 (no save) when scope is already empty", () => {
    const cfg: SkillGateConfig = { skills: {}, projects: {} };
    const n = resetScope(cfg, "global");
    expect(n).toBe(0);
    expect(fs.writeFileSync).toHaveBeenCalledTimes(0);
  });

  it("returns 0 (no save) when project doesn't exist", () => {
    const cfg: SkillGateConfig = {
      skills: { a: "enabled" },
      projects: {},
    };
    const n = resetScope(cfg, "project", "/missing");
    expect(n).toBe(0);
    expect(fs.writeFileSync).toHaveBeenCalledTimes(0);
  });

  it("writes exactly once per non-empty scope", () => {
    const cfg: SkillGateConfig = {
      skills: { a: "enabled", b: "disabled" },
      projects: {},
    };
    resetScope(cfg, "global");
    expect(fs.writeFileSync).toHaveBeenCalledTimes(1);
  });
});

// ═══════════════════════════════════════════════════════════
//  buildVisibleBlock
// ═══════════════════════════════════════════════════════════

describe("buildVisibleBlock", () => {
  it("returns null when no skills are visible", () => {
    expect(buildVisibleBlock([])).toBeNull();
  });

  it("returns null when all skills are disabled", () => {
    const rows: SkillVisibility[] = [
      {
        name: "alpha",
        description: "First skill",
        filePath: "/skills/alpha/SKILL.md",
        disableModelInvocation: false,
        state: "disabled",
      },
    ];
    expect(buildVisibleBlock(rows)).toBeNull();
  });

  it("returns null when all skills have disableModelInvocation", () => {
    const rows: SkillVisibility[] = [
      {
        name: "alpha",
        description: "First skill",
        filePath: "/skills/alpha/SKILL.md",
        disableModelInvocation: true,
        state: "enabled",
      },
    ];
    expect(buildVisibleBlock(rows)).toBeNull();
  });

  it("formats correct <available_skills> XML block for a single skill", () => {
    const rows: SkillVisibility[] = [
      {
        name: "test&skill",
        description: "Does <something> \"useful\"",
        filePath: "/skills/a&b/SKILL.md",
        disableModelInvocation: false,
        state: "enabled",
      },
    ];
    const block = buildVisibleBlock(rows);
    expect(block).toBe(
      "<available_skills>\n  <skill>\n    <name>test&amp;skill</name>\n    <description>Does &lt;something&gt; &quot;useful&quot;</description>\n    <location>/skills/a&amp;b/SKILL.md</location>\n  </skill>\n</available_skills>"
    );
  });

  it("formats multiple visible skills", () => {
    const rows: SkillVisibility[] = [
      {
        name: "alpha",
        description: "Alpha skill",
        filePath: "/skills/alpha/SKILL.md",
        disableModelInvocation: false,
        state: "enabled",
      },
      {
        name: "beta",
        description: "Beta skill",
        filePath: "/skills/beta/SKILL.md",
        disableModelInvocation: false,
        state: "enabled",
      },
      {
        name: "gamma",
        description: "Gamma skill",
        filePath: "/skills/gamma/SKILL.md",
        disableModelInvocation: false,
        state: "disabled",
      },
    ];
    const block = buildVisibleBlock(rows);
    expect(block).toBe(
      "<available_skills>\n  <skill>\n    <name>alpha</name>\n    <description>Alpha skill</description>\n    <location>/skills/alpha/SKILL.md</location>\n  </skill>\n  <skill>\n    <name>beta</name>\n    <description>Beta skill</description>\n    <location>/skills/beta/SKILL.md</location>\n  </skill>\n</available_skills>"
    );
    // gamma is disabled and should be excluded
    expect(block).not.toContain("gamma");
  });

  it("filters out disableModelInvocation skills even when enabled", () => {
    const rows: SkillVisibility[] = [
      {
        name: "visible-skill",
        description: "I am visible",
        filePath: "/skills/visible/SKILL.md",
        disableModelInvocation: false,
        state: "enabled",
      },
      {
        name: "hidden-skill",
        description: "I should be hidden",
        filePath: "/skills/hidden/SKILL.md",
        disableModelInvocation: true,
        state: "enabled",
      },
    ];
    const block = buildVisibleBlock(rows);
    expect(block).toContain("visible-skill");
    expect(block).not.toContain("hidden-skill");
  });

  it("handles skills with empty descriptions", () => {
    const rows: SkillVisibility[] = [
      {
        name: "minimal",
        description: "",
        filePath: "/skills/minimal/SKILL.md",
        disableModelInvocation: false,
        state: "enabled",
      },
    ];
    const block = buildVisibleBlock(rows);
    expect(block).toBe(
      "<available_skills>\n  <skill>\n    <name>minimal</name>\n    <description></description>\n    <location>/skills/minimal/SKILL.md</location>\n  </skill>\n</available_skills>"
    );
  });
});

// ═════════════════════════════════════════════════════════
//  Config cache (avoid file read on every before_agent_start)
// ═════════════════════════════════════════════════════════

describe("config cache", () => {
  it("loadConfig reads disk on first call", () => {
    vi.mocked(fs.existsSync).mockReturnValue(true);
    vi.mocked(fs.readFileSync).mockReturnValue(
      JSON.stringify({ skills: { alpha: "enabled" } }) as any
    );
    const cfg = loadConfig();
    expect(cfg.skills["alpha"]).toBe("enabled");
    expect(fs.readFileSync).toHaveBeenCalledTimes(1);
  });

  it("loadConfig does not read disk on subsequent calls (cache hit)", () => {
    vi.mocked(fs.existsSync).mockReturnValue(true);
    vi.mocked(fs.readFileSync).mockReturnValue(
      JSON.stringify({ skills: { alpha: "enabled" } }) as any
    );
    loadConfig();
    loadConfig();
    loadConfig();
    expect(fs.readFileSync).toHaveBeenCalledTimes(1);
  });

  it("loadConfig returns the same reference on cache hit", () => {
    vi.mocked(fs.existsSync).mockReturnValue(true);
    vi.mocked(fs.readFileSync).mockReturnValue(
      JSON.stringify({ skills: { alpha: "enabled" } }) as any
    );
    const cfg1 = loadConfig();
    const cfg2 = loadConfig();
    expect(cfg1).toBe(cfg2);
  });

  it("loadConfig reads disk again after invalidateConfigCache()", () => {
    vi.mocked(fs.existsSync).mockReturnValue(true);
    vi.mocked(fs.readFileSync).mockReturnValue(
      JSON.stringify({ skills: { alpha: "enabled" } }) as any
    );
    loadConfig();
    invalidateConfigCache();
    loadConfig();
    expect(fs.readFileSync).toHaveBeenCalledTimes(2);
  });

  it("loadConfig caches the empty fallback (no file → no disk reads after)", () => {
    vi.mocked(fs.existsSync).mockReturnValue(false);
    loadConfig();
    loadConfig();
    loadConfig();
    expect(fs.readFileSync).toHaveBeenCalledTimes(0);
    expect(fs.existsSync).toHaveBeenCalledTimes(1);
  });

  it("loadConfig caches the corrupt-JSON fallback (parse once, then cache)", () => {
    const warnSpy = vi.spyOn(console, "warn").mockImplementation(() => {});
    vi.mocked(fs.existsSync).mockReturnValue(true);
    vi.mocked(fs.readFileSync).mockReturnValue("{invalid json!!!}" as any);
    loadConfig();
    loadConfig();
    expect(fs.readFileSync).toHaveBeenCalledTimes(1);
    warnSpy.mockRestore();
  });

  it("persistToggle updates the cache so loadConfig returns updated value without disk read", () => {
    vi.mocked(fs.existsSync).mockReturnValue(true);
    vi.mocked(fs.readFileSync).mockReturnValue(JSON.stringify({ skills: {} }) as any);
    const cfg = loadConfig();
    expect(fs.readFileSync).toHaveBeenCalledTimes(1);

    persistToggle("newSkill", "enabled", cfg, "global");

    // Reset read counter to confirm next loadConfig is a cache hit.
    vi.mocked(fs.readFileSync).mockClear();

    const cfg2 = loadConfig();
    expect(cfg2.skills["newSkill"]).toBe("enabled");
    expect(fs.readFileSync).toHaveBeenCalledTimes(0);
  });

  it("persistToggle keeps the same config reference across loads", () => {
    vi.mocked(fs.existsSync).mockReturnValue(true);
    vi.mocked(fs.readFileSync).mockReturnValue(JSON.stringify({ skills: {} }) as any);
    const cfg = loadConfig();
    persistToggle("x", "enabled", cfg, "global");

    const reloaded = loadConfig();
    expect(reloaded).toBe(cfg);
  });

  it("saveConfig writes to disk and updates cache to point at the saved config", () => {
    vi.mocked(fs.existsSync).mockReturnValue(false);
    const cfg = loadConfig(); // empty fallback, cached
    cfg.skills["manual"] = "enabled"; // direct mutation

    saveConfig(cfg);
    expect(fs.writeFileSync).toHaveBeenCalledTimes(1);

    const cfg2 = loadConfig();
    expect(cfg2.skills["manual"]).toBe("enabled");
    expect(cfg2).toBe(cfg);
  });

  it("before_agent_start pattern: many loads between a single persistToggle make zero disk reads", () => {
    vi.mocked(fs.existsSync).mockReturnValue(true);
    vi.mocked(fs.readFileSync).mockReturnValue(JSON.stringify({ skills: {} }) as any);
    const cfg = loadConfig(); // first read
    expect(fs.readFileSync).toHaveBeenCalledTimes(1);

    persistToggle("hotSkill", "enabled", cfg, "global");
    vi.mocked(fs.readFileSync).mockClear();

    // Simulate 1000 agent starts between toggles.
    for (let i = 0; i < 1000; i++) loadConfig();
    expect(fs.readFileSync).toHaveBeenCalledTimes(0);
  });
});

// ── Analytics persistence ──

function emptyAnalytics(): SkillAnalytics {
  return { counts: {} };
}

describe("loadAnalytics", () => {
  it("returns empty analytics when no file exists", () => {
    vi.mocked(fs.existsSync).mockReturnValue(false);
    const a = loadAnalytics();
    expect(a).toEqual({ counts: {} });
    expect(fs.existsSync).toHaveBeenCalledWith(ANALYTICS_PATH);
  });

  it("parses valid JSON analytics", () => {
    vi.mocked(fs.existsSync).mockReturnValue(true);
    vi.mocked(fs.readFileSync).mockReturnValue(
      JSON.stringify({ counts: { foo: 3, bar: 7 } }) as any
    );
    const a = loadAnalytics();
    expect(a).toEqual({ counts: { foo: 3, bar: 7 } });
  });

  it("tolerates missing 'counts' key", () => {
    vi.mocked(fs.existsSync).mockReturnValue(true);
    vi.mocked(fs.readFileSync).mockReturnValue(JSON.stringify({}) as any);
    const a = loadAnalytics();
    expect(a).toEqual({ counts: {} });
  });

  it("returns empty analytics on corrupt JSON", () => {
    const warnSpy = vi.spyOn(console, "warn").mockImplementation(() => {});
    vi.mocked(fs.existsSync).mockReturnValue(true);
    vi.mocked(fs.readFileSync).mockReturnValue("{broken}" as any);
    const a = loadAnalytics();
    expect(a).toEqual({ counts: {} });
    expect(warnSpy).toHaveBeenCalledWith(
      expect.stringContaining("[skill-gate] Failed to parse")
    );
    warnSpy.mockRestore();
  });
});

describe("saveAnalytics", () => {
  it("creates parent directories", () => {
    saveAnalytics(emptyAnalytics());
    expect(fs.mkdirSync).toHaveBeenCalledWith(
      "/home/test-user/.pi/agent/config",
      { recursive: true }
    );
  });

  it("writes valid JSON with 2-space indent", () => {
    const a: SkillAnalytics = { counts: { alpha: 5, beta: 3 } };
    saveAnalytics(a);
    expect(fs.writeFileSync).toHaveBeenCalledWith(
      ANALYTICS_PATH,
      JSON.stringify(a, null, 2),
      "utf-8"
    );
  });
});

describe("incrementSkillUsage", () => {
  it("creates a new count for a never-used skill", () => {
    vi.mocked(fs.existsSync).mockReturnValue(false);
    const n = incrementSkillUsage(["newskill"]);
    expect(n).toBe(1);
    const a = loadAnalytics();
    expect(a.counts["newskill"]).toBe(1);
  });

  it("increments an existing count", () => {
    vi.mocked(fs.existsSync).mockReturnValue(true);
    vi.mocked(fs.readFileSync).mockReturnValue(
      JSON.stringify({ counts: { existingskill: 5 } }) as any
    );
    const n = incrementSkillUsage(["existingskill"]);
    expect(n).toBe(1);
    const a = loadAnalytics();
    expect(a.counts["existingskill"]).toBe(6);
  });

  it("increments multiple skills in one call", () => {
    vi.mocked(fs.existsSync).mockReturnValue(true);
    vi.mocked(fs.readFileSync).mockReturnValue(
      JSON.stringify({ counts: { a: 1, b: 2 } }) as any
    );
    const n = incrementSkillUsage(["a", "b", "c"]);
    expect(n).toBe(3);
    const a = loadAnalytics();
    expect(a.counts["a"]).toBe(2);
    expect(a.counts["b"]).toBe(3);
    expect(a.counts["c"]).toBe(1);
  });

  it("deduplicates names in a single call (only increments once per name)", () => {
    vi.mocked(fs.existsSync).mockReturnValue(true);
    vi.mocked(fs.readFileSync).mockReturnValue(
      JSON.stringify({ counts: { dup: 1 } }) as any
    );
    const n = incrementSkillUsage(["dup", "dup"]);
    expect(n).toBe(1); // only one unique name
    const a = loadAnalytics();
    expect(a.counts["dup"]).toBe(2); // incremented only once
  });

  it("writes to disk exactly once per changed call", () => {
    vi.mocked(fs.existsSync).mockReturnValue(false);
    incrementSkillUsage(["a", "b"]);
    expect(fs.writeFileSync).toHaveBeenCalledTimes(1);
  });

  it("returns 0 and does not write when no skills are provided", () => {
    vi.mocked(fs.existsSync).mockReturnValue(false);
    const n = incrementSkillUsage([]);
    expect(n).toBe(0);
    expect(fs.writeFileSync).toHaveBeenCalledTimes(0);
  });
});

describe("analytics cache", () => {
  it("loadAnalytics reads disk on first call", () => {
    vi.mocked(fs.existsSync).mockReturnValue(true);
    vi.mocked(fs.readFileSync).mockReturnValue(
      JSON.stringify({ counts: { x: 1 } }) as any
    );
    loadAnalytics();
    expect(fs.readFileSync).toHaveBeenCalledTimes(1);
  });

  it("loadAnalytics does not read disk on subsequent calls (cache hit)", () => {
    vi.mocked(fs.existsSync).mockReturnValue(true);
    vi.mocked(fs.readFileSync).mockReturnValue(
      JSON.stringify({ counts: { x: 1 } }) as any
    );
    loadAnalytics();
    loadAnalytics();
    loadAnalytics();
    expect(fs.readFileSync).toHaveBeenCalledTimes(1);
  });

  it("returns the same reference on cache hit", () => {
    vi.mocked(fs.existsSync).mockReturnValue(true);
    vi.mocked(fs.readFileSync).mockReturnValue(
      JSON.stringify({ counts: { x: 1 } }) as any
    );
    const a1 = loadAnalytics();
    const a2 = loadAnalytics();
    expect(a1).toBe(a2);
  });

  it("reads disk again after invalidateAnalyticsCache()", () => {
    vi.mocked(fs.existsSync).mockReturnValue(true);
    vi.mocked(fs.readFileSync).mockReturnValue(
      JSON.stringify({ counts: { x: 1 } }) as any
    );
    loadAnalytics();
    invalidateAnalyticsCache();
    loadAnalytics();
    expect(fs.readFileSync).toHaveBeenCalledTimes(2);
  });

  it("caches the empty fallback (no file → no disk reads after)", () => {
    vi.mocked(fs.existsSync).mockReturnValue(false);
    loadAnalytics();
    loadAnalytics();
    expect(fs.readFileSync).toHaveBeenCalledTimes(0);
    expect(fs.existsSync).toHaveBeenCalledTimes(1);
  });

  it("incrementSkillUsage updates cache so next loadAnalytics hits cache", () => {
    vi.mocked(fs.existsSync).mockReturnValue(false);
    incrementSkillUsage(["hot"]);
    vi.mocked(fs.readFileSync).mockClear();

    const a = loadAnalytics();
    expect(a.counts["hot"]).toBe(1);
    expect(fs.readFileSync).toHaveBeenCalledTimes(0);
  });
});

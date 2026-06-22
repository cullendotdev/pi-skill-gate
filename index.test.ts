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
  buildVisibleBlock,
} from "./index.js";
import type { SkillGateConfig, SkillVisibility } from "./types.js";

const CONFIG_PATH = "/home/test-user/.pi/agent/config/skill-gate.json";

// ── Helpers ──

function emptyConfig(): SkillGateConfig {
  return { skills: {}, projects: {} };
}

beforeEach(() => {
  vi.clearAllMocks();
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
        skills: { mySkill: "enabled", otherSkill: "disabled" },
        projects: { "/home/test-user/proj": { skills: { mySkill: "disabled" } } },
      }) as any
    );
    const cfg = loadConfig();
    expect(cfg).toEqual({
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
        disableModelInvocation: true,
        state: "enabled",
      },
    ];
    expect(buildVisibleBlock(rows)).toBeNull();
  });

  it("formats correct <available_skills> XML block for a single skill", () => {
    const rows: SkillVisibility[] = [
      {
        name: "test-skill",
        description: "Does something useful",
        disableModelInvocation: false,
        state: "enabled",
      },
    ];
    const block = buildVisibleBlock(rows);
    expect(block).toBe(
      "<available_skills>\n- test-skill: Does something useful\n</available_skills>"
    );
  });

  it("formats multiple visible skills", () => {
    const rows: SkillVisibility[] = [
      {
        name: "alpha",
        description: "Alpha skill",
        disableModelInvocation: false,
        state: "enabled",
      },
      {
        name: "beta",
        description: "Beta skill",
        disableModelInvocation: false,
        state: "enabled",
      },
      {
        name: "gamma",
        description: "Gamma skill",
        disableModelInvocation: false,
        state: "disabled",
      },
    ];
    const block = buildVisibleBlock(rows);
    expect(block).toBe(
      "<available_skills>\n- alpha: Alpha skill\n- beta: Beta skill\n</available_skills>"
    );
    // gamma is disabled and should be excluded
    expect(block).not.toContain("gamma");
  });

  it("filters out disableModelInvocation skills even when enabled", () => {
    const rows: SkillVisibility[] = [
      {
        name: "visible-skill",
        description: "I am visible",
        disableModelInvocation: false,
        state: "enabled",
      },
      {
        name: "hidden-skill",
        description: "I should be hidden",
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
        disableModelInvocation: false,
        state: "enabled",
      },
    ];
    const block = buildVisibleBlock(rows);
    expect(block).toBe(
      "<available_skills>\n- minimal: \n</available_skills>"
    );
  });
});

// Shared types for pi-skill-gate

export type ToggleState = "enabled" | "disabled";
export type EditScope = "global" | "project";

export interface ProjectSkillConfig { skills: Record<string, ToggleState>; }
export interface SkillGateConfig {
  skills: Record<string, ToggleState>;
  projects: Record<string, ProjectSkillConfig>;
}

// ── UI row data ──

export interface RowData {
  name: string;
  description: string;
  filePath: string;
  disableModelInvocation: boolean;
  state: ToggleState;
  source: "global" | "project" | "default";
  globalEnabled: boolean;
}

// ── System prompt injection ──

export interface SkillVisibility {
  name: string;
  state: ToggleState;
  description: string;
  disableModelInvocation: boolean;
}

// ── Theme ──

export interface SkillGateTheme {
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

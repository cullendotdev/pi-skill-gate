<div align="center">

# Skill Gate

*Interactive skill visibility manager for pi coding agent*

[Features](#features) • [Installation](#installation) • [Usage](#usage) • [Configuration](#configuration) • [How It Works](#how-it-works)

</div>

Control which skills are injected into the initial system prompt with `/skill-gate`. Browse full skill content, toggle visibility on or off, and invoke skills — all from a keyboard-driven overlay. Skills that are not injected can still be executed manually in chat. State is persisted across sessions and injected into the system prompt before every agent run.

![Pi-skill-gate interactive overlay](https://raw.githubusercontent.com/cullendotdev/pi-skill-gate/refs/heads/main/images/skill-gate-overlay-preview.png)

## Features

- **Complete skill coverage** — uses pi's `ResourceLoader` API with dynamic directory discovery to match `/skill:` autocomplete (including extension-contributed, project-memory, and migrated package skills)
- **Skill browser** — view the complete `SKILL.md` content (description, when-to-use, procedure, prompt body) for every skill with syntax-highlighted markdown rendering
- **Toggle visibility** — enable or disable skills individually; disabled skills are excluded from the system prompt
- **Persistent state** — toggle state saved to `~/.pi/agent/config/skill-gate.json`
- **System prompt injection** — enabled skills are automatically inserted as `<available_skills>` before each agent start via the `before_agent_start` hook
- **Respects native-disabled** — skills with `disableModelInvocation: true` are marked with a disabled indicator and cannot be toggled
- **Fast hook** — `before_agent_start` filters from an in-memory cache — zero filesystem access per message

## Installation

### Via npm (recommended)

Install the package, then let pi discover it:

```bash
pi install npm:pi-skill-gate
```

### Manual (local development)

Clone / copy the extension into your pi extensions directory:

```bash
git clone https://github.com/cullendotdev/pi-skill-gate.git
cp -r pi-skill-gate ~/.pi/agent/extensions/pi-skill-gate
```

## Usage

```
/skill-gate
```

Opens an overlay showing all discovered skills.

| Key | Action |
|---|---|
| `↑` `↓` | Navigate skills |
| `Space` | Toggle selected skill enabled/disabled |
| `/` | Enter search mode — type to jump to matching skills |
| `b` | Toggle skill-list sidebar |
| `k` `j` | Scroll prompt content |
| `Home` `End` | Jump to top/bottom |
| `Enter` | Invoke skill into chat (confirm selection in search mode) |
| `Esc` | Close (cancel search when searching) |

## Configuration

`skill-gate.json` at `~/.pi/agent/config/skill-gate.json` is created automatically. Only `"enabled"` keys are persisted; `"disabled"` is the default.

```json
{
  "skills": {
    "code-review": "enabled",
    "blueprint": "disabled"
  }
}
```

> [!WARNING]
> Corrupted JSON resets all toggles to disabled.

## How It Works

```
session_start
        ↓
  DefaultResourceLoader + dynamic skill path discovery
  (walks agentDir for skills/ dirs not covered by includeDefaults,
   e.g. pi-hermes-memory/skills/, projects-memory/*/skills/)
        ↓                         ↓
  cachedSkills[]              skill-gate.json
  (Skill: name, desc,         (per-skill state)
   filePath, disableModelInvocation)
        ↓                         ↓
  SkillDetailOverlay ←── loadState() / persistToggle()
        ↓
  before_agent_start hook (in-memory filter)
        ↓
  buildVisibleBlock() → injected into system prompt
```

### Skill discovery

The extension creates a `DefaultResourceLoader` at `session_start` with `includeDefaults: true` (covers `~/.pi/agent/skills/`, npm package skills, and `.agents/skills/`) plus dynamically discovered `additionalSkillPaths`:

- Agent-level directories with `skills/` subdirectories (e.g. `pi-hermes-memory/skills/`)
- Project memory skills (`projects-memory/<project>/skills/`)

This ensures the skill count always matches `/skill:` autocomplete, regardless of where skills are stored.

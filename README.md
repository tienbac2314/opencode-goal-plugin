# OpenCode Goal Plugin

Codex-style long-running goal mode for OpenCode.

This plugin adds:

- `/goal <objective>` as an OpenCode command for TUI, desktop, and web.
- A sidebar goal indicator with status, elapsed time, token usage, remaining budget, and objective.
- Agent tools: `get_goal`, `create_goal`, `update_goal`, and `clear_goal`.
- Goal close evidence: `complete` requires verified evidence, and `unmet` requires a concrete blocker.
- Persistent per-session goal state.
- Optional automatic continuation on `session.idle`.
- Compaction context so active goals are preserved when OpenCode summarizes a long session.

## Install

Install locally for the current OpenCode project:

```bash
opencode plugin @prevalentware/opencode-goal-plugin
```

Install globally:

```bash
opencode plugin -g @prevalentware/opencode-goal-plugin
```

OpenCode detects both package entrypoints and writes the plugin into the server and TUI config targets.

## Manual Config

If you configure it manually, add the package to both config files.

`opencode.json`:

```json
{
  "plugin": ["@prevalentware/opencode-goal-plugin"]
}
```

`tui.json`:

```json
{
  "plugin": ["@prevalentware/opencode-goal-plugin"]
}
```

## Options

Server options can be configured in `opencode.json`:

```json
{
  "plugin": [
    [
      "@prevalentware/opencode-goal-plugin",
      {
        "auto_continue": true,
        "max_auto_turns": 25,
        "min_continue_interval_seconds": 3,
        "default_token_budget": null
      }
    ]
  ]
}
```

Defaults:

- `auto_continue`: `true`
- `max_auto_turns`: `25`
- `min_continue_interval_seconds`: `3`
- `register_command`: `true`
- `command_name`: `"goal"`
- `default_token_budget`: `null`

## Goal Workflow

Use `/goal <objective>` in a fresh OpenCode chat to create a long-running goal:

```text
/goal review the frontend and translate visible English UI text to Spanish
```

Bare `/goal` reports the current goal state. `/goal clear` clears the goal. The TUI also includes a `Goal` command-palette entry for viewing, refreshing, or clearing the current goal state without creating a new goal.

By default, `/goal <objective>` omits `token_budget`, matching Codex TUI behavior. If you want every new slash-created goal to use a fixed token budget without prompting the user, set `default_token_budget` to a positive integer in `opencode.json`.

When writing the objective, include the scope, non-goals, and verification path when they matter. The agent is reminded to audit real files, command output, tests, or PR state before closing the goal.

The `update_goal` tool can close a goal in two ways:

- `status: "complete"` with `evidence` when every requirement is actually achieved.
- `status: "unmet"` with `blocker` when the objective cannot be achieved or is blocked by missing external input.

Budget exhaustion does not close a goal by itself. It only marks the goal `budgetLimited` and asks the agent to wrap up with remaining work or blockers.

## State

Goal state is stored at:

```text
$XDG_DATA_HOME/opencode-goal-plugin/goals.json
```

If `XDG_DATA_HOME` is not set, the default is:

```text
~/.local/share/opencode-goal-plugin/goals.json
```

Set `OPENCODE_GOAL_STATE_PATH` to use a custom file.

## Development

```bash
bun install
bun test
bun run lint
bun run typecheck
bun run build
npm pack --dry-run
```

## Publishing

This package is set up for npm Trusted Publishing from GitHub Actions. On every push to `main`, CI runs typecheck, lint, and unit tests in parallel. If they all pass, the publish job computes the next patch version from the latest version on npm, builds the package, and runs `npm publish`.

Before the first automated publish, configure the package on npm:

1. Open the package settings on npmjs.com.
2. Add a Trusted Publisher for GitHub Actions.
3. Use repository `prevalentWare/opencode-goal-plugin`.
4. Use workflow file `publish.yml`.

The repository must be public for npm provenance to be generated automatically.

## Notes

OpenCode plugin modules are target-specific. This package exports separate modules for server hooks/tools and TUI UI:

```json
{
  "exports": {
    "./server": "./dist/server.js",
    "./tui": "./src/tui.tsx"
  }
}
```

Codex goal mode has deeper runtime integration for thread lifecycle control. This plugin implements the same workflow using OpenCode plugin hooks. Token usage is read from OpenCode step-finish usage when available and falls back to message token metadata or text estimation when exact usage is unavailable. Continuation is driven by OpenCode's `session.idle` event.

# OpenCode Goal Plugin

Codex-style long-running goal mode for OpenCode.

This plugin adds:

- `/goal` in the OpenCode TUI.
- A sidebar goal indicator with status, elapsed time, token usage, remaining budget, and objective.
- Agent tools: `get_goal`, `create_goal`, `update_goal`, and `clear_goal`.
- Persistent per-session goal state.
- Optional automatic continuation on `session.idle`.

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
        "min_continue_interval_seconds": 3
      }
    ]
  ]
}
```

Defaults:

- `auto_continue`: `true`
- `max_auto_turns`: `25`
- `min_continue_interval_seconds`: `3`

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

Codex goal mode has deeper runtime integration for exact token accounting and thread lifecycle control. This plugin implements the same workflow using OpenCode plugin hooks, so token usage is estimated from message text and continuation is driven by OpenCode's `session.idle` event.

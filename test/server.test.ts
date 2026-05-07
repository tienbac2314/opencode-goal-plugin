import { afterEach, beforeEach, expect, test } from "bun:test"
import { mkdtemp, rm } from "node:fs/promises"
import { join } from "node:path"
import { tmpdir } from "node:os"
import plugin from "../src/server"

function requireTool<T>(tool: T | undefined, name: string): T {
  if (!tool) throw new Error(`expected ${name} to be registered`)
  return tool
}

let dir = ""

beforeEach(async () => {
  dir = await mkdtemp(join(tmpdir(), "opencode-goal-plugin-"))
  process.env.OPENCODE_GOAL_STATE_PATH = join(dir, "goals.json")
})

afterEach(async () => {
  delete process.env.OPENCODE_GOAL_STATE_PATH
  await rm(dir, { recursive: true, force: true })
})

test("server plugin exposes Codex-style goal tools", async () => {
  const calls: unknown[] = []
  const hooks = await plugin.server(
    {
      client: {
        session: {
          promptAsync: async (input: unknown) => {
            calls.push(input)
          },
        },
      },
    } as never,
    { auto_continue: false },
  )

  const tools = hooks.tool
  if (!tools) throw new Error("expected goal tools to be registered")

  expect(Object.keys(tools).sort()).toEqual(["clear_goal", "create_goal", "get_goal", "update_goal"])

  const context = { sessionID: "ses_1" } as never
  const created = await requireTool(tools.create_goal, "create_goal").execute({ objective: "finish" }, context)
  expect(String(created)).toContain('"status": "active"')
  expect(String(created)).toContain('"tokenBudget": null')

  const read = await requireTool(tools.get_goal, "get_goal").execute({}, context)
  expect(String(read)).toContain('"objective": "finish"')

  const completed = await requireTool(tools.update_goal, "update_goal").execute(
    { status: "complete", evidence: "verified locally" },
    context,
  )
  expect(String(completed)).toContain('"completion_report"')
  expect(String(completed)).toContain('"completionEvidence": "verified locally"')
  expect(calls).toHaveLength(0)
})

test("server plugin registers goal as a desktop/web command by default", async () => {
  const hooks = await plugin.server(
    {
      client: {
        session: {
          promptAsync: async () => {},
        },
      },
    } as never,
    { auto_continue: false },
  )
  const config = {} as {
    command?: Record<string, { description?: string; template: string }>
  }

  await hooks.config?.(config as never)

  expect(config.command?.goal?.description).toBe("Set or view the long-running session goal")
  expect(config.command?.goal?.template).toContain('OpenCode goal mode command "/goal" was invoked')
  expect(config.command?.goal?.template).toContain("$ARGUMENTS")
  expect(config.command?.goal?.template).not.toContain("token_budget")
})

test("server plugin does not overwrite an existing goal command", async () => {
  const hooks = await plugin.server(
    {
      client: {
        session: {
          promptAsync: async () => {},
        },
      },
    } as never,
    { auto_continue: false },
  )
  const config = {
    command: {
      goal: {
        description: "custom",
        template: "custom template",
      },
    },
  }

  await hooks.config?.(config as never)

  expect(config.command.goal.description).toBe("custom")
  expect(config.command.goal.template).toBe("custom template")
})

test("server plugin can disable desktop/web command registration", async () => {
  const hooks = await plugin.server(
    {
      client: {
        session: {
          promptAsync: async () => {},
        },
      },
    } as never,
    { auto_continue: false, register_command: false },
  )
  const config = {} as {
    command?: Record<string, { description?: string; template: string }>
  }

  await hooks.config?.(config as never)

  expect(config.command).toBeUndefined()
})

test("update goal can close as unmet with a blocker", async () => {
  const hooks = await plugin.server(
    {
      client: {
        session: {
          promptAsync: async () => {},
        },
      },
    } as never,
    { auto_continue: false },
  )
  const tools = hooks.tool
  if (!tools) throw new Error("expected goal tools to be registered")

  const context = { sessionID: "ses_1" } as never
  await requireTool(tools.create_goal, "create_goal").execute({ objective: "finish" }, context)
  const unmet = await requireTool(tools.update_goal, "update_goal").execute(
    { status: "unmet", blocker: "missing credentials" },
    context,
  )

  expect(String(unmet)).toContain('"status": "unmet"')
  expect(String(unmet)).toContain('"blocker": "missing credentials"')
  expect(String(unmet)).toContain('"unmet_report"')
})

test("message transform prefers exact step token usage", async () => {
  const hooks = await plugin.server(
    {
      client: {
        session: {
          promptAsync: async () => {},
        },
      },
    } as never,
    { auto_continue: false },
  )
  const tools = hooks.tool
  if (!tools) throw new Error("expected goal tools to be registered")

  const context = { sessionID: "ses_1" } as never
  await requireTool(tools.create_goal, "create_goal").execute({ objective: "finish" }, context)
  await hooks["experimental.chat.messages.transform"]!(
    {},
    {
      messages: [
        {
          info: { sessionID: "ses_1" },
          parts: [
            {
              type: "step-finish",
              tokens: { input: 10, output: 5, reasoning: 2, cache: { read: 3, write: 4 } },
            },
          ],
        },
      ],
    } as never,
  )
  const read = await requireTool(tools.get_goal, "get_goal").execute({}, context)

  expect(String(read)).toContain('"tokensUsed": 24')
})

test("compaction hook preserves active goal context", async () => {
  const hooks = await plugin.server(
    {
      client: {
        session: {
          promptAsync: async () => {},
        },
      },
    } as never,
    { auto_continue: false },
  )
  const tools = hooks.tool
  if (!tools) throw new Error("expected goal tools to be registered")

  await requireTool(tools.create_goal, "create_goal").execute({ objective: "finish" }, { sessionID: "ses_1" } as never)
  const output = { context: [] as string[], prompt: undefined }
  await hooks["experimental.session.compacting"]!({ sessionID: "ses_1" }, output)

  expect(output.context).toHaveLength(1)
  expect(output.context[0]).toContain("OpenCode goal mode is tracking this session goal across compaction")
  expect(output.context[0]).toContain("Objective: finish")
})

test("idle event auto-continues active goals when enabled", async () => {
  const calls: unknown[] = []
  const hooks = await plugin.server(
    {
      client: {
        session: {
          promptAsync: async (input: unknown) => {
            calls.push(input)
          },
        },
      },
    } as never,
    { auto_continue: true, max_auto_turns: 1, min_continue_interval_seconds: 0 },
  )
  const tools = hooks.tool
  if (!tools) throw new Error("expected goal tools to be registered")

  await requireTool(tools.create_goal, "create_goal").execute({ objective: "keep going" }, { sessionID: "ses_1" } as never)
  await hooks.event!({ event: { type: "session.idle", properties: { sessionID: "ses_1" } } as never })

  expect(calls).toHaveLength(1)
  expect(JSON.stringify(calls[0])).toContain("Continue working toward the active session goal")
})

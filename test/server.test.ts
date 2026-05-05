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
  const created = await requireTool(tools.create_goal, "create_goal").execute({ objective: "finish", token_budget: 50 }, context)
  expect(String(created)).toContain('"status": "active"')

  const read = await requireTool(tools.get_goal, "get_goal").execute({}, context)
  expect(String(read)).toContain('"objective": "finish"')

  const completed = await requireTool(tools.update_goal, "update_goal").execute({ status: "complete" }, context)
  expect(String(completed)).toContain('"completion_budget_report"')
  expect(calls).toHaveLength(0)
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

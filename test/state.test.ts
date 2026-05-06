import { afterEach, beforeEach, expect, test } from "bun:test"
import { mkdtemp, rm } from "node:fs/promises"
import { join } from "node:path"
import { tmpdir } from "node:os"
import {
  accountUsage,
  clearGoal,
  completeGoal,
  createGoal,
  getGoal,
  markGoalUnmet,
  reserveContinuation,
  setGoalStatus,
} from "../src/state"

let dir = ""

beforeEach(async () => {
  dir = await mkdtemp(join(tmpdir(), "opencode-goal-plugin-"))
  process.env.OPENCODE_GOAL_STATE_PATH = join(dir, "goals.json")
})

afterEach(async () => {
  delete process.env.OPENCODE_GOAL_STATE_PATH
  await rm(dir, { recursive: true, force: true })
})

test("creates, reads, pauses, resumes, completes, and clears a goal", async () => {
  const created = await createGoal("ses_1", "ship the plugin", 100)
  expect(created.status).toBe("active")
  expect(created.remainingTokens).toBe(100)
  expect(created.sampledAt).toBeGreaterThanOrEqual(created.createdAt)

  await accountUsage("ses_1", 40)
  expect((await getGoal("ses_1"))?.tokensUsed).toBe(40)

  expect((await setGoalStatus("ses_1", "paused")).status).toBe("paused")
  expect((await setGoalStatus("ses_1", "active")).status).toBe("active")
  const completed = await completeGoal("ses_1", "tests passed")
  expect(completed.status).toBe("complete")
  expect(completed.completionEvidence).toBe("tests passed")
  expect(await clearGoal("ses_1")).toBe(true)
  expect(await getGoal("ses_1")).toBeNull()
})

test("marks a goal unmet with a blocker and allows a new goal afterward", async () => {
  await createGoal("ses_1", "ship the plugin", 100)
  const unmet = await markGoalUnmet("ses_1", "missing external credentials")

  expect(unmet.status).toBe("unmet")
  expect(unmet.blocker).toBe("missing external credentials")

  const next = await createGoal("ses_1", "ship follow-up", null)
  expect(next.status).toBe("active")
  expect(next.objective).toBe("ship follow-up")
})

test("requires evidence when closing goals", async () => {
  await createGoal("ses_1", "ship the plugin", 100)
  await expect(completeGoal("ses_1", "")).rejects.toThrow("completion evidence must not be empty")
  await expect(markGoalUnmet("ses_1", "")).rejects.toThrow("blocker must not be empty")
})

test("marks budget-limited when estimated usage crosses the budget", async () => {
  await createGoal("ses_1", "stay inside budget", 10)
  const updated = await accountUsage("ses_1", 12)
  expect(updated?.status).toBe("budgetLimited")
  expect(updated?.remainingTokens).toBe(0)
})

test("reserves continuation until max auto turns is reached", async () => {
  await createGoal("ses_1", "continue", null)
  expect(await reserveContinuation("ses_1", 1, 0)).not.toBeNull()
  expect(await reserveContinuation("ses_1", 1, 0)).toBeNull()
  expect((await getGoal("ses_1"))?.status).toBe("budgetLimited")
})

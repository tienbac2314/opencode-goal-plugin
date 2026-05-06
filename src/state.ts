import { homedir } from "node:os"
import { dirname, join } from "node:path"
import { mkdir, readFile, rename, writeFile } from "node:fs/promises"
import { readFileSync } from "node:fs"

export type GoalStatus = "active" | "paused" | "budgetLimited" | "complete" | "unmet"
export type MutableGoalStatus = "active" | "paused" | "budgetLimited"

export type Goal = {
  sessionID: string
  objective: string
  status: GoalStatus
  tokenBudget: number | null
  tokensUsed: number
  timeUsedSeconds: number
  createdAt: number
  updatedAt: number
  completionEvidence?: string | null
  blocker?: string | null
  closedAt?: number | null
  lastAccountedAt: number | null
  autoTurns: number
  lastContinuationAt: number | null
}

type State = {
  version: 1
  goals: Record<string, Goal>
}

export type GoalSnapshot = Omit<Goal, "lastAccountedAt" | "autoTurns" | "lastContinuationAt"> & {
  remainingTokens: number | null
  sampledAt: number
}

function defaultStateFile() {
  const dataHome =
    process.env.XDG_DATA_HOME ||
    (process.platform === "win32" && process.env.APPDATA ? process.env.APPDATA : join(homedir(), ".local", "share"))
  return join(dataHome, "opencode-goal-plugin", "goals.json")
}

export function statePath() {
  return process.env.OPENCODE_GOAL_STATE_PATH || defaultStateFile()
}

function nowSeconds() {
  return Math.floor(Date.now() / 1000)
}

function emptyState(): State {
  return { version: 1, goals: {} }
}

async function readState(): Promise<State> {
  try {
    const raw = await readFile(statePath(), "utf8")
    const parsed = JSON.parse(raw) as State
    return parsed && parsed.version === 1 && parsed.goals ? parsed : emptyState()
  } catch (error) {
    if ((error as NodeJS.ErrnoException).code === "ENOENT") return emptyState()
    throw error
  }
}

function readStateSync(): State {
  try {
    const raw = readFileSync(statePath(), "utf8")
    const parsed = JSON.parse(raw) as State
    return parsed && parsed.version === 1 && parsed.goals ? parsed : emptyState()
  } catch (error) {
    if ((error as NodeJS.ErrnoException).code === "ENOENT") return emptyState()
    throw error
  }
}

async function writeState(state: State) {
  const file = statePath()
  await mkdir(dirname(file), { recursive: true })
  const tmp = `${file}.${process.pid}.${Date.now()}.tmp`
  await writeFile(tmp, JSON.stringify(state, null, 2) + "\n")
  await rename(tmp, file)
}

async function mutate<T>(fn: (state: State) => T | Promise<T>) {
  const state = await readState()
  const result = await fn(state)
  await writeState(state)
  return result
}

export function validateObjective(objective: string) {
  const value = objective.trim()
  if (!value) throw new Error("goal objective must not be empty")
  if ([...value].length > 4000) throw new Error("goal objective must be at most 4000 characters")
  return value
}

export function validateBudget(tokenBudget: number | null | undefined) {
  if (tokenBudget == null) return null
  if (!Number.isInteger(tokenBudget) || tokenBudget <= 0) {
    throw new Error("token budget must be a positive integer")
  }
  return tokenBudget
}

export function validateEvidence(evidence: string | null | undefined, label: string) {
  const value = evidence?.trim()
  if (!value) throw new Error(`${label} must not be empty`)
  if ([...value].length > 4000) throw new Error(`${label} must be at most 4000 characters`)
  return value
}

function isClosed(status: GoalStatus) {
  return status === "complete" || status === "unmet"
}

export function snapshot(goal: Goal): GoalSnapshot {
  const sampledAt = nowSeconds()
  const activeSeconds =
    goal.status === "active" && goal.lastAccountedAt != null ? Math.max(0, sampledAt - goal.lastAccountedAt) : 0
  const timeUsedSeconds = goal.timeUsedSeconds + activeSeconds
  return {
    sessionID: goal.sessionID,
    objective: goal.objective,
    status: goal.status,
    tokenBudget: goal.tokenBudget,
    tokensUsed: goal.tokensUsed,
    timeUsedSeconds,
    createdAt: goal.createdAt,
    updatedAt: goal.updatedAt,
    completionEvidence: goal.completionEvidence ?? null,
    blocker: goal.blocker ?? null,
    closedAt: goal.closedAt ?? null,
    remainingTokens: goal.tokenBudget == null ? null : Math.max(0, goal.tokenBudget - goal.tokensUsed),
    sampledAt,
  }
}

export async function getGoal(sessionID: string) {
  const state = await readState()
  const goal = state.goals[sessionID]
  return goal ? snapshot(goal) : null
}

export function getGoalSync(sessionID: string) {
  const state = readStateSync()
  const goal = state.goals[sessionID]
  return goal ? snapshot(goal) : null
}

export async function createGoal(sessionID: string, objective: string, tokenBudget?: number | null) {
  const value = validateObjective(objective)
  const budget = validateBudget(tokenBudget)
  return mutate((state) => {
    const existing = state.goals[sessionID]
    if (existing && !isClosed(existing.status)) {
      throw new Error("cannot create a new goal because this session already has a non-closed goal")
    }
    const now = nowSeconds()
    const goal: Goal = {
      sessionID,
      objective: value,
      status: "active",
      tokenBudget: budget,
      tokensUsed: 0,
      timeUsedSeconds: 0,
      createdAt: now,
      updatedAt: now,
      completionEvidence: null,
      blocker: null,
      closedAt: null,
      lastAccountedAt: now,
      autoTurns: 0,
      lastContinuationAt: null,
    }
    state.goals[sessionID] = goal
    return snapshot(goal)
  })
}

export async function setGoalStatus(sessionID: string, status: MutableGoalStatus) {
  return mutate((state) => {
    const goal = state.goals[sessionID]
    if (!goal) throw new Error("cannot update goal because this session has no goal")
    accountWallClock(goal)
    goal.status = status
    goal.updatedAt = nowSeconds()
    goal.lastAccountedAt = status === "active" ? goal.updatedAt : null
    return snapshot(goal)
  })
}

export async function closeGoal(
  sessionID: string,
  input:
    | {
        status: "complete"
        evidence: string
      }
    | {
        status: "unmet"
        blocker: string
      },
) {
  return mutate((state) => {
    const goal = state.goals[sessionID]
    if (!goal) throw new Error("cannot update goal because this session has no goal")
    accountWallClock(goal)
    const now = nowSeconds()
    goal.status = input.status
    goal.updatedAt = now
    goal.closedAt = now
    goal.lastAccountedAt = null
    if (input.status === "complete") {
      goal.completionEvidence = validateEvidence(input.evidence, "completion evidence")
      goal.blocker = null
    } else {
      goal.blocker = validateEvidence(input.blocker, "blocker")
      goal.completionEvidence = null
    }
    return snapshot(goal)
  })
}

export async function completeGoal(sessionID: string, evidence: string) {
  return closeGoal(sessionID, { status: "complete", evidence })
}

export async function markGoalUnmet(sessionID: string, blocker: string) {
  return closeGoal(sessionID, { status: "unmet", blocker })
}

export async function clearGoal(sessionID: string) {
  return mutate((state) => {
    const existed = Boolean(state.goals[sessionID])
    delete state.goals[sessionID]
    return existed
  })
}

export async function accountUsage(sessionID: string, tokensUsed?: number) {
  return mutate((state) => {
    const goal = state.goals[sessionID]
    if (!goal) return null
    accountWallClock(goal)
    if (typeof tokensUsed === "number" && Number.isFinite(tokensUsed)) {
      goal.tokensUsed = Math.max(goal.tokensUsed, Math.max(0, Math.ceil(tokensUsed)))
    }
    if (goal.status === "active" && goal.tokenBudget != null && goal.tokensUsed >= goal.tokenBudget) {
      goal.status = "budgetLimited"
      goal.lastAccountedAt = null
    }
    goal.updatedAt = nowSeconds()
    return snapshot(goal)
  })
}

export async function reserveContinuation(sessionID: string, maxAutoTurns: number, minIntervalSeconds: number) {
  return mutate((state) => {
    const goal = state.goals[sessionID]
    if (!goal || goal.status !== "active") return null
    const now = nowSeconds()
    if (goal.autoTurns >= maxAutoTurns) {
      goal.status = "budgetLimited"
      goal.updatedAt = now
      return null
    }
    if (goal.lastContinuationAt && now - goal.lastContinuationAt < minIntervalSeconds) return null
    accountWallClock(goal, now)
    goal.autoTurns += 1
    goal.lastContinuationAt = now
    goal.updatedAt = now
    return snapshot(goal)
  })
}

function accountWallClock(goal: Goal, now = nowSeconds()) {
  if (goal.status !== "active") return
  if (goal.lastAccountedAt == null) {
    goal.lastAccountedAt = now
    return
  }
  goal.timeUsedSeconds += Math.max(0, now - goal.lastAccountedAt)
  goal.lastAccountedAt = now
}

export function estimateTokensFromText(text: string) {
  return Math.ceil(text.length / 4)
}

export function formatGoal(goal: GoalSnapshot | null) {
  if (!goal) return "No goal is set for this session."
  const budget = goal.tokenBudget == null ? "none" : `${goal.tokensUsed} / ${goal.tokenBudget}`
  const lines = [
    `Objective: ${goal.objective}`,
    `Status: ${goal.status}`,
    `Tokens: ${budget}`,
    `Remaining tokens: ${goal.remainingTokens ?? "n/a"}`,
    `Time used: ${goal.timeUsedSeconds}s`,
  ]
  if (goal.completionEvidence) lines.push(`Completion evidence: ${goal.completionEvidence}`)
  if (goal.blocker) lines.push(`Blocker: ${goal.blocker}`)
  return lines.join("\n")
}

import { homedir } from "node:os"
import { dirname, join } from "node:path"
import { mkdir, readFile, rename, writeFile } from "node:fs/promises"
import { readFileSync } from "node:fs"
import { Data, Effect, Schema } from "effect"

export type GoalStatus = "active" | "paused" | "budgetLimited" | "complete" | "unmet"
export type MutableGoalStatus = "active" | "paused"

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
  continuationFailures: number
  lastStatus: string | null
}

type State = {
  version: 1
  goals: Record<string, Goal>
}

class StateReadError extends Data.TaggedError("StateReadError")<{
  readonly cause: unknown
}> {}

class StateDecodeError extends Data.TaggedError("StateDecodeError")<{
  readonly cause: unknown
}> {}

class StateWriteError extends Data.TaggedError("StateWriteError")<{
  readonly cause: unknown
}> {}

const NullableString = Schema.NullOr(Schema.String)
const NullableNumber = Schema.NullOr(Schema.Number)
const GoalSchema = Schema.Struct({
  sessionID: Schema.String,
  objective: Schema.String,
  status: Schema.Literal("active", "paused", "budgetLimited", "complete", "unmet"),
  tokenBudget: NullableNumber,
  tokensUsed: Schema.Number,
  timeUsedSeconds: Schema.Number,
  createdAt: Schema.Number,
  updatedAt: Schema.Number,
  completionEvidence: Schema.optionalWith(NullableString, { default: () => null }),
  blocker: Schema.optionalWith(NullableString, { default: () => null }),
  closedAt: Schema.optionalWith(NullableNumber, { default: () => null }),
  lastAccountedAt: NullableNumber,
  autoTurns: Schema.Number,
  lastContinuationAt: NullableNumber,
  continuationFailures: Schema.optionalWith(Schema.Number, { default: () => 0 }),
  lastStatus: Schema.optionalWith(NullableString, { default: () => null }),
})
const StateSchema = Schema.Struct({
  version: Schema.Literal(1),
  goals: Schema.Record({ key: Schema.String, value: GoalSchema }),
})

export type GoalSnapshot = Omit<Goal, "lastAccountedAt" | "autoTurns" | "lastContinuationAt"> & {
  remainingTokens: number | null
  sampledAt: number
  autoTurns: number
  lastContinuationAt: number | null
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

function isMissingStateFile(error: unknown) {
  return typeof error === "object" && error !== null && (error as NodeJS.ErrnoException).code === "ENOENT"
}

function mutableState(state: Schema.Schema.Type<typeof StateSchema>): State {
  return JSON.parse(JSON.stringify(state)) as State
}

function decodeState(value: unknown) {
  return Schema.decodeUnknown(StateSchema)(value).pipe(
    Effect.map(mutableState),
    Effect.mapError((cause) => new StateDecodeError({ cause })),
  )
}

function readStateEffect() {
  return Effect.tryPromise({
    try: () => readFile(statePath(), "utf8"),
    catch: (cause) => new StateReadError({ cause }),
  }).pipe(
    Effect.flatMap((raw) =>
      Effect.try({
        try: () => JSON.parse(raw) as unknown,
        catch: (cause) => new StateDecodeError({ cause }),
      }),
    ),
    Effect.flatMap(decodeState),
    Effect.catchAll((error) =>
      error._tag === "StateReadError" && isMissingStateFile(error.cause) ? Effect.succeed(emptyState()) : Effect.fail(error),
    ),
  )
}

function writeStateEffect(state: State) {
  return Effect.tryPromise({
    try: async () => {
      const file = statePath()
      await mkdir(dirname(file), { recursive: true })
      const tmp = `${file}.${process.pid}.${Date.now()}.tmp`
      await writeFile(tmp, JSON.stringify(state, null, 2) + "\n")
      await rename(tmp, file)
    },
    catch: (cause) => new StateWriteError({ cause }),
  })
}

async function readState(): Promise<State> {
  return Effect.runPromise(readStateEffect())
}

function readStateSync(): State {
  try {
    const raw = readFileSync(statePath(), "utf8")
    return mutableState(Schema.decodeUnknownSync(StateSchema)(JSON.parse(raw) as unknown))
  } catch (error) {
    if (isMissingStateFile(error)) return emptyState()
    throw error
  }
}

let mutationQueue: Promise<void> = Promise.resolve()

function enqueueMutation<T>(operation: () => Promise<T>) {
  const current = mutationQueue.then(operation, operation)
  mutationQueue = current.then(
    () => undefined,
    () => undefined,
  )
  return current
}

async function mutate<T>(fn: (state: State) => T | Promise<T>) {
  return enqueueMutation(() =>
    Effect.runPromise(
      Effect.gen(function* () {
        const state = yield* readStateEffect()
        const result = yield* Effect.tryPromise({
          try: () => Promise.resolve(fn(state)),
          catch: (cause) => (cause instanceof Error ? cause : new Error(String(cause))),
        })
        yield* writeStateEffect(state)
        return result
      }),
    ),
  )
}

export function validateObjective(objective: string) {
  const value = objective.trim()
  if (!value) throw new Error("goal objective must not be empty")
  if ([...value].length > 4000) throw new Error("goal objective must be at most 4000 characters")
  return value
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

function visibleStatus(status: GoalStatus): GoalStatus {
  return status === "budgetLimited" ? "active" : status
}

export function snapshot(goal: Goal): GoalSnapshot {
  const sampledAt = nowSeconds()
  const status = visibleStatus(goal.status)
  const activeSeconds =
    status === "active" && goal.lastAccountedAt != null ? Math.max(0, sampledAt - goal.lastAccountedAt) : 0
  const timeUsedSeconds = goal.timeUsedSeconds + activeSeconds
  return {
    sessionID: goal.sessionID,
    objective: goal.objective,
    status,
    tokenBudget: null,
    tokensUsed: goal.tokensUsed,
    timeUsedSeconds,
    createdAt: goal.createdAt,
    updatedAt: goal.updatedAt,
    completionEvidence: goal.completionEvidence ?? null,
    blocker: goal.blocker ?? null,
    closedAt: goal.closedAt ?? null,
    continuationFailures: goal.continuationFailures,
    lastStatus: goal.lastStatus,
    autoTurns: goal.autoTurns,
    lastContinuationAt: goal.lastContinuationAt,
    remainingTokens: null,
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

export async function createGoal(sessionID: string, objective: string, _tokenBudget?: number | null) {
  const value = validateObjective(objective)
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
      tokenBudget: null,
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
      continuationFailures: 0,
      lastStatus: "Goal set.",
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
    goal.continuationFailures = status === "active" ? 0 : goal.continuationFailures
    goal.lastStatus = status === "active" ? "Goal resumed." : "Goal paused."
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
    if (goal.status === "budgetLimited") {
      goal.status = "active"
      goal.tokenBudget = null
      goal.lastAccountedAt = nowSeconds()
    }
    accountWallClock(goal)
    if (typeof tokensUsed === "number" && Number.isFinite(tokensUsed)) {
      goal.tokensUsed = Math.max(goal.tokensUsed, Math.max(0, Math.ceil(tokensUsed)))
    }
    goal.updatedAt = nowSeconds()
    return snapshot(goal)
  })
}

export async function reserveContinuation(sessionID: string, maxAutoTurns: number, minIntervalSeconds: number) {
  return mutate((state) => {
    const goal = state.goals[sessionID]
    if (!goal || (goal.status !== "active" && goal.status !== "budgetLimited")) return null
    const now = nowSeconds()
    if (goal.status === "budgetLimited") {
      goal.status = "active"
      goal.tokenBudget = null
      goal.lastAccountedAt = now
    }
    if (goal.autoTurns >= maxAutoTurns) return null
    if (goal.lastContinuationAt && now - goal.lastContinuationAt < minIntervalSeconds) return null
    accountWallClock(goal, now)
    goal.autoTurns += 1
    goal.lastContinuationAt = now
    goal.lastStatus = `Auto-continue ${goal.autoTurns} reserved.`
    goal.updatedAt = now
    return snapshot(goal)
  })
}

export async function recordContinuationResult(sessionID: string, result: "success" | "failure", maxFailures: number) {
  return mutate((state) => {
    const goal = state.goals[sessionID]
    if (!goal || goal.status !== "active") return goal ? snapshot(goal) : null
    const now = nowSeconds()
    goal.updatedAt = now
    if (result === "success") {
      goal.continuationFailures = 0
      goal.lastStatus = "Auto-continue prompt sent."
      return snapshot(goal)
    }
    goal.continuationFailures += 1
    goal.lastStatus = `Auto-continue failed ${goal.continuationFailures} time(s).`
    if (goal.continuationFailures >= maxFailures) {
      accountWallClock(goal, now)
      goal.status = "paused"
      goal.lastAccountedAt = null
      goal.lastStatus = `Paused after ${goal.continuationFailures} auto-continue failure(s).`
      goal.blocker = "Auto-continue prompt failed repeatedly. Resume the goal to retry."
    }
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
  const lines = [
    `Objective: ${goal.objective}`,
    `Status: ${goal.status}`,
    `Time used: ${goal.timeUsedSeconds}s`,
    `Auto-continues: ${goal.autoTurns}`,
  ]
  if (goal.lastStatus) lines.push(`Last status: ${goal.lastStatus}`)
  if (goal.completionEvidence) lines.push(`Completion evidence: ${goal.completionEvidence}`)
  if (goal.blocker) lines.push(`Blocker: ${goal.blocker}`)
  return lines.join("\n")
}

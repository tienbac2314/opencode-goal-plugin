/** @jsxImportSource @opentui/solid */
import type { TuiPlugin, TuiPluginApi, TuiPluginModule } from "@opencode-ai/plugin/tui"
import { createMemo, createSignal, onCleanup, Show } from "solid-js"

type GoalSnapshot = {
  sessionID: string
  objective: string
  status: "active" | "paused" | "budgetLimited" | "complete" | "unmet"
  tokenBudget: number | null
  tokensUsed: number
  timeUsedSeconds: number
  createdAt: number
  updatedAt: number
  completionEvidence?: string | null
  blocker?: string | null
  closedAt?: number | null
  remainingTokens: number | null
  sampledAt?: number
}

type GoalToolPart = {
  type: string
  tool?: string
  state?: {
    status?: string
    output?: string
  }
  tokens?: unknown
}

type SessionMessage = {
  id: string
}

type GoalSessionState = {
  goal: GoalSnapshot | null
  messageIndex: number
}

const goalCache = new Map<string, GoalSnapshot>()

function currentSessionID(api: TuiPluginApi) {
  const route = api.route.current
  if (route.name !== "session") return undefined
  const sessionID = route.params?.sessionID
  return typeof sessionID === "string" ? sessionID : undefined
}

function toast(api: TuiPluginApi, message: string, variant: "info" | "success" | "warning" | "error" = "info") {
  api.ui.toast({ title: "Goal", message, variant, duration: 2500 })
}

async function sendGoalPrompt(api: TuiPluginApi, sessionID: string, text: string) {
  await api.client.session.promptAsync({
    sessionID,
    parts: [{ type: "text", text }],
  })
}

function refreshGoalPrompt() {
  return "Call get_goal for this session and report the current goal state briefly."
}

function clearGoalPrompt() {
  return "Clear the current session goal by calling clear_goal. Report whether a goal was cleared."
}

function showSummary(api: TuiPluginApi, sessionID: string, goal: GoalSnapshot | null) {
  const DialogSelect = api.ui.DialogSelect
  const options = [
    {
      title: "Refresh",
      value: "refresh",
      description: "Ask the agent to read the current goal state",
      onSelect: () => {
        void sendGoalPrompt(api, sessionID, refreshGoalPrompt())
          .then(() => api.ui.dialog.clear())
          .catch((error) => toast(api, error instanceof Error ? error.message : String(error), "error"))
      },
    },
    ...(goal
      ? [
          {
            title: "Clear",
            value: "clear",
            description: "Ask the agent to clear this session goal",
            onSelect: () => {
              void sendGoalPrompt(api, sessionID, clearGoalPrompt())
                .then(() => api.ui.dialog.clear())
                .catch((error) => toast(api, error instanceof Error ? error.message : String(error), "error"))
            },
          },
        ]
      : []),
  ]

  api.ui.dialog.setSize("large")
  api.ui.dialog.replace(() =>
    DialogSelect({
      title: "Goal",
      placeholder: formatGoal(goal),
      options,
      onSelect(option) {
        option.onSelect?.()
      },
    }),
  )
}

function sessionIDOrToast(api: TuiPluginApi) {
  const sessionID = currentSessionID(api)
  if (!sessionID) toast(api, "Open a session before viewing goal state.", "warning")
  return sessionID
}

export function formatDuration(seconds: number) {
  const total = Math.max(0, Math.floor(seconds))
  const hours = Math.floor(total / 3600)
  const minutes = Math.floor((total % 3600) / 60)
  const secs = total % 60
  const paddedSecs = String(secs).padStart(2, "0")
  if (hours > 0) return `${hours}:${String(minutes).padStart(2, "0")}:${paddedSecs}`
  return `${minutes}:${paddedSecs}`
}

function formatDurationBadge(seconds: number) {
  return formatDuration(seconds)
}

function currentEpochSeconds() {
  return Math.floor(Date.now() / 1000)
}

export function liveTimeUsedSeconds(goal: GoalSnapshot, nowSeconds = currentEpochSeconds()) {
  const baseSeconds = Math.max(0, Math.floor(goal.timeUsedSeconds))
  if (visibleStatus(goal.status) !== "active") return baseSeconds
  if (typeof goal.sampledAt !== "number") return baseSeconds
  return baseSeconds + Math.max(0, Math.floor(nowSeconds - goal.sampledAt))
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === "object" && value !== null
}

function isGoalSnapshot(value: unknown): value is GoalSnapshot {
  if (!isRecord(value)) return false
  if (typeof value.sessionID !== "string") return false
  if (typeof value.objective !== "string") return false
  if (!["active", "paused", "budgetLimited", "complete", "unmet"].includes(String(value.status))) return false
  if (value.tokenBudget !== null && typeof value.tokenBudget !== "number") return false
  if (typeof value.tokensUsed !== "number") return false
  if (typeof value.timeUsedSeconds !== "number") return false
  if (typeof value.createdAt !== "number") return false
  if (typeof value.updatedAt !== "number") return false
  if (value.completionEvidence != null && typeof value.completionEvidence !== "string") return false
  if (value.blocker != null && typeof value.blocker !== "string") return false
  if (value.closedAt != null && typeof value.closedAt !== "number") return false
  if (value.remainingTokens !== null && typeof value.remainingTokens !== "number") return false
  if (value.sampledAt != null && typeof value.sampledAt !== "number") return false
  return true
}

function parseGoalToolOutput(part: GoalToolPart): GoalSnapshot | null | undefined {
  if (part.type !== "tool") return undefined
  if (!["get_goal", "create_goal", "update_goal", "clear_goal"].includes(part.tool ?? "")) return undefined
  if (part.state?.status !== "completed") return undefined
  if (part.tool === "clear_goal") return null
  if (typeof part.state.output !== "string") return undefined

  try {
    const parsed: unknown = JSON.parse(part.state.output)
    if (!isRecord(parsed)) return undefined
    if (parsed.goal === null) return null
    return isGoalSnapshot(parsed.goal) ? parsed.goal : undefined
  } catch {
    return undefined
  }
}

export function goalStateFromSession(api: TuiPluginApi, sessionID: string): GoalSessionState {
  const messages = [...api.state.session.messages(sessionID)] as SessionMessage[]
  for (let messageIndex = messages.length - 1; messageIndex >= 0; messageIndex -= 1) {
    const message = messages[messageIndex]
    if (!message) continue
    const parts = [...api.state.part(message.id)].reverse() as GoalToolPart[]
    for (const part of parts) {
      const goal = parseGoalToolOutput(part)
      if (goal !== undefined) {
        if (goal) goalCache.set(sessionID, goal)
        else goalCache.delete(sessionID)
        return { goal, messageIndex }
      }
    }
  }
  return { goal: goalCache.get(sessionID) ?? null, messageIndex: -1 }
}

function goalFromSession(api: TuiPluginApi, sessionID: string) {
  return goalStateFromSession(api, sessionID).goal
}

function visibleStatus(status: GoalSnapshot["status"]) {
  return status === "budgetLimited" ? "active" : status
}

function formatGoal(goal: GoalSnapshot | null) {
  if (!goal) return "No recent goal state found in this session."
  const lines = [
    `Objective: ${goal.objective}`,
    `Status: ${visibleStatus(goal.status)}`,
    `Time used: ${formatDuration(goal.timeUsedSeconds)}`,
  ]
  if (goal.completionEvidence) lines.push(`Completion evidence: ${goal.completionEvidence}`)
  if (goal.blocker) lines.push(`Blocker: ${goal.blocker}`)
  return lines.join("\n")
}

function GoalSidebar(props: { api: TuiPluginApi; sessionID: string }) {
  const theme = () => props.api.theme.current
  const [nowSeconds, setNowSeconds] = createSignal(currentEpochSeconds())
  const timer = setInterval(() => setNowSeconds(currentEpochSeconds()), 1000)
  onCleanup(() => clearInterval(timer))
  const state = createMemo(() => {
    props.api.state.session.messages(props.sessionID)
    return goalStateFromSession(props.api, props.sessionID)
  })
  const goal = createMemo(() => state().goal)
  const elapsed = createMemo(() => {
    const value = goal()
    return value ? liveTimeUsedSeconds(value, nowSeconds()) : 0
  })
  const objective = createMemo(() => goal()?.objective ?? "")

  return (
    <Show when={goal()}>
      {(value: () => GoalSnapshot) => (
        <Show
          when={value().status === "complete" || value().status === "unmet"}
          fallback={
            <box>
              <text fg={theme().text}>
                <b>Goal</b>
              </text>
              <text fg={theme().textMuted}>Status: {visibleStatus(value().status)}</text>
              <text fg={theme().textMuted}>Time: {formatDuration(elapsed())}</text>
              <text fg={theme().textMuted}>{objective()}</text>
            </box>
          }
        >
          <text fg={value().status === "complete" ? theme().primary : theme().textMuted}>
            <b>{value().status === "complete" ? "Goal achieved" : "Goal unmet"}</b> (
            {formatDurationBadge(elapsed())})
          </text>
        </Show>
      )}
    </Show>
  )
}

const tui: TuiPlugin = async (api) => {
  api.slots.register({
    order: 125,
    slots: {
      sidebar_content(_ctx, props) {
        return <GoalSidebar api={api} sessionID={props.session_id} />
      },
    },
  })

  api.command.register(() => [
    {
      title: "Goal",
      value: "goal.show",
      category: "Goal",
      description: "View or clear the long-running session goal",
      onSelect: () => {
        const sessionID = sessionIDOrToast(api)
        if (!sessionID) return
        showSummary(api, sessionID, goalFromSession(api, sessionID))
      },
    },
  ])
}

const plugin: TuiPluginModule = {
  id: "local.goal-mode.tui",
  tui,
}

export default plugin

/** @jsxImportSource @opentui/solid */
import type { TuiPlugin, TuiPluginApi, TuiPluginModule } from "@opencode-ai/plugin/tui"
import { createMemo, createSignal, onCleanup, onMount, Show } from "solid-js"

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
  text?: string
  content?: string
  tool?: string
  state?: {
    status?: string
    output?: string
  }
  tokens?: unknown
}

type SessionMessage = {
  id: string
  info?: unknown
  tokens?: unknown
}

type GoalSessionState = {
  goal: GoalSnapshot | null
  messageIndex: number
}

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

function formatDuration(seconds: number) {
  const total = Math.max(0, Math.floor(seconds))
  const hours = Math.floor(total / 3600)
  const minutes = Math.floor((total % 3600) / 60)
  const secs = total % 60
  if (hours > 0) return `${hours}h ${minutes}m`
  if (minutes > 0) return `${minutes}m ${secs}s`
  return `${secs}s`
}

function formatDurationBadge(seconds: number) {
  const total = Math.max(0, Math.floor(seconds))
  const hours = Math.floor(total / 3600)
  const minutes = Math.floor((total % 3600) / 60)
  if (hours > 0) return `${hours}h${minutes > 0 ? ` ${minutes}m` : ""}`
  if (minutes > 0) return `${minutes}m`
  return `${total}s`
}

function compactNumber(value: number) {
  if (value >= 1_000_000) return `${(value / 1_000_000).toFixed(1)}M`
  if (value >= 1_000) return `${(value / 1_000).toFixed(value >= 10_000 ? 0 : 1)}K`
  return String(value)
}

function nowSeconds() {
  return Math.floor(Date.now() / 1000)
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

function goalStateFromSession(api: TuiPluginApi, sessionID: string): GoalSessionState {
  const messages = [...api.state.session.messages(sessionID)] as SessionMessage[]
  for (let messageIndex = messages.length - 1; messageIndex >= 0; messageIndex -= 1) {
    const message = messages[messageIndex]
    if (!message) continue
    const parts = [...api.state.part(message.id)].reverse() as GoalToolPart[]
    for (const part of parts) {
      const goal = parseGoalToolOutput(part)
      if (goal !== undefined) return { goal, messageIndex }
    }
  }
  return { goal: null, messageIndex: -1 }
}

function goalFromSession(api: TuiPluginApi, sessionID: string) {
  return goalStateFromSession(api, sessionID).goal
}

function tokensFromRecord(value: unknown): number | undefined {
  if (!isRecord(value)) return undefined
  if (typeof value.total === "number" && Number.isFinite(value.total)) return value.total
  const cache = isRecord(value.cache) ? value.cache : {}
  const fields = [value.input, value.output, value.reasoning, cache.read, cache.write]
  if (!fields.some((field) => typeof field === "number" && Number.isFinite(field))) return undefined
  return fields.reduce<number>((sum, field) => sum + (typeof field === "number" && Number.isFinite(field) ? field : 0), 0)
}

function textFromPart(part: GoalToolPart) {
  if (part.type === "text" && typeof part.text === "string") return part.text
  if (typeof part.content === "string") return part.content
  return ""
}

function estimateTokensFromText(text: string) {
  return Math.ceil(text.length / 4)
}

function estimatedTokensFromParts(parts: GoalToolPart[]) {
  return parts.reduce<number>((sum, part) => sum + estimateTokensFromText(textFromPart(part)), 0)
}

function tokensFromMessage(api: TuiPluginApi, message: SessionMessage) {
  const parts = [...api.state.part(message.id)] as GoalToolPart[]
  const partTotal = parts.reduce<number>((sum, part) => sum + (tokensFromRecord(part.tokens) ?? 0), 0)
  if (partTotal > 0) return partTotal
  const infoTokens = isRecord(message.info) ? tokensFromRecord(message.info.tokens) : undefined
  const exact = tokensFromRecord(message.tokens) ?? infoTokens
  return exact && exact > 0 ? exact : estimatedTokensFromParts(parts)
}

function tokensSinceGoalSnapshot(api: TuiPluginApi, sessionID: string, messageIndex: number) {
  if (messageIndex < 0) return 0
  const messages = [...api.state.session.messages(sessionID)] as SessionMessage[]
  return messages
    .slice(messageIndex)
    .reduce<number>((sum, message) => sum + tokensFromMessage(api, message), 0)
}

function liveTimeUsed(goal: GoalSnapshot, currentSeconds: number) {
  if (goal.status !== "active" || goal.sampledAt == null) return goal.timeUsedSeconds
  return goal.timeUsedSeconds + Math.max(0, currentSeconds - goal.sampledAt)
}

function formatGoal(goal: GoalSnapshot | null) {
  if (!goal) return "No recent goal state found in this session."
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

function GoalSidebar(props: { api: TuiPluginApi; sessionID: string }) {
  const theme = () => props.api.theme.current
  const [currentSeconds, setCurrentSeconds] = createSignal(nowSeconds())
  onMount(() => {
    const interval = setInterval(() => setCurrentSeconds(nowSeconds()), 1000)
    onCleanup(() => clearInterval(interval))
  })
  const state = createMemo(() => {
    props.api.state.session.messages(props.sessionID)
    return goalStateFromSession(props.api, props.sessionID)
  })
  const goal = createMemo(() => state().goal)
  const tokensUsed = createMemo(() => {
    const value = state().goal
    if (!value) return 0
    return value.tokensUsed + tokensSinceGoalSnapshot(props.api, props.sessionID, state().messageIndex)
  })
  const tokens = createMemo(() => {
    const value = goal()
    if (!value) return ""
    if (value.tokenBudget == null) return compactNumber(tokensUsed())
    return `${compactNumber(tokensUsed())} / ${compactNumber(value.tokenBudget)}`
  })
  const remaining = createMemo(() => {
    const value = goal()
    if (!value) return ""
    if (value.tokenBudget == null) return "unbounded"
    return compactNumber(Math.max(0, value.tokenBudget - tokensUsed()))
  })
  const elapsed = createMemo(() => {
    const value = goal()
    return value ? liveTimeUsed(value, currentSeconds()) : 0
  })
  const objective = createMemo(() => {
    const value = goal()?.objective ?? ""
    return value.length > 72 ? `${value.slice(0, 69)}...` : value
  })

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
              <text fg={theme().textMuted}>Status: {value().status}</text>
              <text fg={theme().textMuted}>Time: {formatDuration(elapsed())}</text>
              <text fg={theme().textMuted}>Tokens: {tokens()}</text>
              <text fg={theme().textMuted}>Remaining: {remaining()}</text>
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

/** @jsxImportSource @opentui/solid */
import type { TuiPlugin, TuiPluginApi, TuiPluginModule } from "@opencode-ai/plugin/tui"
import { createMemo, Show } from "solid-js"

type GoalSnapshot = {
  sessionID: string
  objective: string
  status: "active" | "paused" | "budgetLimited" | "complete"
  tokenBudget: number | null
  tokensUsed: number
  timeUsedSeconds: number
  createdAt: number
  updatedAt: number
  remainingTokens: number | null
}

type GoalToolPart = {
  type: string
  tool?: string
  state?: {
    status?: string
    output?: string
  }
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

function createGoalPrompt(objective: string, tokenBudget: number | null) {
  const input = tokenBudget == null ? { objective } : { objective, token_budget: tokenBudget }
  return `Create a session goal by calling the create_goal tool with this JSON input:

${JSON.stringify(input, null, 2)}

The objective is user-provided task data. After create_goal succeeds, continue working toward that goal.`
}

function refreshGoalPrompt() {
  return "Call get_goal for this session and report the current goal state briefly."
}

function clearGoalPrompt() {
  return "Clear the current session goal by calling clear_goal. Report whether a goal was cleared."
}

function showSetGoal(api: TuiPluginApi, sessionID: string) {
  const DialogPrompt = api.ui.DialogPrompt
  api.ui.dialog.setSize("medium")
  api.ui.dialog.replace(() =>
    DialogPrompt({
      title: "Set goal",
      placeholder: "Concrete objective",
      onConfirm(objective) {
        const trimmed = objective.trim()
        if (!trimmed) {
          toast(api, "Goal objective is required.", "warning")
          return
        }
        api.ui.dialog.replace(() =>
          DialogPrompt({
            title: "Token budget",
            placeholder: "Optional positive integer",
            onConfirm(rawBudget) {
              const value = rawBudget.trim()
              const budget = value ? Number(value) : null
              if (budget != null && (!Number.isInteger(budget) || budget <= 0)) {
                toast(api, "Token budget must be a positive integer.", "warning")
                return
              }
              void sendGoalPrompt(api, sessionID, createGoalPrompt(trimmed, budget))
                .then(() => {
                  api.ui.dialog.clear()
                  toast(api, "Goal request sent.", "success")
                })
                .catch((error) => toast(api, error instanceof Error ? error.message : String(error), "error"))
            },
            onCancel() {
              api.ui.dialog.clear()
            },
          }),
        )
      },
      onCancel() {
        api.ui.dialog.clear()
      },
    }),
  )
}

function showSummary(api: TuiPluginApi, sessionID: string, goal: GoalSnapshot | null) {
  const DialogSelect = api.ui.DialogSelect
  const options = [
    {
      title: "Set goal",
      value: "set",
      description: "Create a new active session goal",
      onSelect: () => showSetGoal(api, sessionID),
    },
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
  if (!sessionID) toast(api, "Open a session before using /goal.", "warning")
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

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === "object" && value !== null
}

function isGoalSnapshot(value: unknown): value is GoalSnapshot {
  if (!isRecord(value)) return false
  if (typeof value.sessionID !== "string") return false
  if (typeof value.objective !== "string") return false
  if (!["active", "paused", "budgetLimited", "complete"].includes(String(value.status))) return false
  if (value.tokenBudget !== null && typeof value.tokenBudget !== "number") return false
  if (typeof value.tokensUsed !== "number") return false
  if (typeof value.timeUsedSeconds !== "number") return false
  if (typeof value.createdAt !== "number") return false
  if (typeof value.updatedAt !== "number") return false
  if (value.remainingTokens !== null && typeof value.remainingTokens !== "number") return false
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

function goalFromSession(api: TuiPluginApi, sessionID: string) {
  const messages = [...api.state.session.messages(sessionID)].reverse()
  for (const message of messages) {
    const parts = [...api.state.part(message.id)].reverse() as GoalToolPart[]
    for (const part of parts) {
      const goal = parseGoalToolOutput(part)
      if (goal !== undefined) return goal
    }
  }
  return null
}

function formatGoal(goal: GoalSnapshot | null) {
  if (!goal) return "No recent goal state found in this session."
  const budget = goal.tokenBudget == null ? "none" : `${goal.tokensUsed} / ${goal.tokenBudget}`
  return [
    `Objective: ${goal.objective}`,
    `Status: ${goal.status}`,
    `Tokens: ${budget}`,
    `Remaining tokens: ${goal.remainingTokens ?? "n/a"}`,
    `Time used: ${goal.timeUsedSeconds}s`,
  ].join("\n")
}

function GoalSidebar(props: { api: TuiPluginApi; sessionID: string }) {
  const theme = () => props.api.theme.current
  const goal = createMemo(() => {
    props.api.state.session.messages(props.sessionID)
    return goalFromSession(props.api, props.sessionID)
  })
  const tokens = createMemo(() => {
    const value = goal()
    if (!value) return ""
    if (value.tokenBudget == null) return compactNumber(value.tokensUsed)
    return `${compactNumber(value.tokensUsed)} / ${compactNumber(value.tokenBudget)}`
  })
  const remaining = createMemo(() => {
    const value = goal()
    if (!value) return ""
    return value.remainingTokens == null ? "unbounded" : compactNumber(value.remainingTokens)
  })
  const objective = createMemo(() => {
    const value = goal()?.objective ?? ""
    return value.length > 72 ? `${value.slice(0, 69)}...` : value
  })

  return (
    <Show when={goal()}>
      {(value: () => GoalSnapshot) => (
        <Show
          when={value().status === "complete"}
          fallback={
            <box>
              <text fg={theme().text}>
                <b>Goal</b>
              </text>
              <text fg={theme().textMuted}>Status: {value().status}</text>
              <text fg={theme().textMuted}>Time: {formatDuration(value().timeUsedSeconds)}</text>
              <text fg={theme().textMuted}>Tokens: {tokens()}</text>
              <text fg={theme().textMuted}>Remaining: {remaining()}</text>
              <text fg={theme().textMuted}>{objective()}</text>
            </box>
          }
        >
          <text fg={theme().primary}>
            <b>Goal achieved</b> ({formatDurationBadge(value().timeUsedSeconds)})
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
      description: "Set or view the long-running session goal",
      slash: { name: "goal" },
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

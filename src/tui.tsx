/** @jsxImportSource @opentui/solid */
import type { TuiPlugin, TuiPluginApi, TuiPluginModule } from "@opencode-ai/plugin/tui"
import { createMemo, Show } from "solid-js"
import { clearGoal, createGoal, formatGoal, getGoal, getGoalSync, setGoalStatus, type GoalSnapshot } from "./state"
import { continuationPrompt } from "./prompts"

function currentSessionID(api: TuiPluginApi) {
  const route = api.route.current
  if (route.name !== "session") return undefined
  const sessionID = route.params?.sessionID
  return typeof sessionID === "string" ? sessionID : undefined
}

function toast(api: TuiPluginApi, message: string, variant: "info" | "success" | "warning" | "error" = "info") {
  api.ui.toast({ title: "Goal", message, variant, duration: 2500 })
}

async function continueGoal(api: TuiPluginApi, sessionID: string, goal: GoalSnapshot) {
  await api.client.session.promptAsync({
    sessionID,
    parts: [{ type: "text", text: continuationPrompt(goal) }],
  })
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
              void createGoal(sessionID, trimmed, budget)
                .then((goal) => continueGoal(api, sessionID, goal).then(() => goal))
                .then(() => {
                  api.ui.dialog.clear()
                  toast(api, "Goal started.", "success")
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
      title: goal ? "Refresh" : "Set goal",
      value: "primary",
      description: goal ? "Reload current goal state" : "Create a new active goal",
      onSelect: () => {
        if (!goal) return showSetGoal(api, sessionID)
        void getGoal(sessionID).then((next) => showSummary(api, sessionID, next))
      },
    },
    ...(goal
      ? [
          {
            title: goal.status === "paused" ? "Resume" : "Pause",
            value: "toggle",
            description: goal.status === "paused" ? "Mark active and continue" : "Stop automatic continuation",
            onSelect: () => {
              const next = goal.status === "paused" ? "active" : "paused"
              void setGoalStatus(sessionID, next)
                .then((updated) => (next === "active" ? continueGoal(api, sessionID, updated).then(() => updated) : updated))
                .then((updated) => showSummary(api, sessionID, updated))
                .catch((error) => toast(api, error instanceof Error ? error.message : String(error), "error"))
            },
          },
          {
            title: "Clear",
            value: "clear",
            description: "Remove this session goal",
            onSelect: () => {
              void clearGoal(sessionID).then(() => {
                api.ui.dialog.clear()
                toast(api, "Goal cleared.", "success")
              })
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

function requireSession(api: TuiPluginApi) {
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

function compactNumber(value: number) {
  if (value >= 1_000_000) return `${(value / 1_000_000).toFixed(1)}M`
  if (value >= 1_000) return `${(value / 1_000).toFixed(value >= 10_000 ? 0 : 1)}K`
  return String(value)
}

function GoalSidebar(props: { api: TuiPluginApi; sessionID: string }) {
  const theme = () => props.api.theme.current
  const goal = createMemo(() => {
    props.api.state.session.messages(props.sessionID)
    return getGoalSync(props.sessionID)
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
        const sessionID = requireSession(api)
        if (!sessionID) return
        void getGoal(sessionID).then((goal) => showSummary(api, sessionID, goal))
      },
    },
    {
      title: "Set goal",
      value: "goal.set",
      category: "Goal",
      description: "Create a new active session goal",
      onSelect: () => {
        const sessionID = requireSession(api)
        if (sessionID) showSetGoal(api, sessionID)
      },
    },
    {
      title: "Pause goal",
      value: "goal.pause",
      category: "Goal",
      description: "Pause automatic goal continuation",
      onSelect: () => {
        const sessionID = requireSession(api)
        if (!sessionID) return
        void setGoalStatus(sessionID, "paused").then(() => toast(api, "Goal paused.", "success"))
      },
    },
    {
      title: "Resume goal",
      value: "goal.resume",
      category: "Goal",
      description: "Resume and continue the current goal",
      onSelect: () => {
        const sessionID = requireSession(api)
        if (!sessionID) return
        void setGoalStatus(sessionID, "active")
          .then((goal) => continueGoal(api, sessionID, goal))
          .then(() => toast(api, "Goal resumed.", "success"))
          .catch((error) => toast(api, error instanceof Error ? error.message : String(error), "error"))
      },
    },
    {
      title: "Clear goal",
      value: "goal.clear",
      category: "Goal",
      description: "Clear the current session goal",
      onSelect: () => {
        const sessionID = requireSession(api)
        if (!sessionID) return
        void clearGoal(sessionID).then(() => toast(api, "Goal cleared.", "success"))
      },
    },
  ])
}

const plugin: TuiPluginModule & { id: string } = {
  id: "local.goal-mode.tui",
  tui,
}

export default plugin

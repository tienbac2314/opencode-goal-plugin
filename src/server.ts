import type { Config, Plugin } from "@opencode-ai/plugin"
import { z } from "zod"
import {
  accountUsage,
  clearGoal,
  completeGoal,
  createGoal,
  estimateTokensFromText,
  getGoal,
  markGoalUnmet,
  reserveContinuation,
} from "./state"
import { compactionContext, continuationPrompt, systemReminder } from "./prompts"

type Options = {
  auto_continue?: boolean
  max_auto_turns?: number
  min_continue_interval_seconds?: number
  register_command?: boolean
  command_name?: string
}

type CreateGoalArgs = {
  objective: string
}

type UpdateGoalArgs =
  | {
      status: "complete"
      evidence?: string
      blocker?: string
    }
  | {
      status: "unmet"
      evidence?: string
      blocker?: string
    }

const DEFAULT_MAX_AUTO_TURNS = 25
const DEFAULT_CONTINUE_INTERVAL_SECONDS = 3
const DEFAULT_COMMAND_NAME = "goal"

function goalCommandTemplate(commandName: string) {
  return `OpenCode goal mode command "/${commandName}" was invoked.

Arguments:
<goal_command_arguments>
$ARGUMENTS
</goal_command_arguments>

Use the goal tools to handle this command:

- If the arguments are empty, call get_goal and briefly report the current goal state.
- If the arguments are "status", "show", or "current", call get_goal and briefly report the current goal state.
- If the arguments are "clear", call clear_goal and report whether a goal was cleared.
- If the arguments start with "complete " or "done ", perform a completion audit against real artifacts and command output. Call update_goal with status "complete" only if the goal is achieved, using concise evidence from the audit.
- If the arguments start with "unmet ", "blocked ", or "blocker ", call update_goal with status "unmet" only when the goal cannot be achieved or needs external input, using the remaining arguments as the blocker.
- Otherwise, create a new goal with create_goal. Use the full arguments as the objective.

Create a goal only from these explicit command arguments. Do not infer a goal from unrelated session context. After create_goal succeeds, continue working toward the new goal.`
}

function commandNameFromOptions(options?: Options) {
  const name = options?.command_name?.trim() || DEFAULT_COMMAND_NAME
  if (!/^[A-Za-z0-9][A-Za-z0-9._-]*$/.test(name)) return DEFAULT_COMMAND_NAME
  return name
}

function registerDesktopCommand(config: Config, commandName: string) {
  config.command ??= {}
  if (config.command[commandName]) return
  config.command[commandName] = {
    description: "Set or view the long-running session goal",
    template: goalCommandTemplate(commandName),
  }
}

function textFromPart(part: unknown): string {
  if (!part || typeof part !== "object") return ""
  const value = part as Record<string, unknown>
  if (value.type === "text" && typeof value.text === "string") return value.text
  if (typeof value.content === "string") return value.content
  return ""
}

function estimateMessages(messages: { parts?: unknown[] }[]) {
  return messages.reduce<number>((sum, message) => {
    return (
      sum +
      (message.parts ?? []).reduce<number>((partSum, part) => partSum + estimateTokensFromText(textFromPart(part)), 0)
    )
  }, 0)
}

function tokensFromRecord(value: unknown): number | undefined {
  if (!value || typeof value !== "object") return undefined
  const tokens = value as Record<string, unknown>
  if (typeof tokens.total === "number") return tokens.total
  const cache = tokens.cache && typeof tokens.cache === "object" ? (tokens.cache as Record<string, unknown>) : {}
  const fields = [tokens.input, tokens.output, tokens.reasoning, cache.read, cache.write]
  if (!fields.some((field) => typeof field === "number")) return undefined
  return fields.reduce<number>((sum, field) => sum + (typeof field === "number" && Number.isFinite(field) ? field : 0), 0)
}

function exactTokensFromPart(part: unknown): number | undefined {
  if (!part || typeof part !== "object") return undefined
  const value = part as Record<string, unknown>
  if (value.type !== "step-finish") return undefined
  return tokensFromRecord(value.tokens)
}

function exactTokensFromMessage(message: { info?: unknown; parts?: unknown[] }) {
  const partTotal = (message.parts ?? []).reduce<number>((sum, part) => sum + (exactTokensFromPart(part) ?? 0), 0)
  if (partTotal > 0) return partTotal
  if (message.info && typeof message.info === "object") {
    return tokensFromRecord((message.info as Record<string, unknown>).tokens)
  }
  return undefined
}

function tokensFromMessages(messages: { info?: unknown; parts?: unknown[] }[]) {
  const exactTotal = messages.reduce<number>((sum, message) => sum + (exactTokensFromMessage(message) ?? 0), 0)
  return exactTotal > 0 ? exactTotal : estimateMessages(messages)
}

async function sendContinuation(client: Parameters<Plugin>[0]["client"], sessionID: string, prompt: string) {
  await client.session.promptAsync({
    path: { id: sessionID },
    body: {
      parts: [{ type: "text", text: prompt }],
    },
  })
}

const server: Plugin = async ({ client }, options?: Options) => {
  const autoContinue = options?.auto_continue ?? true
  const maxAutoTurns = options?.max_auto_turns ?? DEFAULT_MAX_AUTO_TURNS
  const minInterval = options?.min_continue_interval_seconds ?? DEFAULT_CONTINUE_INTERVAL_SECONDS
  const registerCommand = options?.register_command ?? true
  const commandName = commandNameFromOptions(options)

  return {
    async config(config) {
      if (!registerCommand) return
      registerDesktopCommand(config, commandName)
    },
    tool: {
      get_goal: {
        description:
          "Get the current goal for this OpenCode session, including status, observed token usage, and elapsed-time usage.",
        args: {},
        async execute(_args, context) {
          return JSON.stringify({ goal: await getGoal(context.sessionID) }, null, 2)
        },
      },
      create_goal: {
        description:
          "Create a goal only when explicitly requested by the user or system/developer instructions; do not infer goals from ordinary tasks. Fails if a non-complete goal exists.",
        args: {
          objective: z.string().min(1).max(4000).describe("The concrete objective to start pursuing."),
        },
        async execute(args, context) {
          const input = args as CreateGoalArgs
          const goal = await createGoal(context.sessionID, input.objective)
          return JSON.stringify({ goal }, null, 2)
        },
      },
      set_goal: {
        description:
          "Set a new goal when the user explicitly asks the agent to formulate and set its own goal. The model should write the objective itself based on the user's explicit request. Fails if a non-complete goal exists.",
        args: {
          objective: z.string().min(1).max(4000).describe("The model-formulated concrete objective to start pursuing."),
        },
        async execute(args, context) {
          const input = args as CreateGoalArgs
          const goal = await createGoal(context.sessionID, input.objective)
          return JSON.stringify({ goal }, null, 2)
        },
      },
      update_goal: {
        description:
          "Close the existing goal only after an audit against real evidence. Use status complete only when the objective is achieved and no required work remains, and include evidence. Use status unmet only when the objective cannot be achieved or is blocked, and include the blocker. Do not close a goal merely because work is stopping.",
        args: {
          status: z.enum(["complete", "unmet"]).describe("Required. complete means achieved; unmet means blocked or impossible."),
          evidence: z
            .string()
            .min(1)
            .max(4000)
            .optional()
            .describe("Required when status is complete. Summarize the concrete evidence verified."),
          blocker: z
            .string()
            .min(1)
            .max(4000)
            .optional()
            .describe("Required when status is unmet. Explain the concrete blocker or impossibility."),
        },
        async execute(args, context) {
          const input = args as UpdateGoalArgs
          if (input.status === "complete") {
            const goal = await completeGoal(context.sessionID, input.evidence ?? "")
            const report = `Goal achieved. Time used: ${goal.timeUsedSeconds} seconds. Evidence: ${goal.completionEvidence}.`
            return JSON.stringify({ goal, completion_report: report }, null, 2)
          }
          const goal = await markGoalUnmet(context.sessionID, input.blocker ?? "")
          const report = `Goal unmet. Time used: ${goal.timeUsedSeconds} seconds. Blocker: ${goal.blocker}.`
          return JSON.stringify({ goal, unmet_report: report }, null, 2)
        },
      },
      clear_goal: {
        description: "Clear the current OpenCode goal for this session when the user explicitly asks to clear it.",
        args: {},
        async execute(_args, context) {
          return JSON.stringify({ cleared: await clearGoal(context.sessionID) }, null, 2)
        },
      },
    },
    async "experimental.chat.messages.transform"(input, output) {
      const sessionID =
        "sessionID" in input && typeof input.sessionID === "string"
          ? input.sessionID
          : output.messages.find((message) => typeof message.info.sessionID === "string")?.info.sessionID
      if (!sessionID) return
      await accountUsage(sessionID, tokensFromMessages(output.messages))
    },
    async "experimental.chat.system.transform"(input, output) {
      if (typeof input.sessionID !== "string") return
      output.system.push(systemReminder(await getGoal(input.sessionID)))
    },
    async "experimental.session.compacting"(input, output) {
      const goal = await getGoal(input.sessionID)
      if (!goal) return
      output.context.push(compactionContext(goal))
    },
    async event({ event }) {
      if (!autoContinue || event.type !== "session.idle") return
      const sessionID = event.properties.sessionID
      const goal = await reserveContinuation(sessionID, maxAutoTurns, minInterval)
      if (!goal) return
      await sendContinuation(client, sessionID, continuationPrompt(goal))
    },
  }
}

export default {
  id: "local.goal-mode.server",
  server,
}

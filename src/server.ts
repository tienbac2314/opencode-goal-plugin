import type { Plugin } from "@opencode-ai/plugin"
import { z } from "zod"
import {
  accountUsage,
  clearGoal,
  completeGoal,
  createGoal,
  estimateTokensFromText,
  getGoal,
  reserveContinuation,
} from "./state"
import { continuationPrompt, systemReminder } from "./prompts"

type Options = {
  auto_continue?: boolean
  max_auto_turns?: number
  min_continue_interval_seconds?: number
}

type CreateGoalArgs = {
  objective: string
  token_budget?: number
}

const DEFAULT_MAX_AUTO_TURNS = 25
const DEFAULT_CONTINUE_INTERVAL_SECONDS = 3

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

  return {
    tool: {
      get_goal: {
        description:
          "Get the current goal for this OpenCode session, including status, budgets, estimated token usage, elapsed-time usage, and remaining token budget.",
        args: {},
        async execute(_args, context) {
          return JSON.stringify({ goal: await getGoal(context.sessionID) }, null, 2)
        },
      },
      create_goal: {
        description:
          "Create a goal only when explicitly requested by the user or system/developer instructions; do not infer goals from ordinary tasks. Set token_budget only when an explicit token budget is requested. Fails if a non-complete goal exists.",
        args: {
          objective: z.string().min(1).max(4000).describe("The concrete objective to start pursuing."),
          token_budget: z.number().int().positive().optional().describe("Optional positive token budget for the goal."),
        },
        async execute(args, context) {
          const input = args as CreateGoalArgs
          const goal = await createGoal(context.sessionID, input.objective, input.token_budget)
          return JSON.stringify({ goal, remaining_tokens: goal.remainingTokens }, null, 2)
        },
      },
      update_goal: {
        description:
          "Use this tool only to mark the existing goal achieved. Set status to complete only when the objective is achieved and no required work remains. Do not mark complete merely because the budget is exhausted or because work is stopping.",
        args: {
          status: z.enum(["complete"]).describe("Required. The only model-controlled status is complete."),
        },
        async execute(_args, context) {
          const goal = await completeGoal(context.sessionID)
          const report =
            goal.tokenBudget == null
              ? `Goal achieved. Time used: ${goal.timeUsedSeconds} seconds.`
              : `Goal achieved. Tokens used: ${goal.tokensUsed} of ${goal.tokenBudget}; time used: ${goal.timeUsedSeconds} seconds.`
          return JSON.stringify({ goal, remaining_tokens: goal.remainingTokens, completion_budget_report: report }, null, 2)
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
      await accountUsage(sessionID, estimateMessages(output.messages))
    },
    async "experimental.chat.system.transform"(input, output) {
      if (typeof input.sessionID !== "string") return
      output.system.push(systemReminder(await getGoal(input.sessionID)))
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

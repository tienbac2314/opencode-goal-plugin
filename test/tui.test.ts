import { expect, test } from "bun:test"
import plugin from "../src/tui.tsx"

test("tui plugin registers goal sidebar and status command without hijacking /goal", async () => {
  let registered: (() => { value: string; slash?: { name: string } }[]) | undefined
  let sidebar: ((ctx: unknown, props: { session_id: string }) => unknown) | undefined
  const api = {
    slots: {
      register(input: { slots: { sidebar_content: (ctx: unknown, props: { session_id: string }) => unknown } }) {
        sidebar = input.slots.sidebar_content
        return "slot-id"
      },
    },
    command: {
      register(cb: () => { value: string; slash?: { name: string } }[]) {
        registered = cb
        return () => {}
      },
    },
    route: { current: { name: "home" } },
    ui: {
      toast() {},
      dialog: {
        setSize() {},
        replace() {},
        clear() {},
      },
    },
    theme: {
      current: {
        text: "#ffffff",
        textMuted: "#888888",
      },
    },
    state: {
      session: {
        messages() {
          return []
        },
      },
    },
  }
  await plugin.tui(api as never, undefined, undefined as never)

  const commands = registered?.() ?? []
  expect(commands.map((command) => command.value).sort()).toEqual(["goal.show"])
  expect(commands.flatMap((command) => (command.slash ? [command.slash.name] : [])).sort()).toEqual([])
  expect(typeof sidebar?.({}, { session_id: "session" })).not.toBe("string")
})

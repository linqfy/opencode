export * as ToolDomain from "./domain"

import { makeLocationNode } from "../effect/app-node"
import { Context, Effect, Exit, Layer, Scope } from "effect"
import { State } from "../state"
import { Tool } from "./tool"
import { ToolRegistry } from "./registry"
import { Tools } from "./tools"

export type Data = {
  tools: Map<string, Tool.AnyTool>
}

export type Draft = {
  list: () => readonly [string, Tool.AnyTool][]
  register: (name: string, tool: Tool.AnyTool) => void
  remove: (name: string) => void
}

export interface Interface extends State.Transformable<Draft> {
  readonly list: () => Effect.Effect<ReadonlyArray<[string, Tool.AnyTool]>>
}

export class Service extends Context.Service<Service, Interface>()("@opencode/v2/ToolDomain") {}

const layer = Layer.effect(
  Service,
  Effect.gen(function* () {
    const tools = yield* Tools.Service
    const scope = yield* Scope.Scope
    let registered: Scope.Closeable | undefined

    const state = State.create<Data, Draft>({
      initial: () => ({ tools: new Map() }),
      draft: (draft) => ({
        list: () => Array.from(draft.tools.entries()),
        register: (name, tool) => {
          draft.tools.set(name, tool)
        },
        remove: (name) => {
          draft.tools.delete(name)
        },
      }),
      finalize: (draft) =>
        Effect.gen(function* () {
          if (registered) yield* Scope.close(registered, Exit.void).pipe(Effect.ignore)
          const next = yield* Scope.make()
          registered = next
          const entries = draft.list()
          if (entries.length === 0) return
          yield* tools.register(Object.fromEntries(entries)).pipe(Scope.provide(next), Effect.orDie)
        }),
    })

    yield* Scope.addFinalizer(
      scope,
      Effect.gen(function* () {
        if (registered) yield* Scope.close(registered, Exit.void).pipe(Effect.ignore)
      }),
    )

    return Service.of({
      transform: state.transform,
      reload: state.reload,
      list: Effect.fn("ToolDomain.list")(function* () {
        return Array.from(state.get().tools.entries())
      }),
    })
  }),
)

export const locationLayer = layer

export const node = makeLocationNode({ service: Service, layer, deps: [ToolRegistry.toolsNode] })

export * as Bundle from "./bundle"

import type { PluginBundleInfo, PluginBundleLoader, PluginBundleManifest, PluginBundleStatus } from "@opencode-ai/plugin/v2/effect"
import type { Plugin as PluginRuntime } from "@opencode-ai/plugin/v2/effect"
import { Context, Effect, Layer, Schema } from "effect"
import { makeLocationNode } from "../effect/app-node"
import { ID, Service as PluginService } from "../plugin"

const Contributions = Schema.Struct({
  providerProfiles: Schema.optional(Schema.Boolean),
  tools: Schema.optional(Schema.Boolean),
  mcpServers: Schema.optional(Schema.Boolean),
  panels: Schema.optional(Schema.Boolean),
  skills: Schema.optional(Schema.Boolean),
  hooks: Schema.optional(Schema.Boolean),
  commands: Schema.optional(Schema.Boolean),
  modelCatalog: Schema.optional(Schema.Boolean),
  permissionDefaults: Schema.optional(Schema.Boolean),
  appServerExtensions: Schema.optional(Schema.Boolean),
})

export const Manifest = Schema.Struct({
  id: Schema.String,
  version: Schema.String,
  provenance: Schema.Struct({ source: Schema.String, location: Schema.String }),
  permissions: Schema.Array(Schema.String),
  startup: Schema.Union([Schema.Literal("required"), Schema.Literal("optional"), Schema.Literal("lazy")]),
  contributions: Contributions,
})

const decode = Schema.decodeUnknownSync(Manifest)

export function decodeManifest(input: unknown): PluginBundleManifest {
  if (typeof input !== "object" || input === null || Array.isArray(input)) return decode(input)
  const value = input as Record<string, unknown>
  return decode({
    id: value.id,
    version: value.version,
    provenance: value.provenance,
    permissions: value.permissions,
    startup: value.startup,
    contributions: value.contributions,
  })
}

type Load = () => Effect.Effect<PluginRuntime, unknown>

export interface Interface extends PluginBundleLoader {
  readonly discover: (manifest: PluginBundleManifest, load: Load) => Effect.Effect<void, Error>
}

export class Service extends Context.Service<Service, Interface>()("@opencode/v2/PluginBundle") {}

const layer = Layer.effect(
  Service,
  Effect.gen(function* () {
    const plugins = yield* PluginService
    const bundles = new Map<string, { manifest: PluginBundleManifest; load: Load; status: PluginBundleStatus; health?: { message: string } }>()
    const list = () =>
      Effect.sync(() =>
        [...bundles.values()].map((bundle): PluginBundleInfo => ({
          manifest: bundle.manifest,
          status: bundle.status,
          ...(bundle.health ? { health: bundle.health } : {}),
        })),
      )
    const discover = (manifest: PluginBundleManifest, load: Load) =>
      Effect.sync(() => {
        const current = bundles.get(manifest.id)
        if (!current) {
          bundles.set(manifest.id, { manifest, load, status: "discovered" })
          return
        }
        if (JSON.stringify(current.manifest) === JSON.stringify(manifest)) return
        throw new Error(`Plugin bundle manifest conflict: ${manifest.id}`)
      })
    const activate = (id: string): Effect.Effect<void, Error> =>
      Effect.gen(function* () {
        const bundle = bundles.get(id)
        if (!bundle) return yield* Effect.fail(new Error(`Unknown plugin bundle: ${id}`))
        if (bundle.status === "active" || bundle.status === "loading") return
        bundle.status = "loading"
        bundle.health = undefined
        const plugin = yield* bundle.load().pipe(
          Effect.catchCause(() => {
            bundle.status = "failed"
            bundle.health = { message: "Bundle activation failed" }
            return Effect.fail(new Error(`Plugin bundle activation failed: ${id}`))
          }),
        )
        if (plugin.id !== id) {
          bundle.status = "failed"
          bundle.health = { message: "Bundle activation failed" }
          return yield* Effect.fail(new Error(`Plugin bundle activation failed: ${id}`))
        }
        yield* plugins.add(ID.make(plugin.id), plugin.effect).pipe(
          Effect.catchCause(() => {
            bundle.status = "failed"
            bundle.health = { message: "Bundle activation failed" }
            return Effect.fail(new Error(`Plugin bundle activation failed: ${id}`))
          }),
        )
        bundle.status = "active"
      })
    const unload = (id: string): Effect.Effect<void, Error> =>
      Effect.gen(function* () {
        const bundle = bundles.get(id)
        if (!bundle) return yield* Effect.fail(new Error(`Unknown plugin bundle: ${id}`))
        if (bundle.status !== "active") return
        yield* plugins.remove(ID.make(bundle.manifest.id))
        bundle.status = "unloaded"
        bundle.health = undefined
      })
    return Service.of({ list, discover, activate, unload })
  }),
)

export const locationLayer = layer

export const node = makeLocationNode({ service: Service, layer: layer as Layer.Layer<Service>, deps: [] })

export * as ConfigExternalPlugin from "./external"

import type { Plugin as EffectPlugin } from "@opencode-ai/plugin/v2/effect"
import type { Plugin as PromisePlugin } from "@opencode-ai/plugin/v2/promise"
import { Effect, Schema } from "effect"
import path from "path"
import { fileURLToPath, pathToFileURL } from "url"
import { Config } from "../../config"
import { FSUtil } from "../../fs-util"
import { Location } from "../../location"
import { Npm } from "../../npm"
import { Bundle } from "../../plugin/bundle"
import { define } from "../../plugin/internal"
import { PluginPromise } from "../../plugin/promise"

const PluginModule = Schema.Struct({
  default: Schema.Union([
    Schema.Struct({
      id: Schema.String,
      effect: Schema.declare<EffectPlugin["effect"]>(
        (input): input is EffectPlugin["effect"] => typeof input === "function",
      ),
    }),
    Schema.Struct({
      id: Schema.String,
      setup: Schema.declare<PromisePlugin["setup"]>(
        (input): input is PromisePlugin["setup"] => typeof input === "function",
      ),
    }),
  ]),
})

const BundleFile = Schema.Struct({ entrypoint: Schema.String })
const decodeBundleFile = Schema.decodeUnknownSync(BundleFile)

const decodePlugin = (mod: unknown) =>
  Effect.gen(function* () {
    const value = (yield* Schema.decodeUnknownEffect(PluginModule)(mod)).default
    return "effect" in value ? value : PluginPromise.fromPromise(value)
  })

export const Plugin = define({
  id: "config-plugin",
  effect: Effect.fn(function* (ctx) {
    const config = yield* Config.Service
    const fs = yield* FSUtil.Service
    const location = yield* Location.Service
    const npm = yield* Npm.Service
    const bundles = yield* Bundle.Service
    yield* Effect.gen(function* () {
      const configured: { package: string; options?: Record<string, any> }[] = []

      for (const entry of yield* config.entries()) {
        if (entry.type === "document") {
          const directory = entry.path ? path.dirname(entry.path) : location.directory
          for (const item of entry.info.plugins ?? []) {
            const ref = typeof item === "string" ? { package: item } : item
            const packageName = (() => {
              if (ref.package.startsWith("file://")) return fileURLToPath(ref.package)
              if (ref.package.startsWith("./") || ref.package.startsWith("../")) {
                return path.resolve(directory, ref.package)
              }
              return ref.package
            })()
            configured.push({ package: packageName, options: ref.options })
          }
        }

        if (entry.type === "directory") {
          const files = yield* fs
            .glob("{plugin,plugins}/*.{ts,js}", {
              cwd: entry.path,
              absolute: true,
              include: "file",
              dot: true,
              symlink: true,
            })
            .pipe(Effect.orElseSucceed(() => []))
          files.sort()
          for (const file of files) configured.push({ package: file })

          const manifests = yield* fs
            .glob("plugin-bundles/*.json", {
              cwd: entry.path,
              absolute: true,
              include: "file",
              dot: true,
              symlink: true,
            })
            .pipe(Effect.orElseSucceed(() => []))
          manifests.sort()
          for (const file of manifests) {
            yield* fs.readJson(file).pipe(
              Effect.andThen((input) =>
                Effect.sync(() => ({
                  manifest: Bundle.decodeManifest(input),
                  entrypoint: decodeBundleFile(
                    typeof input === "object" && input !== null && !Array.isArray(input)
                      ? { entrypoint: (input as Record<string, unknown>).entrypoint }
                      : input,
                  ).entrypoint,
                })),
              ),
              Effect.andThen((bundle) =>
                bundles.discover(bundle.manifest, () =>
                  Effect.promise(() => import(pathToFileURL(path.resolve(path.dirname(file), bundle.entrypoint)).href)).pipe(
                    Effect.andThen(decodePlugin),
                  ),
                ),
              ),
              Effect.ignoreCause,
            )
          }
        }
      }

      for (const ref of configured) {
        yield* Effect.gen(function* () {
          const entrypoint = path.isAbsolute(ref.package)
            ? pathToFileURL(ref.package).href
            : (yield* npm.add(ref.package)).entrypoint
          if (!entrypoint) return

          const mod = yield* Effect.promise(() => import(entrypoint))
          const plugin = yield* decodePlugin(mod)
          yield* ctx.plugin.add({
            id: plugin.id,
            effect: (host) => plugin.effect({ ...host, options: ref.options ?? {} }),
          })
        }).pipe(Effect.ignoreCause)
      }
    }).pipe(Effect.forkScoped({ startImmediately: true }))
  }),
})

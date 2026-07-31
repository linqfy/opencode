import type { Effect } from "effect"

export interface PluginBundleManifest {
  readonly id: string
  readonly version: string
  readonly provenance: { readonly source: string; readonly location: string }
  readonly permissions: readonly string[]
  readonly startup: "required" | "optional" | "lazy"
  readonly contributions: {
    readonly providerProfiles?: boolean
    readonly tools?: boolean
    readonly mcpServers?: boolean
    readonly panels?: boolean
    readonly skills?: boolean
    readonly hooks?: boolean
    readonly commands?: boolean
    readonly modelCatalog?: boolean
    readonly permissionDefaults?: boolean
    readonly appServerExtensions?: boolean
  }
}

export type PluginBundleStatus = "discovered" | "loading" | "active" | "failed" | "unloaded"

export interface PluginBundleInfo {
  readonly manifest: PluginBundleManifest
  readonly status: PluginBundleStatus
  readonly health?: { readonly message: string }
}

export interface PluginBundleLoader {
  readonly list: () => Effect.Effect<readonly PluginBundleInfo[]>
  readonly activate: (id: string) => Effect.Effect<void, Error>
  readonly unload: (id: string) => Effect.Effect<void, Error>
}

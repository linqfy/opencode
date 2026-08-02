export * as SandboxProcess from "./sandbox"

import { Sandbox } from "@ultracode/sandbox"
import { realpathSync } from "node:fs"
import { Context, Layer } from "effect"
import { makeGlobalNode } from "./effect/app-node"

const platform = process.platform === "win32" ? "win32" : process.platform === "darwin" ? "darwin" : "linux"
const wsl = process.platform === "linux" && (process.env.WSL_DISTRO_NAME !== undefined || process.env.WSL_INTEROP !== undefined)

export const unconfinedProfile = Sandbox.Profile.unconfined()

export interface Interface {
  readonly plan: (request: Sandbox.LaunchRequest) => Sandbox.Plan
  readonly prepare?: (request: Sandbox.LaunchRequest) => Promise<Sandbox.Plan>
}

export class Service extends Context.Service<Service, Interface>()("@ultracode/SandboxProcess") {}

const supervisor =
  platform === "win32" && process.env.ULTRACODE_SANDBOX_BROKER
    ? Sandbox.NativeSupervisor.create({ path: process.env.ULTRACODE_SANDBOX_BROKER })
    : undefined

const broker = Sandbox.Broker.create({
  platform,
  wsl,
  resolvePath: realpathSync.native,
})

const layer = Layer.succeed(
  Service,
  Service.of({
    plan: broker.plan,
    prepare: async (request) => {
      if (request.profile.mode === "unconfined") return broker.plan(request)
      if (!supervisor) return { outcome: "deny", reason: "containment-unsupported" }
      const capabilities = await supervisor.ensureForProfile(request.profile)
      if (capabilities.length === 0) return { outcome: "deny", reason: "containment-unsupported" }
      return Sandbox.Broker.create({
        platform,
        wsl,
        capabilities,
        containment: () => ({ outcome: "allow" }),
        resolvePath: realpathSync.native,
      }).plan(request)
    },
  }),
)

export const node = makeGlobalNode({ service: Service, layer, deps: [] })

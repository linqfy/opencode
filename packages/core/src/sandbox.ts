export * as SandboxProcess from "./sandbox"

import { Sandbox } from "@ultracode/sandbox"
import { Context, Layer } from "effect"
import { makeGlobalNode } from "./effect/app-node"

export const unconfinedProfile = Sandbox.Profile.unconfined()

export interface Interface {
  readonly plan: (request: Sandbox.LaunchRequest) => Sandbox.Plan
}

export class Service extends Context.Service<Service, Interface>()("@ultracode/SandboxProcess") {}

const layer = Layer.succeed(
  Service,
  Service.of({
    plan: Sandbox.Broker.create({
      platform: process.platform === "win32" ? "win32" : process.platform === "darwin" ? "darwin" : "linux",
      wsl: process.env.WSL_DISTRO_NAME !== undefined || process.env.WSL_INTEROP !== undefined,
    }).plan,
  }),
)

export const node = makeGlobalNode({ service: Service, layer, deps: [] })

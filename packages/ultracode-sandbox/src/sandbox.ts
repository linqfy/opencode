import path from "node:path"

export type Authorization = "allow" | "ask" | "deny"
export type NetworkPolicy = "allow" | "deny"
export type WindowsContainment = "none" | "requested" | "required"

export type Profile = {
  readonly mode?: "unconfined"
  readonly writableRoots: ReadonlyArray<string>
  readonly readRoots: ReadonlyArray<string>
  readonly allowedExecutables: ReadonlyArray<string>
  readonly environment: ReadonlyArray<string>
  readonly network: NetworkPolicy
  readonly windowsContainment: WindowsContainment
}

export const Profile = {
  unconfined: (): Profile => ({
    mode: "unconfined",
    writableRoots: ["*"],
    readRoots: ["*"],
    allowedExecutables: ["*"],
    environment: ["*"],
    network: "allow",
    windowsContainment: "none",
  }),
}

export type LaunchRequest = {
  readonly authorization: Authorization
  readonly profile: Profile
  readonly executable: string
  readonly args: ReadonlyArray<string>
  readonly cwd: string
  readonly environment: Readonly<Record<string, string | undefined>>
}

export type DeniedPlan = {
  readonly outcome: "deny"
  readonly reason:
    | "authorization-not-allowed"
    | "containment-unsupported"
    | "executable-not-allowed"
    | "cwd-outside-readable-roots"
    | "cwd-outside-writable-roots"
    | "network-policy"
}

export type LaunchPlan = {
  readonly outcome: "allow"
  readonly executable: string
  readonly args: ReadonlyArray<string>
  readonly cwd: string
  readonly environment: Readonly<Record<string, string>>
  readonly containment: "unconfined" | "contained"
}

export type Plan = DeniedPlan | LaunchPlan

type Platform = "win32" | "linux" | "darwin"
type BackendDecision = Pick<Plan, "outcome"> & Partial<Pick<DeniedPlan, "reason">>

export type BrokerOptions = {
  readonly platform?: Platform
  readonly wsl?: boolean
  readonly policy?: (request: LaunchRequest) => BackendDecision
  readonly containment?: (request: LaunchRequest) => BackendDecision
}

export type Interface = {
  readonly plan: (request: LaunchRequest) => Plan
}

export const Broker = {
  create: (options: BrokerOptions = {}): Interface => ({
    plan: (request) => plan(request, options),
  }),
}

function plan(request: LaunchRequest, options: BrokerOptions): Plan {
  if (request.authorization !== "allow") return denied("authorization-not-allowed")
  if (request.profile.mode === "unconfined") return allowed(request, "unconfined")
  if (request.profile.windowsContainment !== "none" && options.platform !== "win32")
    return denied("containment-unsupported")
  if (options.wsl || !options.containment) return denied("containment-unsupported")
  const policy = options.policy?.(request)
  if (policy?.outcome === "deny") return denied(policy.reason ?? "network-policy")
  if (!isAllowedExecutable(request.executable, request.profile.allowedExecutables))
    return denied("executable-not-allowed")
  if (!contains(request.cwd, request.profile.readRoots, options.platform)) return denied("cwd-outside-readable-roots")
  if (!contains(request.cwd, request.profile.writableRoots, options.platform))
    return denied("cwd-outside-writable-roots")
  const containment = options.containment(request)
  if (containment.outcome === "deny") return denied(containment.reason ?? "containment-unsupported")
  return allowed(request, "contained")
}

function denied(reason: DeniedPlan["reason"]): DeniedPlan {
  return { outcome: "deny", reason }
}

function allowed(request: LaunchRequest, containment: LaunchPlan["containment"]): LaunchPlan {
  return {
    outcome: "allow",
    executable: request.executable,
    args: request.args,
    cwd: request.cwd,
    environment: filterEnvironment(request.environment, request.profile.environment),
    containment,
  }
}

function isAllowedExecutable(executable: string, allowed: ReadonlyArray<string>): boolean {
  return allowed.includes("*") || allowed.includes(executable)
}

function contains(candidate: string, roots: ReadonlyArray<string>, platform: Platform | undefined): boolean {
  if (roots.includes("*")) return true
  const api = platform === "win32" ? path.win32 : path.posix
  const resolved = api.resolve(candidate)
  return roots.some((root) => {
    const resolvedRoot = api.resolve(root)
    return resolved === resolvedRoot || resolved.startsWith(`${resolvedRoot}${api.sep}`)
  })
}

function filterEnvironment(
  environment: Readonly<Record<string, string | undefined>>,
  allowed: ReadonlyArray<string>,
): Readonly<Record<string, string>> {
  return Object.fromEntries(
    Object.entries(environment)
      .filter(
        (entry): entry is [string, string] =>
          entry[1] !== undefined && (allowed.includes("*") || allowed.includes(entry[0])),
      )
      .sort(([left], [right]) => (left < right ? -1 : left > right ? 1 : 0)),
  )
}

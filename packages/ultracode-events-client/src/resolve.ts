import { accessSync, constants, existsSync } from "node:fs"
import { delimiter, dirname, join } from "node:path"

export class SidecarNotFoundError extends Error {
  readonly _tag: "SidecarNotFoundError" = "SidecarNotFoundError"
  constructor(message: string) {
    super(message)
    this.name = "SidecarNotFoundError"
  }
}

export async function resolveSidecarBin(opts: { env?: NodeJS.ProcessEnv; cwd?: string } = {}): Promise<string> {
  const env = opts.env ?? process.env
  const probed: string[] = []
  const envOverride = env.ULTRACODE_EVENTS_SIDECAR_BIN
  if (envOverride) {
    probed.push(envOverride)
    if (await isExecutable(envOverride)) return envOverride
    throw new SidecarNotFoundError(notFoundMessage(probed))
  }
  const candidates = [...bundledCandidates(), ...targetCandidates(opts.cwd ?? process.cwd()), ...pathCandidates(env)]
  for (const candidate of candidates) {
    probed.push(candidate)
    if (await isExecutable(candidate)) return candidate
  }
  throw new SidecarNotFoundError(notFoundMessage(probed))
}

async function isExecutable(p: string): Promise<boolean> {
  if (!(await Bun.file(p).exists())) return false
  if (process.platform === "win32") return true
  try {
    accessSync(p, constants.X_OK)
    return true
  } catch {
    return false
  }
}

function bundledCandidates(): string[] {
  const name = process.platform === "win32" ? "sidecar.exe" : "sidecar"
  return [join(import.meta.dir, "..", "..", "bin", name)]
}

function targetCandidates(cwd: string): string[] {
  const candidates: string[] = []
  let dir = cwd
  while (true) {
    candidates.push(join(dir, "target", "release", "sidecar"), join(dir, "target", "debug", "sidecar"))
    if (existsSync(join(dir, "target"))) break
    const parent = dirname(dir)
    if (parent === dir) break
    dir = parent
  }
  return candidates
}

function pathCandidates(env: NodeJS.ProcessEnv): string[] {
  const name = process.platform === "win32" ? "ultracode-events-sidecar.exe" : "ultracode-events-sidecar"
  return (env.PATH ?? "").split(delimiter).filter((dir) => dir.length > 0).map((dir) => join(dir, name))
}

function notFoundMessage(probed: string[]): string {
  return [
    "Could not locate the ultracode-events sidecar binary.",
    "Probed paths:",
    ...probed.map((p) => `  ${p}`),
    "Set the ULTRACODE_EVENTS_SIDECAR_BIN environment variable to the sidecar binary path.",
  ].join("\n")
}

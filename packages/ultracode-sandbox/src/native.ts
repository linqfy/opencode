import type { Profile } from "./sandbox"

export const BROKER_PROTOCOL_VERSION = 1

export type BrokerCapability =
  | "job-object-atomic"
  | "explicit-environment"
  | "restricted-token"
  | "writable-root"
  | "network-deny"

export type BrokerRequest =
  | { readonly version: 1; readonly request_id: string; readonly method: "probe" }
  | {
      readonly version: 1
      readonly request_id: string
      readonly method: "launch"
      readonly executable: string
      readonly args: ReadonlyArray<string>
      readonly cwd: string
      readonly roots: { readonly read: ReadonlyArray<string>; readonly writable: ReadonlyArray<string> }
      readonly environment: Readonly<Record<string, string>>
      readonly network: "allow" | "deny"
    }
  | { readonly version: 1; readonly request_id: string; readonly method: "terminate"; readonly job_id: string }

export type BrokerResponse =
  | {
      readonly version: 1
      readonly request_id: string
      readonly method: "probe"
      readonly outcome: "ready" | "unsupported" | "failed"
      readonly capabilities: ReadonlyArray<BrokerCapability>
      readonly reason?: string
    }
  | {
      readonly version: 1
      readonly request_id: string
      readonly method: "launch"
      readonly outcome: "started" | "denied" | "failed"
      readonly job_id?: string
      readonly pid?: number
      readonly reason?: string
    }
  | {
      readonly version: 1
      readonly request_id: string
      readonly method: "terminate"
      readonly outcome: "terminated" | "denied" | "failed"
      readonly reason?: string
    }

export type NativeBroker = {
  readonly request: (request: BrokerRequest) => Promise<BrokerResponse>
  readonly close: () => void
}

export function launchRequest(
  requestId: string,
  executable: string,
  args: ReadonlyArray<string>,
  cwd: string,
  readRoots: ReadonlyArray<string>,
  writableRoots: ReadonlyArray<string>,
  environment: Readonly<Record<string, string>>,
  network: "allow" | "deny",
): BrokerRequest {
  return {
    version: 1,
    request_id: requestId,
    method: "launch",
    executable,
    args,
    cwd,
    roots: { read: readRoots, writable: writableRoots },
    environment,
    network,
  }
}

export function parseBrokerResponse(line: string): BrokerResponse {
  const value: unknown = JSON.parse(line)
  if (!isRecord(value) || value.version !== BROKER_PROTOCOL_VERSION)
    throw new Error("unsupported protocol version")
  if (typeof value.request_id !== "string" || typeof value.method !== "string")
    throw new Error("invalid broker response")
  if (value.method === "probe" && (value.outcome === "ready" || value.outcome === "unsupported" || value.outcome === "failed")) {
    if (!Array.isArray(value.capabilities) || !value.capabilities.every(isCapability))
      throw new Error("invalid probe response")
    return value as BrokerResponse
  }
  if (
    value.method === "launch" &&
    (value.outcome === "started" || value.outcome === "denied" || value.outcome === "failed")
  )
    return value as BrokerResponse
  if (
    value.method === "terminate" &&
    (value.outcome === "terminated" || value.outcome === "denied" || value.outcome === "failed")
  )
    return value as BrokerResponse
  throw new Error("invalid broker response")
}

type BrokerFactory = (path: string) => NativeBroker
type ProcessFactory = (path: string) => Bun.Subprocess

export function createNativeBroker(path: string, spawnProcess: ProcessFactory = (executable) => Bun.spawn([executable], { stdin: "pipe", stdout: "pipe", stderr: "pipe" })): NativeBroker {
  let broker = createProcessBroker(path, spawnProcess)
  return {
    request: async (request) => {
      const response = await broker.request(request)
      if (request.method !== "probe" || response.outcome !== "failed" || response.reason !== "broker-disconnected")
        return response
      broker.close()
      broker = createProcessBroker(path, spawnProcess)
      return broker.request(request)
    },
    close: () => broker.close(),
  }
}

export type NativeSupervisor = {
  readonly ensure: (required: ReadonlyArray<BrokerCapability>) => Promise<ReadonlyArray<BrokerCapability>>
  readonly ensureForProfile: (profile: Profile) => Promise<ReadonlyArray<BrokerCapability>>
  readonly request: (request: BrokerRequest) => Promise<BrokerResponse>
  readonly capabilities: () => ReadonlyArray<BrokerCapability>
  readonly close: () => void
}

export const NativeSupervisor = {
  create: (options: { readonly path: string; readonly broker?: BrokerFactory }): NativeSupervisor => {
    let broker: NativeBroker | undefined
    let capabilities: ReadonlyArray<BrokerCapability> = []
    let probe: Promise<ReadonlyArray<BrokerCapability>> | undefined

    const ensure = async (required: ReadonlyArray<BrokerCapability>) => {
      if (!probe) {
        try {
          broker = options.broker?.(options.path) ?? createNativeBroker(options.path)
        } catch {
          return []
        }
        probe = broker
          .request({ version: 1, request_id: `probe-${crypto.randomUUID()}`, method: "probe" })
          .then((response) => {
            if (response.method !== "probe" || response.outcome !== "ready") {
              broker?.close()
              broker = undefined
              probe = undefined
              return []
            }
            capabilities = response.capabilities
            return capabilities
          })
          .catch(() => {
            broker?.close()
            broker = undefined
            probe = undefined
            return []
          })
      }
      const available = await probe
      return required.every((capability) => available.includes(capability)) ? available : []
    }

    const close = () => {
      broker?.close()
      broker = undefined
      probe = undefined
      capabilities = []
    }

    return {
      ensure,
      ensureForProfile: (profile) =>
        ensure([
          "job-object-atomic",
          "explicit-environment",
          "restricted-token",
          ...(profile.writableRoots.length > 0 ? ["writable-root" as const] : []),
          ...(profile.network === "deny" ? ["network-deny" as const] : []),
        ]),
      request: async (request) => {
        await ensure([])
        const response = await broker!.request(request)
        if (response.reason === "broker-disconnected") close()
        return response
      },
      capabilities: () => capabilities,
      close,
    }
  },
}

function createProcessBroker(path: string, spawnProcess: ProcessFactory): NativeBroker {
  const process = spawnProcess(path)
  if (!(process.stdout instanceof ReadableStream)) throw new Error("broker stdout is not piped")
  if (!process.stdin || typeof process.stdin === "number" || !("write" in process.stdin)) throw new Error("broker stdin is not piped")
  const stdin = process.stdin
  const reader = process.stdout.getReader()
  let buffer = ""
  const pending = new Map<string, { readonly method: BrokerRequest["method"]; readonly resolve: (response: BrokerResponse) => void }>()
  let closed = false
  const fail = (reason: string) => {
    if (closed) return
    closed = true
    for (const [requestId, entry] of pending) entry.resolve(failedResponse(requestId, entry.method, reason))
    pending.clear()
  }
  const read = async (): Promise<void> => {
    try {
      const result = await reader.read()
      if (result.done) {
        fail("broker-disconnected")
        return
      }
      buffer += new TextDecoder().decode(result.value)
      const lines = buffer.split("\n")
      buffer = lines.pop() ?? ""
      for (const line of lines.filter(Boolean)) {
        const response = parseBrokerResponse(line)
        const entry = pending.get(response.request_id)
        if (!entry || entry.method !== response.method) {
          fail("broker-protocol")
          return
        }
        entry.resolve(response)
        pending.delete(response.request_id)
      }
      await read()
    } catch {
      fail("broker-protocol")
    }
  }
  void read()
  return {
    request: async (request) => {
      if (closed) return failedResponse(request.request_id, request.method, "broker-disconnected")
      const response = new Promise<BrokerResponse>((resolve) => pending.set(request.request_id, { method: request.method, resolve }))
      try {
        await stdin.write(`${JSON.stringify(request)}\n`)
      } catch {
        fail("broker-write-failed")
      }
      return response
    },
    close: () => {
      fail("broker-disconnected")
      process.kill()
    },
  }
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === "object" && value !== null
}

function isCapability(value: unknown): value is BrokerCapability {
  return (
    value === "job-object-atomic" ||
    value === "explicit-environment" ||
    value === "restricted-token" ||
    value === "writable-root" ||
    value === "network-deny"
  )
}

function failedResponse(requestId: string, method: BrokerResponse["method"], reason: string): BrokerResponse {
  if (method === "probe")
    return {
      version: 1,
      request_id: requestId,
      method,
      outcome: "failed",
      capabilities: [],
      reason,
    }
  return {
    version: 1,
    request_id: requestId,
    method,
    outcome: "failed",
    reason,
  }
}

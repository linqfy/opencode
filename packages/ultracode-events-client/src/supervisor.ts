import { spawn, type Subprocess } from "bun"
import { mkdirSync } from "node:fs"
import path from "node:path"
import { EventsClient } from "./index"
import { resolveSidecarBin } from "./resolve"

const BACKOFFS = [250, 1000, 5000]

export type SupervisedHealth = "ok" | "restarting" | "down"

export type StartSupervisedOptions = {
  journalDir: string
  bufferLimit?: number
  maxRestarts?: number
  spawnCommand?: string[]
}

export type SupervisedClient = EventsClient & {
  restartCount(): number
  health(): SupervisedHealth
  dispose(): Promise<void>
  debug: { killForTest(): void }
}

export class SidecarBufferOverflowError extends Error {
  readonly _tag: "SidecarBufferOverflowError" = "SidecarBufferOverflowError"
  constructor(message = "sidecar offline buffer overflow") {
    super(message)
    this.name = "SidecarBufferOverflowError"
  }
}

type QueuedCall = {
  method: string
  args: unknown[]
  resolve: (value: unknown) => void
  reject: (reason: unknown) => void
}

const SUPERVISED_PROPS = new Set(["restartCount", "health", "dispose", "debug", "client"])

export async function startSupervised(opts: StartSupervisedOptions): Promise<SupervisedClient> {
  const supervisor = new Supervisor(opts)
  return supervisor.start()
}

class Supervisor {
  readonly bufferLimit: number
  readonly maxRestarts: number | undefined
  readonly debug = { killForTest: () => this.killForTest() }
  private readonly spawnCommand?: string[]
  private readonly journalDir: string
  private readonly client: SupervisedClient
  private readonly firstOk: Promise<void>
  private argv: string[] = []
  private current?: EventsClient
  private proc?: Subprocess
  private generation = 0
  private state: SupervisedHealth = "restarting"
  private restarts = 0
  private backoffIndex = 0
  private queue: QueuedCall[] = []
  private flushing = false
  private disposed = false
  private resolveFirstOk?: () => void
  private rejectFirstOk?: (reason: unknown) => void

  constructor(opts: StartSupervisedOptions) {
    this.journalDir = opts.journalDir
    this.bufferLimit = opts.bufferLimit ?? 256
    this.maxRestarts = opts.maxRestarts
    this.spawnCommand = opts.spawnCommand
    this.firstOk = new Promise<void>((resolve, reject) => {
      this.resolveFirstOk = resolve
      this.rejectFirstOk = reject
    })
    this.client = supervisedProxy(this)
  }

  async start(): Promise<SupervisedClient> {
    this.argv = await this.buildArgv()
    this.spawnGeneration()
    await this.firstOk
    return this.client
  }

  async dispose(): Promise<void> {
    if (this.disposed) return
    this.disposed = true
    this.state = "down"
    this.rejectFirstOk?.(new Error("client disposed"))
    for (const item of this.queue) item.reject(new Error("client disposed"))
    this.queue = []
    const proc = this.proc
    if (proc) {
      proc.kill("SIGTERM")
      const exited = await Promise.race([proc.exited.then(() => true), Bun.sleep(2000).then(() => false)])
      if (!exited) proc.kill("SIGKILL")
    }
  }

  restartCount(): number {
    return this.restarts
  }

  health(): SupervisedHealth {
    return this.state
  }

  route(method: string, args: unknown[]): Promise<unknown> {
    if (this.state === "down") return Promise.reject(new Error("client disposed"))
    if (this.state !== "ok" && this.queue.length >= this.bufferLimit) {
      return Promise.reject(new SidecarBufferOverflowError())
    }
    return new Promise<unknown>((resolve, reject) => {
      this.queue.push({ method, args, resolve, reject })
      if (this.state === "ok") void this.flushQueue()
    })
  }

  private async buildArgv(): Promise<string[]> {
    if (this.spawnCommand) return this.spawnCommand
    mkdirSync(this.journalDir, { recursive: true })
    mkdirSync(path.join(this.journalDir, "artifacts"), { recursive: true })
    const bin = await resolveSidecarBin()
    return [
      bin,
      "--journal-dir",
      this.journalDir,
      "--db",
      path.join(this.journalDir, "db.sqlite"),
      "--artifacts",
      path.join(this.journalDir, "artifacts"),
      "--session",
      path.join(this.journalDir, "session"),
    ]
  }

  private spawnGeneration(): void {
    this.generation += 1
    const generation = this.generation
    const proc = spawn(this.argv, { stdin: "pipe", stdout: "pipe", stderr: "ignore" })
    this.proc = proc
    this.current = EventsClient.attach(proc)
    void proc.exited.then((code) => this.onExit(generation, code))
    void this.handshake(generation)
  }

  private async handshake(generation: number): Promise<void> {
    try {
      await this.invokeOnCurrent("ping", [])
    } catch {
      if (generation === this.generation && !this.disposed) this.proc?.kill()
      return
    }
    if (generation !== this.generation || this.disposed) return
    this.state = "ok"
    this.backoffIndex = 0
    this.resolveFirstOk?.()
    void this.flushQueue()
  }

  private onExit(generation: number, code: number): void {
    if (this.disposed || generation !== this.generation) return
    this.state = "restarting"
    this.scheduleRestart()
  }

  private scheduleRestart(): void {
    this.restarts += 1
    if (this.maxRestarts !== undefined && this.restarts > this.maxRestarts) {
      this.state = "down"
      this.rejectFirstOk?.(new Error("sidecar restart limit exceeded"))
      for (const item of this.queue) item.reject(new Error("client disposed"))
      this.queue = []
      return
    }
    const delay = BACKOFFS[Math.min(this.backoffIndex, BACKOFFS.length - 1)]!
    this.backoffIndex += 1
    void Bun.sleep(delay).then(() => {
      if (this.disposed || this.state === "down") return
      this.spawnGeneration()
    })
  }

  private async flushQueue(): Promise<void> {
    if (this.flushing) return
    this.flushing = true
    try {
      while (this.queue.length > 0 && this.state === "ok") {
        const item = this.queue[0]!
        try {
          const value = await this.invokeOnCurrent(item.method, item.args)
          this.queue.shift()
          item.resolve(value)
        } catch (error) {
          if (isTransportError(error) && this.health() !== "down") {
            this.state = "restarting"
            this.proc?.kill()
            return
          }
          this.queue.shift()
          item.reject(error)
        }
      }
    } finally {
      this.flushing = false
    }
  }

  private async invokeOnCurrent(method: string, args: unknown[]): Promise<unknown> {
    const client = this.current!
    const methodCall = client[method as keyof EventsClient] as unknown as (...args: unknown[]) => unknown
    return await methodCall.bind(client)(...args)
  }

  private killForTest(): void {
    if (!this.disposed) this.proc?.kill()
  }
}

function isTransportError(error: unknown): boolean {
  return error instanceof Error && error.message === "sidecar closed stdout"
}

function supervisedProxy(owner: Supervisor): SupervisedClient {
  return new Proxy(owner, {
    get(target, prop) {
      if (prop === "then" || prop === "constructor" || typeof prop === "symbol") return undefined
      if (typeof prop === "string" && SUPERVISED_PROPS.has(prop)) {
        const value = target[prop as keyof Supervisor]
        return typeof value === "function" ? value.bind(target) : value
      }
      return (...args: unknown[]) => target.route(prop as string, args)
    },
  }) as unknown as SupervisedClient
}

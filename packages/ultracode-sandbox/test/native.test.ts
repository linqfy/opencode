import { describe, expect, test } from "bun:test"
import { createNativeBroker, launchRequest, NativeSupervisor, parseBrokerResponse } from "../src/native"

describe("sandbox native protocol", () => {
  test("rejects a response with an unsupported protocol version", () => {
    expect(() =>
      parseBrokerResponse(
        JSON.stringify({
          version: 2,
          request_id: "request-1",
          outcome: "ready",
          capabilities: [],
        }),
      ),
    ).toThrow("unsupported protocol version")
  })

  test("serializes only the approved environment and roots", () => {
    expect(
      launchRequest("request-2", "C:\\tools\\node.exe", [], "C:\\workspace", ["C:\\workspace"], [], { PATH: "C:\\tools" }, "allow"),
    ).toEqual({
      version: 1,
      request_id: "request-2",
      method: "launch",
      executable: "C:\\tools\\node.exe",
      args: [],
      cwd: "C:\\workspace",
      roots: { read: ["C:\\workspace"], writable: [] },
      environment: { PATH: "C:\\tools" },
      network: "allow",
    })
  })

  test("rejects malformed broker responses", () => {
    expect(() => parseBrokerResponse(JSON.stringify({ version: 1, request_id: "x", method: "probe", outcome: "ready", capabilities: ["unknown"] }))).toThrow("invalid probe response")
  })

  test("preserves an explicit broker failure as a failed outcome", () => {
    expect(parseBrokerResponse(JSON.stringify({ version: 1, request_id: "x", method: "launch", outcome: "failed", reason: "broker-disconnected" }))).toMatchObject({
      outcome: "failed",
      reason: "broker-disconnected",
    })
  })

  test("converts malformed broker output into terminal failures for every pending request", async () => {
    const broker = createNativeBroker("unused", () =>
      Bun.spawn([process.execPath, "-e", "process.stdin.on('data', () => process.stdout.write('not-json\\n'))"], {
        stdin: "pipe",
        stdout: "pipe",
        stderr: "pipe",
      }),
    )
    const requests = [
      { version: 1 as const, request_id: "probe-1", method: "probe" as const },
      { version: 1 as const, request_id: "terminate-1", method: "terminate" as const, job_id: "job-1" },
    ]

    const responses = await Promise.all(requests.map((request) => broker.request(request)))
    broker.close()

    expect(responses).toEqual([
      expect.objectContaining({ request_id: "probe-1", method: "probe", outcome: "failed" }),
      expect.objectContaining({ request_id: "terminate-1", method: "terminate", outcome: "failed" }),
    ])
  })

  test("fails pending requests when the broker disconnects", async () => {
    const broker = createNativeBroker("unused", () =>
      Bun.spawn([process.execPath, "-e", "process.exit(0)"], {
        stdin: "pipe",
        stdout: "pipe",
        stderr: "pipe",
      }),
    )
    const responses = await Promise.all([
      broker.request({ version: 1, request_id: "probe-2", method: "probe" }),
      broker.request({ version: 1, request_id: "terminate-2", method: "terminate", job_id: "job-2" }),
    ])
    broker.close()

    expect(responses).toEqual([
      expect.objectContaining({ request_id: "probe-2", method: "probe", outcome: "failed", reason: "broker-disconnected" }),
      expect.objectContaining({ request_id: "terminate-2", method: "terminate", outcome: "failed", reason: "broker-disconnected" }),
    ])
  })

  test("does not replay a disconnected launch request", async () => {
    const spawns = { count: 0 }
    const broker = createNativeBroker("unused", () => {
      spawns.count += 1
      return Bun.spawn([process.execPath, "-e", "process.exit(0)"], {
        stdin: "pipe",
        stdout: "pipe",
        stderr: "pipe",
      })
    })

    const response = await broker.request({
      version: 1,
      request_id: "launch-1",
      method: "launch",
      executable: "C:\\tools\\safe.exe",
      args: [],
      cwd: "C:\\workspace",
      roots: { read: ["C:\\workspace"], writable: [] },
      environment: {},
      network: "allow",
    })

    expect(response).toMatchObject({ outcome: "failed", reason: "broker-disconnected" })
    expect(spawns.count).toBe(1)
    broker.close()
  })

  test("supervisor probes lazily and rejects profiles requiring unavailable capabilities", async () => {
    let probes = 0
    const supervisor = NativeSupervisor.create({
      path: "unused",
      broker: () => ({
        request: async (request) => {
          if (request.method === "probe") {
            probes += 1
            return {
              version: 1,
              request_id: request.request_id,
              method: "probe",
              outcome: "ready",
              capabilities: ["job-object-atomic", "explicit-environment", "restricted-token"],
            }
          }
          return { version: 1, request_id: request.request_id, method: request.method, outcome: "failed", reason: "unused" }
        },
        close: () => undefined,
      }),
    })

    expect(supervisor.capabilities()).toEqual([])
    await expect(supervisor.ensure(["job-object-atomic", "explicit-environment", "restricted-token"])).resolves.toEqual([
      "job-object-atomic",
      "explicit-environment",
      "restricted-token",
    ])
    await expect(supervisor.ensure(["job-object-atomic"])).resolves.toEqual([
      "job-object-atomic",
      "explicit-environment",
      "restricted-token",
    ])
    expect(probes).toBe(1)
    supervisor.close()
  })

  test("supervisor recreates a broker after a failed probe", async () => {
    let brokers = 0
    const supervisor = NativeSupervisor.create({
      path: "unused",
      broker: () => {
        brokers += 1
        const failed = brokers === 1
        return {
          request: async (request) =>
            failed
              ? { version: 1, request_id: request.request_id, method: "probe" as const, outcome: "failed" as const, capabilities: [] }
              : {
                  version: 1,
                  request_id: request.request_id,
                  method: "probe" as const,
                  outcome: "ready" as const,
                  capabilities: ["job-object-atomic", "explicit-environment", "restricted-token"],
                },
          close: () => undefined,
        }
      },
    })

    await expect(supervisor.ensure(["job-object-atomic"])).resolves.toEqual([])
    await expect(supervisor.ensure(["job-object-atomic"])).resolves.toContain("job-object-atomic")
    expect(brokers).toBe(2)
    supervisor.close()
  })
})

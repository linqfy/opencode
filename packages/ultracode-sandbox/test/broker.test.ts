import { describe, expect, test } from "bun:test"
import { Sandbox } from "../src"

const unconfined = Sandbox.Profile.unconfined()

const contained = (overrides: Partial<Sandbox.Profile> = {}): Sandbox.Profile => ({
  writableRoots: ["/workspace"],
  readRoots: ["/workspace", "/tools"],
  allowedExecutables: ["/tools/node"],
  environment: ["PATH", "SAFE"],
  network: "deny",
  windowsContainment: "none",
  ...overrides,
})

const request = (overrides: Partial<Sandbox.LaunchRequest> = {}): Sandbox.LaunchRequest => ({
  authorization: "allow",
  profile: unconfined,
  executable: "/tools/node",
  args: ["-e", "process.exit(0)"],
  cwd: "/workspace",
  environment: { PATH: "/tools", SAFE: "yes", SECRET_TOKEN: "do-not-leak" },
  ...overrides,
})

describe("Sandbox.Broker", () => {
  test("never escalates ask or deny authorization", () => {
    const broker = Sandbox.Broker.create({ platform: "linux" })

    expect(broker.plan(request({ authorization: "ask" }))).toMatchObject({
      outcome: "deny",
      reason: "authorization-not-allowed",
    })
    expect(broker.plan(request({ authorization: "deny" }))).toMatchObject({
      outcome: "deny",
      reason: "authorization-not-allowed",
    })
  })

  test("fails closed when Windows containment is requested without an audited backend", () => {
    const broker = Sandbox.Broker.create({ platform: "win32" })

    expect(broker.plan(request({ profile: contained() }))).toMatchObject({
      outcome: "deny",
      reason: "containment-unsupported",
    })
  })

  test("fails closed for WSL when containment is requested", () => {
    const broker = Sandbox.Broker.create({ platform: "linux", wsl: true })

    expect(broker.plan(request({ profile: contained({ windowsContainment: "requested" }) }))).toMatchObject({
      outcome: "deny",
      reason: "containment-unsupported",
    })
  })

  test("rejects Windows containment when the selected platform cannot enforce it", () => {
    const broker = Sandbox.Broker.create({ platform: "linux", containment: () => ({ outcome: "allow" }) })

    expect(broker.plan(request({ profile: contained({ windowsContainment: "requested" }) }))).toMatchObject({
      outcome: "deny",
      reason: "containment-unsupported",
    })
  })

  test("filters the environment from the profile allowlist", () => {
    const broker = Sandbox.Broker.create({ platform: "linux", containment: () => ({ outcome: "allow" }) })
    const result = broker.plan(request({ profile: contained() }))

    expect(result).toMatchObject({ outcome: "allow", environment: { PATH: "/tools", SAFE: "yes" } })
    expect(result).not.toHaveProperty("environment.SECRET_TOKEN")
  })

  test("denies executables outside the profile", () => {
    const broker = Sandbox.Broker.create({ platform: "linux", containment: () => ({ outcome: "allow" }) })

    expect(broker.plan(request({ profile: contained(), executable: "/bin/sh" }))).toMatchObject({
      outcome: "deny",
      reason: "executable-not-allowed",
    })
  })

  test("denies writable root escapes", () => {
    const broker = Sandbox.Broker.create({ platform: "linux", containment: () => ({ outcome: "allow" }) })

    expect(broker.plan(request({ profile: contained(), cwd: "/workspace/../outside" }))).toMatchObject({
      outcome: "deny",
      reason: "cwd-outside-readable-roots",
    })
  })

  test("denies a working directory outside writable roots", () => {
    const broker = Sandbox.Broker.create({ platform: "linux", containment: () => ({ outcome: "allow" }) })

    expect(
      broker.plan(
        request({ profile: contained({ readRoots: ["/workspace", "/readonly"] }), cwd: "/readonly/project" }),
      ),
    ).toMatchObject({ outcome: "deny", reason: "cwd-outside-writable-roots" })
  })

  test("allows the broker to veto a policy-allowed request", () => {
    const broker = Sandbox.Broker.create({
      platform: "linux",
      policy: () => ({ outcome: "deny", reason: "network-policy" }),
      containment: () => ({ outcome: "allow" }),
    })

    expect(broker.plan(request({ profile: contained() }))).toMatchObject({ outcome: "deny", reason: "network-policy" })
  })

  test("permits host launch only through the explicit unconfined profile", () => {
    const broker = Sandbox.Broker.create({ platform: "linux" })

    expect(broker.plan(request())).toEqual({
      outcome: "allow",
      executable: "/tools/node",
      args: ["-e", "process.exit(0)"],
      cwd: "/workspace",
      environment: { PATH: "/tools", SAFE: "yes", SECRET_TOKEN: "do-not-leak" },
      containment: "unconfined",
    })
  })
})

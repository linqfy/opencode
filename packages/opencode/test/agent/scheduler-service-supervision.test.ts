import { describe, expect, test } from "bun:test"
import { Cause, Effect, Exit, Option } from "effect"
import { SchedulerService, SchedulerUnavailableError } from "../../src/agent/scheduler-service"

describe("SchedulerService honest degradation", () => {
  test("missing sidecar binary builds a degraded layer, not a crash", async () => {
    const previous = process.env.ULTRACODE_EVENTS_SIDECAR_BIN
    process.env.ULTRACODE_EVENTS_SIDECAR_BIN = "/nonexistent/sidecar"
    try {
      const result = await Effect.runPromiseExit(
        Effect.gen(function* () {
          const svc = yield* SchedulerService.Service
          return yield* svc.read
        }).pipe(Effect.provide(SchedulerService.layer)) as unknown as Effect.Effect<unknown, Error, never>,
      )
      expect(Exit.isFailure(result)).toBe(true)
      if (Exit.isFailure(result)) {
        const error = Cause.findErrorOption(result.cause)
        expect(Option.isSome(error)).toBe(true)
        if (Option.isSome(error)) {
          expect(error.value).toBeInstanceOf(SchedulerUnavailableError)
          expect(error.value.message).toContain("/nonexistent/sidecar")
          expect(error.value.message).toContain("ULTRACODE_EVENTS_SIDECAR_BIN")
        }
      }
    } finally {
      if (previous === undefined) delete process.env.ULTRACODE_EVENTS_SIDECAR_BIN
      else process.env.ULTRACODE_EVENTS_SIDECAR_BIN = previous
    }
  })

  test("adapter effect also fails with SchedulerUnavailableError in degraded mode", async () => {
    const previous = process.env.ULTRACODE_EVENTS_SIDECAR_BIN
    process.env.ULTRACODE_EVENTS_SIDECAR_BIN = "/nonexistent/sidecar"
    try {
      const result = await Effect.runPromiseExit(
        Effect.gen(function* () {
          const svc = yield* SchedulerService.Service
          return yield* svc.adapter
        }).pipe(Effect.provide(SchedulerService.layer)) as unknown as Effect.Effect<unknown, Error, never>,
      )
      expect(Exit.isFailure(result)).toBe(true)
      if (Exit.isFailure(result)) {
        const error = Cause.findErrorOption(result.cause)
        expect(Option.isSome(error)).toBe(true)
        if (Option.isSome(error)) {
          expect(error.value).toBeInstanceOf(SchedulerUnavailableError)
          expect(error.value.message).toContain("/nonexistent/sidecar")
          expect(error.value.message).toContain("ULTRACODE_EVENTS_SIDECAR_BIN")
        }
      }
    } finally {
      if (previous === undefined) delete process.env.ULTRACODE_EVENTS_SIDECAR_BIN
      else process.env.ULTRACODE_EVENTS_SIDECAR_BIN = previous
    }
  })
})

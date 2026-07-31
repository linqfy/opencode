import { describe, expect, test } from "bun:test"
import { scheduleMemoryTurn } from "../src"

describe("scheduleMemoryTurn", () => {
  test("returns before the scheduled work starts", async () => {
    let started = false

    scheduleMemoryTurn(async () => {
      started = true
    })

    expect(started).toBe(false)
    await new Promise<void>(queueMicrotask)
    expect(started).toBe(true)
  })

  test("swallows scheduled work rejections", async () => {
    let finished = false

    scheduleMemoryTurn(async () => {
      throw new Error("expected rejection")
    })
    scheduleMemoryTurn(async () => {
      finished = true
    })

    await new Promise<void>(queueMicrotask)
    await new Promise<void>(queueMicrotask)
    expect(finished).toBe(true)
  })
})

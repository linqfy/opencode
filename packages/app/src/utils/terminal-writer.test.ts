import { describe, expect, test } from "bun:test"
import { makeFrameScheduler, terminalWriter } from "./terminal-writer"

describe("terminalWriter thresholds", () => {
  test("flushes immediately when buffered bytes reach maxPendingBytes", () => {
    const written: string[] = []
    const writer = terminalWriter((data, done) => { written.push(data); done?.() }, { maxPendingBytes: 8 })
    writer.push("12345")
    expect(written).toEqual([])
    writer.push("678")
    expect(written).toEqual(["12345678"])
  })

  test("batches small writes into the scheduled frame", () => {
    const written: string[] = []
    const frames: (() => void)[] = []
    const writer = terminalWriter(
      (data, done) => { written.push(data); done?.() },
      { schedule: (fn) => frames.push(fn), maxPendingBytes: 1024 },
    )
    writer.push("a")
    writer.push("b")
    expect(written).toEqual([])
    expect(frames.length).toBe(1)
    frames[0]()
    expect(written).toEqual(["ab"])
  })

  test("frame scheduler fires the flush once per window", async () => {
    let calls = 0
    const schedule = makeFrameScheduler(10)
    schedule(() => calls++)
    schedule(() => calls++)
    expect(calls).toBe(0)
    await new Promise((resolve) => setTimeout(resolve, 30))
    expect(calls).toBe(1)
  })
})

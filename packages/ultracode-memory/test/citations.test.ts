import { describe, expect, test } from "bun:test"
import { parseMemoryCitations } from "../src/citations"

describe("parseMemoryCitations", () => {
  test("parses the explicit tag form with thread_id and path", () => {
    const out = `<output>use this\n<memory-citation thread_id="thread_abc" path="/repo/.ultra/memory/MEMORY.md" />\nend</output>`
    expect(parseMemoryCitations(out)).toEqual([
      { threadId: "thread_abc", path: "/repo/.ultra/memory/MEMORY.md" },
    ])
  })

  test("parses the explicit tag form without path", () => {
    const out = `see <memory-citation thread_id="t1" /> ref`
    expect(parseMemoryCitations(out)).toEqual([{ threadId: "t1" }])
  })

  test("parses the bracket form", () => {
    const out = "see [memory:t2] for context"
    expect(parseMemoryCitations(out)).toEqual([{ threadId: "t2" }])
  })

  test("deduplicates identical citations across both forms", () => {
    const out = `<memory-citation thread_id="t1"/> and [memory:t1]`
    expect(parseMemoryCitations(out)).toEqual([{ threadId: "t1" }])
  })

  test("returns empty on no citations", () => {
    expect(parseMemoryCitations("plain output with no markers")).toEqual([])
  })

  test("ignores malformed tags (missing thread_id, unclosed)", () => {
    expect(parseMemoryCitations(`<memory-citation path="/x" />`)).toEqual([])
    expect(parseMemoryCitations(`<memory-citation thread_id="t1"`)).toEqual([])
  })

  test("returns multiple citations in first-seen order", () => {
    const out = `<memory-citation thread_id="a"/><memory-citation thread_id="b"/>[memory:c]`
    expect(parseMemoryCitations(out).map((c) => c.threadId)).toEqual(["a", "b", "c"])
  })

  test("rejects thread ids with disallowed characters", () => {
    const out = `<memory-citation thread_id="has space"/><memory-citation thread_id="has.dots"/>`
    expect(parseMemoryCitations(out)).toEqual([])
  })
})

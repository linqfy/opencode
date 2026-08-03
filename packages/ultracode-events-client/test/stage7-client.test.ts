import { describe, expect, test } from "bun:test"
import { EventsClient } from "../src"

describe("Stage 7 sidecar client", () => {
  test("exposes bounded replay, artifact metadata, and authorized cancellation", async () => {
    const client = EventsClient.fromTransport(async (method) => {
      if (method === "list_events") return []
      if (method === "stat_artifact") return null
      return { state: "cancellation_pending" }
    })

    expect(await client.replay("session-1", 0, 20)).toEqual([])
    expect(await client.statArtifact("artifact-1", "session-1")).toBeNull()
    expect(
      await client.cancelTask("root-1", "task-1", "C:\\workspace", "stop", "cancel:root-1:task-1"),
    ).toEqual({ state: "cancellation_pending" })
  })
})

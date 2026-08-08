import { describe, expect } from "bun:test"
import { Effect } from "effect"
import { tmpdirScoped } from "../fixture/fixture"
import { testEffect } from "../lib/effect"
import { httpApiLayer, requestInDirectory } from "./httpapi-layer"

const it = testEffect(httpApiLayer)

describe("authority diagnostics HttpApi", () => {
  it.live("returns an empty paged page for a session without recorded diagnostics", () =>
    Effect.gen(function* () {
      const directory = yield* tmpdirScoped({ git: true })
      const response = yield* requestInDirectory(
        "/experimental/authority/sessions/ses_missing/diagnostics?limit=10",
        directory,
      )
      expect(response.status).toBe(200)
      expect(yield* response.json).toEqual({ rows: [], next_cursor: null })
    }),
  )
})

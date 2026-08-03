import { describe, expect } from "bun:test"
import { Effect } from "effect"
import { tmpdirScoped } from "../fixture/fixture"
import { testEffect } from "../lib/effect"
import { httpApiLayer, requestInDirectory } from "./httpapi-layer"

const it = testEffect(httpApiLayer)

describe("authority HttpApi", () => {
  it.live("returns a neutral empty page for a root outside the current location", () =>
    Effect.gen(function* () {
      const directory = yield* tmpdirScoped({ git: true })
      const response = yield* requestInDirectory("/experimental/authority/tasks?rootId=missing&limit=1", directory)

      expect(response.status).toBe(200)
      expect(yield* response.json).toEqual({ tasks: [], edges: [], next_cursor: null })
    }),
  )
})

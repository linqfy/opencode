import { describe, expect, test } from "bun:test"
import { EventsClient } from "../src"

describe("EventsClient", () => {
  test("is the workspace package client", () => {
    expect(EventsClient).toBeDefined()
  })
})

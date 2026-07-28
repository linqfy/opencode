import { describe, expect, test } from "bun:test"
import { createAttachmentPreview, disposeAttachmentPreview } from "./attachments"

describe("attachment previews", () => {
  test("image attachments get an object URL preview without touching bytes", () => {
    const urls: string[] = []
    const preview = createAttachmentPreview("image/png", new Blob(), () => {
      urls.push(`mock://url-${urls.length}`)
      return urls[urls.length - 1]
    })
    expect(preview).toBe("mock://url-0")
  })

  test("non-image attachments get no preview URL", () => {
    const preview = createAttachmentPreview("application/pdf", new Blob(), () => {
      throw new Error("must not create object URLs for non-images")
    })
    expect(preview).toBeUndefined()
  })

  test("dispose revokes a created preview URL exactly once", () => {
    const revoked: string[] = []
    const preview = createAttachmentPreview("image/png", new Blob(), () => "mock://url-x")
    disposeAttachmentPreview(preview, (url) => revoked.push(url))
    disposeAttachmentPreview(preview, (url) => revoked.push(url))
    expect(revoked).toEqual(["mock://url-x"])
  })

  test("dispose of undefined is a no-op", () => {
    expect(() => disposeAttachmentPreview(undefined, () => { throw new Error("never") })).not.toThrow()
  })
})

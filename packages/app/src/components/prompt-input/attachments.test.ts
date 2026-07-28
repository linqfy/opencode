import { describe, expect, test } from "bun:test"
import { attachmentMime, pickAttachmentFiles } from "./files"
import { pasteMode } from "./paste"
import { createAttachmentPreview, disposeAttachmentPreview } from "./attachments"

describe("attachmentMime", () => {
  test("keeps PDFs when the browser reports the mime", async () => {
    const file = new File(["%PDF-1.7"], "guide.pdf", { type: "application/pdf" })
    expect(await attachmentMime(file)).toBe("application/pdf")
  })

  test("normalizes structured text types to text/plain", async () => {
    const file = new File(['{"ok":true}\n'], "data.json", { type: "application/json" })
    expect(await attachmentMime(file)).toBe("text/plain")
  })

  test("accepts text files even with a misleading browser mime", async () => {
    const file = new File(["export const x = 1\n"], "main.ts", { type: "video/mp2t" })
    expect(await attachmentMime(file)).toBe("text/plain")
  })

  test("rejects binary files", async () => {
    const file = new File([Uint8Array.of(0, 255, 1, 2)], "blob.bin", { type: "application/octet-stream" })
    expect(await attachmentMime(file)).toBeUndefined()
  })
})

describe("pickAttachmentFiles", () => {
  test("reads the current project directory for every native picker invocation", async () => {
    const paths: string[] = []
    const files: File[] = []
    const file = new File(["hello"], "hello.txt", { type: "text/plain" })
    let directory = "C:\\Projects\\LoremIpsum"
    const picker = async (options?: { defaultPath?: string }, onFile?: (file: File) => Promise<unknown>) => {
      paths.push(options?.defaultPath ?? "")
      await onFile?.(file)
    }

    pickAttachmentFiles({
      picker,
      directory: () => directory,
      fallback: () => undefined,
      onFile: async (selected) => files.push(selected),
      onError: () => undefined,
    })
    await Promise.resolve()
    directory = "C:\\Projects\\DolorSit"
    pickAttachmentFiles({
      picker,
      directory: () => directory,
      fallback: () => undefined,
      onFile: async (selected) => files.push(selected),
      onError: () => undefined,
    })
    await Promise.resolve()
    expect(files).toEqual([file, file])
    expect(paths).toEqual(["C:\\Projects\\LoremIpsum", "C:\\Projects\\DolorSit"])
  })

  test("uses the browser file input when no native picker exists", async () => {
    let fallback = 0
    pickAttachmentFiles({
      directory: () => "/projects/consectetur-adipiscing",
      fallback: () => {
        fallback += 1
      },
      onFile: async () => undefined,
      onError: () => undefined,
    })
    expect(fallback).toBe(1)
  })

  test("reports native picker failures without rejecting", async () => {
    const error = new Error("picker unavailable")
    const errors: unknown[] = []
    const handled = Promise.withResolvers<void>()
    pickAttachmentFiles({
      picker: async () => Promise.reject(error),
      directory: () => "C:\\Projects\\LoremIpsum",
      fallback: () => undefined,
      onFile: async () => undefined,
      onError: (cause) => {
        errors.push(cause)
        handled.resolve()
      },
    })
    await handled.promise
    expect(errors).toEqual([error])
  })
})

describe("pasteMode", () => {
  test("uses native paste for short single-line text", () => {
    expect(pasteMode("hello world")).toBe("native")
  })

  test("uses manual paste for multiline text", () => {
    expect(
      pasteMode(`{
  "ok": true
}`),
    ).toBe("manual")
    expect(pasteMode("a\r\nb")).toBe("manual")
  })

  test("uses manual paste for large text", () => {
    expect(pasteMode("x".repeat(8000))).toBe("manual")
  })
})

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

#!/usr/bin/env bun
import { appendFileSync } from "node:fs"

const recordPath = process.argv[process.argv.length - 1]!
const dieAfterRaw = process.env.FAKE_SIDECAR_DIE_AFTER
const dieAfter = dieAfterRaw === undefined ? undefined : Number(dieAfterRaw)

let seq = 0
let handled = 0
const decoder = new TextDecoder()
let buffer = ""

function resultFor(method: string): unknown {
  if (method === "ping") return { ok: true, protocol: 1 }
  if (method === "propose_commit") return { seq: ++seq, hash: "fixture", duplicate: false }
  return { ok: true }
}

async function answer(raw: string): Promise<void> {
  const request = JSON.parse(raw) as { id: number; method: string; params: unknown }
  appendFileSync(recordPath, `${request.method}\t${request.id}\t${JSON.stringify(request.params)}\n`)
  await Bun.stdout.write(`${JSON.stringify({ jsonrpc: "2.0", id: request.id, result: resultFor(request.method) })}\n`)
  handled += 1
  if (dieAfter !== undefined && handled >= dieAfter) process.exit(1)
}

const reader = Bun.stdin.stream().getReader()
while (true) {
  const chunk = await reader.read()
  if (chunk.done) break
  buffer += decoder.decode(chunk.value, { stream: true })
  let newline = buffer.indexOf("\n")
  while (newline !== -1) {
    const line = buffer.slice(0, newline)
    buffer = buffer.slice(newline + 1)
    if (line.trim() !== "") await answer(line)
    newline = buffer.indexOf("\n")
  }
}

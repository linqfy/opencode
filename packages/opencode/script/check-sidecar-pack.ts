#!/usr/bin/env bun

import { accessSync, constants } from "node:fs"
import { mkdtemp, rm } from "node:fs/promises"
import { tmpdir } from "node:os"
import path from "node:path"
import { EventsClient } from "@ultracode/events-client"
import pkg from "../package.json"

const distName = `${pkg.name}-${process.platform === "win32" ? "windows" : process.platform}-${process.arch}`
const sidecarBin = path.join("dist", distName, "bin", process.platform === "win32" ? "sidecar.exe" : "sidecar")

if (!(await Bun.file(sidecarBin).exists())) {
  console.error(`FAIL: sidecar not packaged at ${sidecarBin}`)
  process.exit(1)
}
accessSync(sidecarBin, constants.X_OK)

const dir = await mkdtemp(path.join(tmpdir(), "sidecar-pack-check-"))
try {
  const client = EventsClient.start({
    sidecarBin,
    journalDir: path.join(dir, "journal"),
    db: path.join(dir, "events.db"),
    artifacts: path.join(dir, "artifacts"),
    session: "smoke",
  })
  const result = await client.ping()
  client.stop()
  if (!result.ok) {
    console.error(`FAIL: sidecar answered ping with ok=false: ${JSON.stringify(result)}`)
    process.exit(1)
  }
  console.log(`PASS: ${sidecarBin} exists, is executable, and answered ping: ${JSON.stringify(result)}`)
} finally {
  await rm(dir, { recursive: true, force: true })
}

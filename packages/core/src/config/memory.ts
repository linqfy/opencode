export * as ConfigMemory from "./memory"

import { Schema } from "effect"

export class Info extends Schema.Class<Info>("ConfigV2.Memory")({
  enabled: Schema.Boolean.pipe(Schema.optional),
  scope: Schema.Literals(["project", "global"]).pipe(Schema.optional),
}) {}

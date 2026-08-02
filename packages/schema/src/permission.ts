export * as Permission from "./permission"

import { Schema } from "effect"
import { optional } from "./schema"
import { define, inventory } from "./event"
import { ascending } from "./identifier"
import { SessionID } from "./session-id"
import { statics } from "./schema"

export const ID = Schema.String.check(Schema.isStartsWith("per")).pipe(
  Schema.brand("PermissionV2.ID"),
  statics((schema) => ({ create: (id?: string) => schema.make(id ?? "per_" + ascending()) })),
)
export type ID = typeof ID.Type

export const Source = Schema.Union([
  Schema.Struct({
    type: Schema.Literal("tool"),
    messageID: Schema.String,
    callID: Schema.String,
  }),
]).annotate({ identifier: "PermissionV2.Source" })
export type Source = typeof Source.Type

const RequestFields = {
  sessionID: SessionID,
  action: Schema.String,
  resources: Schema.Array(Schema.String),
  save: Schema.Array(Schema.String).pipe(optional),
  metadata: Schema.Record(Schema.String, Schema.Unknown).pipe(optional),
  source: Source.pipe(optional),
}

export const Effect = Schema.Literals(["allow", "deny", "ask"]).annotate({ identifier: "PermissionV2.Effect" })
export type Effect = typeof Effect.Type

export interface Rule extends Schema.Schema.Type<typeof Rule> {}
export const Rule = Schema.Struct({
  action: Schema.String,
  resource: Schema.String,
  effect: Effect,
}).annotate({ identifier: "PermissionV2.Rule" })

export const Ruleset = Schema.Array(Rule).annotate({ identifier: "PermissionV2.Ruleset" })
export type Ruleset = typeof Ruleset.Type

export const Profile = Schema.Struct({
  name: Schema.String,
  version: Schema.String,
  parent: Schema.String.pipe(optional),
  rules: Ruleset,
  sandboxProfile: Schema.String.pipe(optional),
}).annotate({ identifier: "PermissionV2.Profile" })
export interface Profile extends Schema.Schema.Type<typeof Profile> {}

export const GrantScope = Schema.Literals(["once", "session", "project"]).annotate({
  identifier: "PermissionV2.GrantScope",
})
export type GrantScope = typeof GrantScope.Type

export const Grant = Schema.Struct({
  scope: GrantScope,
  action: Schema.String,
  resources: Schema.Array(Schema.String),
  sessionID: SessionID.pipe(optional),
  expiresAt: Schema.Number.pipe(optional),
  idempotencyKey: Schema.String.pipe(optional),
}).annotate({ identifier: "PermissionV2.Grant" })
export interface Grant extends Schema.Schema.Type<typeof Grant> {}

export const Decision = Schema.Struct({
  matchedRule: Rule.pipe(optional),
  profile: Schema.String.pipe(optional),
  profileVersion: Schema.String.pipe(optional),
  requestedAction: Schema.String,
  requestedResources: Schema.Array(Schema.String),
  agent: Schema.String.pipe(optional),
  turn: Schema.String.pipe(optional),
  approvalSource: Schema.Literals(["policy", "grant", "user"]),
  sandboxProfile: Schema.String.pipe(optional),
  grantScope: GrantScope.pipe(optional),
  expiresAt: Schema.Number.pipe(optional),
  idempotencyKey: Schema.String.pipe(optional),
}).annotate({ identifier: "PermissionV2.Decision" })
export interface Decision extends Schema.Schema.Type<typeof Decision> {}

export const Request = Schema.Struct({
  id: ID,
  ...RequestFields,
  decision: Decision.pipe(optional),
}).annotate({ identifier: "PermissionV2.Request" })
export interface Request extends Schema.Schema.Type<typeof Request> {}

export const Reply = Schema.Literals(["once", "session", "project", "always", "reject"]).annotate({
  identifier: "PermissionV2.Reply",
})
export type Reply = typeof Reply.Type

const Asked = define({ type: "permission.v2.asked", schema: Request.fields })
const Replied = define({
  type: "permission.v2.replied",
  schema: {
    sessionID: SessionID,
    requestID: ID,
    reply: Reply,
    decision: Decision,
    grant: Grant.pipe(optional),
  },
})
export const Event = { Asked, Replied, Definitions: inventory(Asked, Replied) }

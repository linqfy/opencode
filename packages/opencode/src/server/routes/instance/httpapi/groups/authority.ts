import { SchedulerService } from "@/agent/scheduler-service"
import { Schema } from "effect"
import { HttpApi, HttpApiEndpoint, HttpApiGroup, OpenApi } from "effect/unstable/httpapi"
import { InstanceContextMiddleware } from "../middleware/instance-context"
import { WorkspaceRoutingMiddleware, WorkspaceRoutingQuery } from "../middleware/workspace-routing"
import { Authorization } from "../middleware/authorization"

export const AuthorityPageQuery = Schema.Struct({
  ...WorkspaceRoutingQuery.fields,
  rootId: Schema.optional(Schema.String),
  sessionId: Schema.optional(Schema.String),
  projectId: Schema.optional(Schema.String),
  artifactId: Schema.optional(Schema.String),
  scope: Schema.optional(Schema.String),
  cursor: Schema.optional(Schema.String),
  sinceSeq: Schema.optional(Schema.NumberFromString),
  start: Schema.optional(Schema.NumberFromString),
  end: Schema.optional(Schema.NumberFromString),
  limit: Schema.optional(Schema.NumberFromString),
})

export const AuthorityCancelPayload = Schema.Struct({
  taskId: Schema.String,
  reason: Schema.String,
  idempotencyKey: Schema.String,
})

const root = "/experimental/authority"
export const AuthorityApi = HttpApi.make("authority").add(
  HttpApiGroup.make("authority")
    .add(
      HttpApiEndpoint.get("taskGraph", `${root}/tasks`, {
        query: AuthorityPageQuery,
        success: Schema.Unknown,
      }),
      HttpApiEndpoint.post("cancelTask", `${root}/tasks/:rootId/cancel`, {
        params: { rootId: Schema.String },
        query: WorkspaceRoutingQuery,
        payload: AuthorityCancelPayload,
        success: Schema.Unknown,
      }),
      HttpApiEndpoint.get("approvals", `${root}/approvals`, { query: AuthorityPageQuery, success: Schema.Unknown }),
      HttpApiEndpoint.get("replay", `${root}/sessions/:sessionId/replay`, {
        params: { sessionId: Schema.String },
        query: AuthorityPageQuery,
        success: Schema.Unknown,
      }),
      HttpApiEndpoint.get("context", `${root}/sessions/:sessionId/context`, {
        params: { sessionId: Schema.String },
        query: AuthorityPageQuery,
        success: Schema.Unknown,
      }),
      HttpApiEndpoint.get("artifact", `${root}/artifacts/:artifactId`, {
        params: { artifactId: Schema.String },
        query: AuthorityPageQuery,
        success: Schema.Unknown,
      }),
      HttpApiEndpoint.get("artifactRange", `${root}/artifacts/:artifactId/range`, {
        params: { artifactId: Schema.String },
        query: AuthorityPageQuery,
        success: Schema.Unknown,
      }),
      HttpApiEndpoint.get("providers", `${root}/providers`, { query: AuthorityPageQuery, success: Schema.Unknown }),
      HttpApiEndpoint.get("plugins", `${root}/plugins`, { query: AuthorityPageQuery, success: Schema.Unknown }),
    )
    .middleware(InstanceContextMiddleware)
    .middleware(WorkspaceRoutingMiddleware)
    .middleware(Authorization)
    .annotateMerge(OpenApi.annotations({ title: "authority", description: "Bounded sidecar-backed Stage 7 supervision reads." })),
)

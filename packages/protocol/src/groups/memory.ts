import { Schema } from "effect"
import { HttpApiEndpoint, HttpApiGroup, HttpApiSchema, OpenApi } from "effect/unstable/httpapi"
import { MemoryDisabledError, MemoryNotFoundError } from "../errors"
import { LocationQuery, locationQueryOpenApi } from "./location"

export const MemoryInfo = Schema.Struct({
  thread_id: Schema.String,
  source_session: Schema.String,
  source_turn: Schema.Number,
  source_end_seq: Schema.Number,
  transcript_artifact_id: Schema.String,
  extractor_version: Schema.String,
  source_updated_at: Schema.Number,
  raw_memory: Schema.String,
  rollout_summary: Schema.String,
  rollout_slug: Schema.NullOr(Schema.String),
  cwd: Schema.String,
  git_branch: Schema.NullOr(Schema.String),
  generated_at: Schema.Number,
  usage_count: Schema.Number,
  last_usage: Schema.NullOr(Schema.Number),
  deleted_at: Schema.NullOr(Schema.Number),
  edited_by: Schema.NullOr(Schema.String),
  edited_at: Schema.NullOr(Schema.Number),
}).annotate({ identifier: "Memory.Info" })

export const MemoryPage = Schema.Struct({
  items: Schema.Array(MemoryInfo),
  next_cursor: Schema.NullOr(Schema.String),
}).annotate({ identifier: "Memory.Page" })

// Cursor discipline: the initial query carries the page size (and location);
// a continuation page carries only the opaque cursor.
export const MemoryListQuery = Schema.Struct({
  ...LocationQuery.fields,
  limit: Schema.optional(Schema.NumberFromString),
  cursor: Schema.optional(Schema.String),
}).annotate({ identifier: "MemoryListQuery" })

export const MemoryPatchPayload = Schema.Struct({
  raw_memory: Schema.optional(Schema.String),
  rollout_summary: Schema.optional(Schema.String),
  rollout_slug: Schema.optional(Schema.String),
}).annotate({ identifier: "MemoryPatchPayload" })

export const MemoryGroup = HttpApiGroup.make("server.memory")
  .add(
    HttpApiEndpoint.get("memory.list", "/api/memory", {
      query: MemoryListQuery,
      success: MemoryPage,
      error: MemoryDisabledError,
    })
      .annotateMerge(locationQueryOpenApi)
      .annotateMerge(
        OpenApi.annotations({
          identifier: "v2.memory.list",
          summary: "List memory records",
          description: "Page over the durable memory records available to this location.",
        }),
      ),
  )
  .add(
    HttpApiEndpoint.get("memory.get", "/api/memory/:threadID", {
      params: { threadID: Schema.String },
      query: LocationQuery,
      success: MemoryInfo,
      error: [MemoryNotFoundError, MemoryDisabledError],
    })
      .annotateMerge(locationQueryOpenApi)
      .annotateMerge(
        OpenApi.annotations({
          identifier: "v2.memory.get",
          summary: "Get a memory record",
          description: "Retrieve a single durable memory record by thread id.",
        }),
      ),
  )
  .add(
    HttpApiEndpoint.patch("memory.patch", "/api/memory/:threadID", {
      params: { threadID: Schema.String },
      query: LocationQuery,
      payload: MemoryPatchPayload,
      success: HttpApiSchema.NoContent,
      error: [MemoryNotFoundError, MemoryDisabledError],
    })
      .annotateMerge(locationQueryOpenApi)
      .annotateMerge(
        OpenApi.annotations({
          identifier: "v2.memory.patch",
          summary: "Patch a memory record",
          description: "Edit memory content fields, recording user provenance.",
        }),
      ),
  )
  .add(
    HttpApiEndpoint.delete("memory.delete", "/api/memory/:threadID", {
      params: { threadID: Schema.String },
      query: LocationQuery,
      success: HttpApiSchema.NoContent,
      error: [MemoryNotFoundError, MemoryDisabledError],
    })
      .annotateMerge(locationQueryOpenApi)
      .annotateMerge(
        OpenApi.annotations({
          identifier: "v2.memory.delete",
          summary: "Delete a memory record",
          description: "Remove a durable memory record from future pages.",
        }),
      ),
  )
  .annotateMerge(
    OpenApi.annotations({
      title: "memory",
      description: "Durable memory review routes.",
    }),
  )

import { sqliteTable, text, integer, real, index } from "drizzle-orm/sqlite-core"
import { SessionTable } from "../session/sql"
import type { SessionMessage } from "../session/message"
import type { SessionSchema } from "../session/schema"

export const StepUsageTable = sqliteTable(
  "step_usage",
  {
    id: integer().primaryKey({ autoIncrement: true }),
    session_id: text()
      .$type<SessionSchema.ID>()
      .notNull()
      .references(() => SessionTable.id, { onDelete: "cascade" }),
    assistant_message_id: text().$type<SessionMessage.ID>().notNull(),
    provider_id: text().notNull(),
    model_id: text().notNull(),
    profile_id: text().notNull(),
    input_tokens: integer().notNull(),
    output_tokens: integer().notNull(),
    reasoning_tokens: integer().notNull(),
    cache_read_tokens: integer().notNull(),
    cache_write_tokens: integer().notNull(),
    cache_hit_rate: real().notNull(),
    time_created: integer()
      .notNull()
      .$default(() => Date.now()),
  },
  (table) => [index("step_usage_session_idx").on(table.session_id)],
)

import { Effect } from "effect"
import type { DatabaseMigration } from "../migration"

export default {
  id: "20260808171854_add_step_usage",
  up(tx) {
    return Effect.gen(function* () {
      yield* tx.run(`
        CREATE TABLE \`step_usage\` (
          \`id\` integer PRIMARY KEY AUTOINCREMENT,
          \`session_id\` text NOT NULL,
          \`assistant_message_id\` text NOT NULL,
          \`provider_id\` text NOT NULL,
          \`model_id\` text NOT NULL,
          \`profile_id\` text NOT NULL,
          \`input_tokens\` integer NOT NULL,
          \`output_tokens\` integer NOT NULL,
          \`reasoning_tokens\` integer NOT NULL,
          \`cache_read_tokens\` integer NOT NULL,
          \`cache_write_tokens\` integer NOT NULL,
          \`cache_hit_rate\` real NOT NULL,
          \`time_created\` integer NOT NULL,
          CONSTRAINT \`fk_step_usage_session_id_session_id_fk\` FOREIGN KEY (\`session_id\`) REFERENCES \`session\`(\`id\`) ON DELETE CASCADE
        );
      `)
      yield* tx.run(`CREATE INDEX \`step_usage_session_idx\` ON \`step_usage\` (\`session_id\`);`)
    })
  },
} satisfies DatabaseMigration.Migration

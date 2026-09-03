import { index, mysqlTable, uniqueIndex, varchar } from "drizzle-orm/mysql-core";
import { shots } from "./shots.js";
import { characters } from "./characters.js";
import { createdAtColumn, idColumn } from "./helpers.js";

export const shotCharacters = mysqlTable(
  "shot_characters",
  {
    id: idColumn(),
    shotId: varchar("shot_id", { length: 36 })
      .notNull()
      .references(() => shots.id, { onDelete: "cascade" }),
    characterId: varchar("character_id", { length: 36 })
      .notNull()
      .references(() => characters.id, { onDelete: "cascade" }),
    createdAt: createdAtColumn(),
  },
  (table) => [
    uniqueIndex("shot_characters_pair_unique").on(
      table.shotId,
      table.characterId,
    ),
    index("shot_characters_shot_id_idx").on(table.shotId),
    index("shot_characters_character_id_idx").on(table.characterId),
  ],
);
import { index, int, json, mysqlTable, text, varchar } from "drizzle-orm/mysql-core";
import { projects } from "./projects.js";
import { episodes } from "./episodes.js";
import { createdAtColumn, idColumn, updatedAtColumn } from "./helpers.js";

/**
 * ProductionPlan (C7.1 — AI Production Director foundation).
 *
 * One row per AI-assisted production run for a project: the user's
 * high-level request goes in, a structured plan is built up, reviewed and
 * approved. It orchestrates the existing domain entities (episodes, scenes,
 * shots, generation jobs) by reference — it never duplicates them. The
 * nullable `episode_id` FK uses ON DELETE SET NULL so an episode deletion
 * only unanchors the plan, it never destroys the plan or its history.
 */
export const productionPlans = mysqlTable(
  "production_plans",
  {
    id: idColumn(),
    projectId: varchar("project_id", { length: 36 })
      .notNull()
      .references(() => projects.id, { onDelete: "cascade" }),
    episodeId: varchar("episode_id", { length: 36 }).references(() => episodes.id, {
      onDelete: "set null",
    }),
    /** The user's verbatim request that started the run. */
    request: text("request").notNull(),
    /** Lifecycle state (see PRODUCTION_PLAN_STATUSES). */
    status: varchar("status", { length: 50 }).notNull().default("planning"),
    /** Structured plan payload, editable while the run is in progress. */
    plan: json("plan"),
    /** Target duration in seconds the user asked for, when known. */
    targetDurationSeconds: int("target_duration_seconds"),
    /** Free-form user preferences captured at creation time. */
    preferences: json("preferences"),
    createdAt: createdAtColumn(),
    updatedAt: updatedAtColumn(),
  },
  (table) => [
    index("production_plans_project_id_idx").on(table.projectId),
    index("production_plans_status_idx").on(table.status),
  ],
);

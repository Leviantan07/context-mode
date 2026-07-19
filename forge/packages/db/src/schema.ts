/**
 * Postgres schema — the durable copy of every metric this system captures.
 * Mirrors docs/ARCHITECTURE.md → Data model exactly; keep them in sync.
 */
import {
  pgTable,
  uuid,
  text,
  integer,
  doublePrecision,
  timestamp,
  jsonb,
  boolean,
} from "drizzle-orm/pg-core";
import { relations } from "drizzle-orm";

export const projects = pgTable("projects", {
  id: uuid("id").primaryKey().defaultRandom(),
  name: text("name").notNull(),
  repoUrl: text("repo_url").notNull(),
  defaultBranch: text("default_branch").notNull().default("main"),
  createdAt: timestamp("created_at", { withTimezone: true }).notNull().defaultNow(),
});

export const tasks = pgTable("tasks", {
  id: uuid("id").primaryKey().defaultRandom(),
  userId: text("user_id").notNull(),
  projectId: uuid("project_id").references(() => projects.id),
  prompt: text("prompt").notNull(),
  status: text("status").notNull().default("CREATED"),
  progress: integer("progress").notNull().default(0),
  // Pre-run estimate (see @forge/shared estimateTask) — the "estimé" the
  // dashboard compares against actual consumption.
  estimatedInputTokens: integer("estimated_input_tokens").notNull().default(0),
  estimatedOutputTokens: integer("estimated_output_tokens").notNull().default(0),
  createdAt: timestamp("created_at", { withTimezone: true }).notNull().defaultNow(),
  updatedAt: timestamp("updated_at", { withTimezone: true }).notNull().defaultNow(),
  startedAt: timestamp("started_at", { withTimezone: true }),
  completedAt: timestamp("completed_at", { withTimezone: true }),
  durationMs: integer("duration_ms"),
  result: text("result"),
  errorMessage: text("error_message"),
});

export const runs = pgTable("runs", {
  id: uuid("id").primaryKey().defaultRandom(),
  taskId: uuid("task_id").notNull().references(() => tasks.id),
  attemptNumber: integer("attempt_number").notNull().default(1),
  status: text("status").notNull().default("CREATED"),
  claudeSessionId: text("claude_session_id"),
  langsmithRunId: text("langsmith_run_id"),
  langsmithTraceUrl: text("langsmith_trace_url"),
  startedAt: timestamp("started_at", { withTimezone: true }).notNull().defaultNow(),
  completedAt: timestamp("completed_at", { withTimezone: true }),
  durationMs: integer("duration_ms"),
  errorMessage: text("error_message"),
});

export const modelUsage = pgTable("model_usage", {
  id: uuid("id").primaryKey().defaultRandom(),
  runId: uuid("run_id").notNull().references(() => runs.id),
  model: text("model").notNull(),
  inputTokens: integer("input_tokens").notNull().default(0),
  outputTokens: integer("output_tokens").notNull().default(0),
  cacheCreationInputTokens: integer("cache_creation_input_tokens").notNull().default(0),
  cacheReadInputTokens: integer("cache_read_input_tokens").notNull().default(0),
  durationMs: integer("duration_ms"),
  costUsd: doublePrecision("cost_usd"),
  createdAt: timestamp("created_at", { withTimezone: true }).notNull().defaultNow(),
});

export const toolUsage = pgTable("tool_usage", {
  id: uuid("id").primaryKey().defaultRandom(),
  runId: uuid("run_id").notNull().references(() => runs.id),
  toolName: text("tool_name").notNull(),
  input: jsonb("input"),
  output: jsonb("output"),
  startedAt: timestamp("started_at", { withTimezone: true }).notNull().defaultNow(),
  durationMs: integer("duration_ms"),
  success: boolean("success").notNull().default(true),
  errorMessage: text("error_message"),
});

export const errors = pgTable("errors", {
  id: uuid("id").primaryKey().defaultRandom(),
  runId: uuid("run_id").references(() => runs.id),
  taskId: uuid("task_id").notNull().references(() => tasks.id),
  message: text("message").notNull(),
  stack: text("stack"),
  occurredAt: timestamp("occurred_at", { withTimezone: true }).notNull().defaultNow(),
});

export const projectsRelations = relations(projects, ({ many }) => ({
  tasks: many(tasks),
}));

export const tasksRelations = relations(tasks, ({ one, many }) => ({
  project: one(projects, { fields: [tasks.projectId], references: [projects.id] }),
  runs: many(runs),
  errors: many(errors),
}));

export const runsRelations = relations(runs, ({ one, many }) => ({
  task: one(tasks, { fields: [runs.taskId], references: [tasks.id] }),
  modelUsage: many(modelUsage),
  toolUsage: many(toolUsage),
  errors: many(errors),
}));

export const modelUsageRelations = relations(modelUsage, ({ one }) => ({
  run: one(runs, { fields: [modelUsage.runId], references: [runs.id] }),
}));

export const toolUsageRelations = relations(toolUsage, ({ one }) => ({
  run: one(runs, { fields: [toolUsage.runId], references: [runs.id] }),
}));

export const errorsRelations = relations(errors, ({ one }) => ({
  run: one(runs, { fields: [errors.runId], references: [runs.id] }),
  task: one(tasks, { fields: [errors.taskId], references: [tasks.id] }),
}));

ALTER TABLE "tasks" ADD COLUMN "estimated_input_tokens" integer DEFAULT 0 NOT NULL;--> statement-breakpoint
ALTER TABLE "tasks" ADD COLUMN "estimated_output_tokens" integer DEFAULT 0 NOT NULL;
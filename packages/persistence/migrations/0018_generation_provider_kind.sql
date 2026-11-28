-- Hand-written: rebuilds `generation` so its stored CHECK on `provider_kind` matches the schema
-- (`ollama`, `openai`, `venice`; 0013 stored only `ollama`, `venice`). The snapshot in meta/ already held the new
-- CHECK, so `drizzle-kit generate` never emitted it; 0018_snapshot.json is the 0017 snapshot with a new id.
-- SQLite's table-rebuild procedure asks for `PRAGMA foreign_keys=OFF`, but Drizzle runs all migrations inside one
-- transaction, where that pragma is a no-op (see 0001). With foreign keys on, `DROP TABLE generation` would run an
-- implicit DELETE whose ON DELETE CASCADE empties `generation_input` and `generation_output`. So both child tables
-- are parked in plain copies first, dropped, and recreated with their original definition after the rename; every
-- row is copied back, and every insert is checked against the foreign keys as it happens.
CREATE TABLE `__new_generation` (
	`id` text PRIMARY KEY NOT NULL,
	`kind` text NOT NULL,
	`status` text NOT NULL,
	`error_code` text,
	`provider_id` text NOT NULL,
	`provider_name` text NOT NULL,
	`provider_kind` text NOT NULL,
	`model` text,
	`prompt` text,
	`parameters` text NOT NULL,
	`job_id` text,
	`created_at` text NOT NULL,
	`finished_at` text,
	`prompt_version_id` text,
	`prompt_title` text,
	`prompt_version_number` integer,
	`prompt_variables` text,
	FOREIGN KEY (`prompt_version_id`) REFERENCES `prompt_version`(`id`) ON UPDATE no action ON DELETE set null,
	CONSTRAINT "generation_kind_check" CHECK("__new_generation"."kind" in ('edit', 'upscale')),
	CONSTRAINT "generation_status_check" CHECK("__new_generation"."status" in ('pending', 'succeeded', 'failed', 'cancelled')),
	CONSTRAINT "generation_provider_kind_check" CHECK("__new_generation"."provider_kind" in ('ollama', 'openai', 'venice'))
);
--> statement-breakpoint
INSERT INTO `__new_generation`("id", "kind", "status", "error_code", "provider_id", "provider_name", "provider_kind", "model", "prompt", "parameters", "job_id", "created_at", "finished_at", "prompt_version_id", "prompt_title", "prompt_version_number", "prompt_variables") SELECT "id", "kind", "status", "error_code", "provider_id", "provider_name", "provider_kind", "model", "prompt", "parameters", "job_id", "created_at", "finished_at", "prompt_version_id", "prompt_title", "prompt_version_number", "prompt_variables" FROM `generation`;--> statement-breakpoint
CREATE TABLE `__park_generation_input` AS SELECT "generation_id", "position", "file_id", "sha256", "original_name" FROM `generation_input`;--> statement-breakpoint
CREATE TABLE `__park_generation_output` AS SELECT "generation_id", "position", "file_id", "sha256", "original_name" FROM `generation_output`;--> statement-breakpoint
DROP TABLE `generation_input`;--> statement-breakpoint
DROP TABLE `generation_output`;--> statement-breakpoint
DROP TABLE `generation`;--> statement-breakpoint
ALTER TABLE `__new_generation` RENAME TO `generation`;--> statement-breakpoint
CREATE INDEX `generation_job_id_idx` ON `generation` (`job_id`);--> statement-breakpoint
CREATE INDEX `generation_created_at_idx` ON `generation` (`created_at`,`id`);--> statement-breakpoint
CREATE INDEX `generation_prompt_version_id_idx` ON `generation` (`prompt_version_id`);--> statement-breakpoint
CREATE TABLE `generation_input` (
	`generation_id` text NOT NULL,
	`position` integer NOT NULL,
	`file_id` text,
	`sha256` text NOT NULL,
	`original_name` text NOT NULL,
	PRIMARY KEY(`generation_id`, `position`),
	FOREIGN KEY (`generation_id`) REFERENCES `generation`(`id`) ON UPDATE no action ON DELETE cascade,
	FOREIGN KEY (`file_id`) REFERENCES `file`(`id`) ON UPDATE no action ON DELETE set null
);
--> statement-breakpoint
CREATE INDEX `generation_input_file_id_idx` ON `generation_input` (`file_id`);--> statement-breakpoint
CREATE TABLE `generation_output` (
	`generation_id` text NOT NULL,
	`position` integer NOT NULL,
	`file_id` text,
	`sha256` text NOT NULL,
	`original_name` text NOT NULL,
	PRIMARY KEY(`generation_id`, `position`),
	FOREIGN KEY (`generation_id`) REFERENCES `generation`(`id`) ON UPDATE no action ON DELETE cascade,
	FOREIGN KEY (`file_id`) REFERENCES `file`(`id`) ON UPDATE no action ON DELETE set null
);
--> statement-breakpoint
CREATE INDEX `generation_output_file_id_idx` ON `generation_output` (`file_id`);--> statement-breakpoint
INSERT INTO `generation_input`("generation_id", "position", "file_id", "sha256", "original_name") SELECT "generation_id", "position", "file_id", "sha256", "original_name" FROM `__park_generation_input`;--> statement-breakpoint
INSERT INTO `generation_output`("generation_id", "position", "file_id", "sha256", "original_name") SELECT "generation_id", "position", "file_id", "sha256", "original_name" FROM `__park_generation_output`;--> statement-breakpoint
DROP TABLE `__park_generation_input`;--> statement-breakpoint
DROP TABLE `__park_generation_output`;

CREATE TABLE `generation` (
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
	CONSTRAINT "generation_kind_check" CHECK("generation"."kind" in ('edit', 'upscale')),
	CONSTRAINT "generation_status_check" CHECK("generation"."status" in ('pending', 'succeeded', 'failed', 'cancelled')),
	CONSTRAINT "generation_provider_kind_check" CHECK("generation"."provider_kind" in ('ollama', 'venice'))
);
--> statement-breakpoint
CREATE INDEX `generation_job_id_idx` ON `generation` (`job_id`);--> statement-breakpoint
CREATE INDEX `generation_created_at_idx` ON `generation` (`created_at`,`id`);--> statement-breakpoint
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
CREATE INDEX `generation_output_file_id_idx` ON `generation_output` (`file_id`);
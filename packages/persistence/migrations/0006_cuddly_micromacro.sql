CREATE TABLE `file_analysis` (
	`file_id` text PRIMARY KEY NOT NULL,
	`sha256` text NOT NULL,
	`provider` text NOT NULL,
	`model` text NOT NULL,
	`prompt_version` integer NOT NULL,
	`analysed_at` text NOT NULL,
	FOREIGN KEY (`file_id`) REFERENCES `file`(`id`) ON UPDATE no action ON DELETE no action
);
--> statement-breakpoint
CREATE TABLE `job` (
	`id` text PRIMARY KEY NOT NULL,
	`type` text NOT NULL,
	`resource_class` text NOT NULL,
	`status` text NOT NULL,
	`file_id` text,
	`payload` text NOT NULL,
	`dedupe_key` text,
	`attempt` integer DEFAULT 0 NOT NULL,
	`run_after` text,
	`error_code` text,
	`error_message` text,
	`created_at` text NOT NULL,
	`started_at` text,
	`finished_at` text,
	`updated_at` text NOT NULL,
	FOREIGN KEY (`file_id`) REFERENCES `file`(`id`) ON UPDATE no action ON DELETE no action,
	CONSTRAINT "job_resource_class_check" CHECK("job"."resource_class" in ('cpu', 'io', 'local_gpu', 'remote_api')),
	CONSTRAINT "job_status_check" CHECK("job"."status" in ('queued', 'running', 'waiting_remote', 'succeeded', 'failed', 'cancelled', 'retry_wait'))
);
--> statement-breakpoint
CREATE INDEX `job_claim_idx` ON `job` (`status`,`resource_class`,`created_at`,`id`);--> statement-breakpoint
CREATE UNIQUE INDEX `job_active_dedupe_idx` ON `job` (`dedupe_key`) WHERE "job"."status" in ('queued', 'running', 'waiting_remote', 'retry_wait');
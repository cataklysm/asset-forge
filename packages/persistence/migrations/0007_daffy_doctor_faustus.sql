CREATE TABLE `file_analysis_proposal` (
	`file_id` text PRIMARY KEY NOT NULL,
	`sha256` text NOT NULL,
	`provider` text NOT NULL,
	`model` text NOT NULL,
	`prompt_version` integer NOT NULL,
	`tags` text NOT NULL,
	`created_at` text NOT NULL,
	FOREIGN KEY (`file_id`) REFERENCES `file`(`id`) ON UPDATE no action ON DELETE no action
);
--> statement-breakpoint
CREATE INDEX `job_file_id_type_created_at_idx` ON `job` (`file_id`,`type`,`created_at`,`id`);
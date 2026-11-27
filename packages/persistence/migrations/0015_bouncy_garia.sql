CREATE TABLE `file_origin` (
	`id` text PRIMARY KEY NOT NULL,
	`file_id` text NOT NULL,
	`url` text NOT NULL,
	`created_at` text NOT NULL,
	FOREIGN KEY (`file_id`) REFERENCES `file`(`id`) ON UPDATE no action ON DELETE cascade
);
--> statement-breakpoint
CREATE UNIQUE INDEX `file_origin_file_id_url_unique` ON `file_origin` (`file_id`,`url`);--> statement-breakpoint
CREATE INDEX `file_origin_url_idx` ON `file_origin` (`url`);--> statement-breakpoint
ALTER TABLE `job` ADD `result` text;
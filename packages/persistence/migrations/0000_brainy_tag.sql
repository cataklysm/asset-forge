CREATE TABLE `file` (
	`id` text PRIMARY KEY NOT NULL,
	`asset_id` text,
	`original_name` text NOT NULL,
	`relative_path` text NOT NULL,
	`mime_type` text NOT NULL,
	`size_bytes` integer,
	`sha256` text,
	`status` text NOT NULL,
	`error` text,
	`imported_at` text NOT NULL,
	CONSTRAINT "file_status_check" CHECK("file"."status" in ('pending', 'complete', 'failed'))
);
--> statement-breakpoint
CREATE UNIQUE INDEX `file_relative_path_unique` ON `file` (`relative_path`);--> statement-breakpoint
CREATE INDEX `file_sha256_idx` ON `file` (`sha256`);--> statement-breakpoint
CREATE INDEX `file_status_idx` ON `file` (`status`);--> statement-breakpoint
CREATE INDEX `file_imported_at_idx` ON `file` (`imported_at`);--> statement-breakpoint
CREATE INDEX `file_asset_id_idx` ON `file` (`asset_id`);--> statement-breakpoint
CREATE TABLE `workspace` (
	`id` text PRIMARY KEY NOT NULL,
	`format_version` integer NOT NULL,
	`name` text NOT NULL,
	`created_at` text NOT NULL
);

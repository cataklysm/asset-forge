ALTER TABLE `file` ADD `deleted_at` text;--> statement-breakpoint
ALTER TABLE `file` ADD `trashed_asset_id` text REFERENCES asset(id) ON DELETE SET NULL;--> statement-breakpoint
ALTER TABLE `file` ADD `trashed_role` text;--> statement-breakpoint
CREATE INDEX `file_deleted_at_idx` ON `file` (`deleted_at`);--> statement-breakpoint
ALTER TABLE `file_move` ADD `kind` text DEFAULT 'relocate' NOT NULL;
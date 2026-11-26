CREATE TABLE `asset_source` (
	`id` text PRIMARY KEY NOT NULL,
	`asset_id` text NOT NULL,
	`url` text NOT NULL,
	`created_at` text NOT NULL,
	FOREIGN KEY (`asset_id`) REFERENCES `asset`(`id`) ON UPDATE no action ON DELETE no action
);
--> statement-breakpoint
CREATE UNIQUE INDEX `asset_source_asset_id_url_unique` ON `asset_source` (`asset_id`,`url`);
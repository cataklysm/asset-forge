CREATE TABLE `asset_search_map` (
	`rowid` integer PRIMARY KEY NOT NULL,
	`asset_id` text NOT NULL,
	FOREIGN KEY (`asset_id`) REFERENCES `asset`(`id`) ON UPDATE no action ON DELETE no action
);
--> statement-breakpoint
CREATE UNIQUE INDEX `asset_search_map_asset_id_unique` ON `asset_search_map` (`asset_id`);--> statement-breakpoint
CREATE TABLE `asset_tag` (
	`asset_id` text NOT NULL,
	`tag_id` text NOT NULL,
	`origin` text NOT NULL,
	`created_at` text NOT NULL,
	PRIMARY KEY(`asset_id`, `tag_id`, `origin`),
	FOREIGN KEY (`asset_id`) REFERENCES `asset`(`id`) ON UPDATE no action ON DELETE no action,
	FOREIGN KEY (`tag_id`) REFERENCES `tag`(`id`) ON UPDATE no action ON DELETE no action,
	CONSTRAINT "asset_tag_origin_check" CHECK("asset_tag"."origin" in ('manual', 'ai'))
);
--> statement-breakpoint
CREATE INDEX `asset_tag_tag_id_idx` ON `asset_tag` (`tag_id`);--> statement-breakpoint
CREATE TABLE `file_tag` (
	`file_id` text NOT NULL,
	`tag_id` text NOT NULL,
	`origin` text NOT NULL,
	`created_at` text NOT NULL,
	PRIMARY KEY(`file_id`, `tag_id`, `origin`),
	FOREIGN KEY (`file_id`) REFERENCES `file`(`id`) ON UPDATE no action ON DELETE no action,
	FOREIGN KEY (`tag_id`) REFERENCES `tag`(`id`) ON UPDATE no action ON DELETE no action,
	CONSTRAINT "file_tag_origin_check" CHECK("file_tag"."origin" in ('manual', 'ai'))
);
--> statement-breakpoint
CREATE INDEX `file_tag_tag_id_idx` ON `file_tag` (`tag_id`);--> statement-breakpoint
CREATE TABLE `tag` (
	`id` text PRIMARY KEY NOT NULL,
	`name` text NOT NULL,
	`display_name` text NOT NULL,
	`created_at` text NOT NULL
);
--> statement-breakpoint
CREATE UNIQUE INDEX `tag_name_unique` ON `tag` (`name`);--> statement-breakpoint
ALTER TABLE `file` ADD `kind` text DEFAULT 'other' NOT NULL;--> statement-breakpoint
CREATE INDEX `file_asset_id_kind_idx` ON `file` (`asset_id`,`kind`);--> statement-breakpoint
ALTER TABLE `workspace` ADD `derived_data_version` integer;
--> statement-breakpoint
CREATE VIRTUAL TABLE `asset_search` USING fts5(name, description, tags, file_names, tokenize = 'unicode61 remove_diacritics 2', prefix = '2 3');

CREATE TABLE `site_crawl` (
	`id` text PRIMARY KEY NOT NULL,
	`profile_id` text NOT NULL,
	`profile` text NOT NULL,
	`gallery_url` text NOT NULL,
	`target` text,
	`target_asset_name` text,
	`progress` text NOT NULL,
	`checkpoint` text,
	`result` text,
	`imported_at` text,
	`created_at` text NOT NULL,
	`updated_at` text NOT NULL,
	CONSTRAINT "site_crawl_profile_json_check" CHECK(json_valid("site_crawl"."profile")),
	CONSTRAINT "site_crawl_progress_json_check" CHECK(json_valid("site_crawl"."progress")),
	CONSTRAINT "site_crawl_target_json_check" CHECK("site_crawl"."target" IS NULL OR json_valid("site_crawl"."target")),
	CONSTRAINT "site_crawl_checkpoint_json_check" CHECK("site_crawl"."checkpoint" IS NULL OR json_valid("site_crawl"."checkpoint")),
	CONSTRAINT "site_crawl_result_json_check" CHECK("site_crawl"."result" IS NULL OR json_valid("site_crawl"."result"))
);
--> statement-breakpoint
CREATE INDEX `site_crawl_created_at_idx` ON `site_crawl` (`created_at`,`id`);--> statement-breakpoint
CREATE INDEX `site_crawl_profile_id_idx` ON `site_crawl` (`profile_id`);
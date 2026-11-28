CREATE INDEX `asset_name_lower_id_idx` ON `asset` (lower("name"),`id`);--> statement-breakpoint
CREATE INDEX `asset_cover_file_id_idx` ON `asset` (`cover_file_id`);--> statement-breakpoint
CREATE INDEX `file_asset_id_imported_at_id_idx` ON `file` (`asset_id`,`imported_at`,`id`);--> statement-breakpoint
CREATE INDEX `generation_prompt_version_id_idx` ON `generation` (`prompt_version_id`);
-- Hand-edited after `drizzle-kit generate`: the generated statements were reordered and the
-- primary storage insert was added, so that an existing phase 1 database is upgraded in place.
-- Order: storage table -> primary storage row (only when the database already holds data) ->
-- asset management tables -> rebuild of `file` with every row backfilled to the primary
-- storage -> file_move (created after the rebuild, so nothing references `file` while it is
-- dropped). The generated `PRAGMA foreign_keys=OFF/ON` lines were removed: Drizzle runs all
-- migrations inside one transaction, where that pragma is a no-op, and the rebuild does not
-- need foreign keys disabled. The snapshot in meta/ is unchanged.
CREATE TABLE `storage` (
	`id` text PRIMARY KEY NOT NULL,
	`kind` text NOT NULL,
	`created_at` text NOT NULL,
	CONSTRAINT "storage_kind_check" CHECK("storage"."kind" in ('workspace_root'))
);
--> statement-breakpoint
-- The primary storage of an existing workspace. The id is a random UUID v4 (version nibble 4,
-- variant nibble 8, 9, a or b); `random() & 3` stays in 0..3 for negative values as well.
INSERT INTO `storage` (`id`, `kind`, `created_at`)
SELECT
	lower(hex(randomblob(4))) || '-' ||
	lower(hex(randomblob(2))) || '-' ||
	'4' || substr(lower(hex(randomblob(2))), 2) || '-' ||
	substr('89ab', (random() & 3) + 1, 1) || substr(lower(hex(randomblob(2))), 2) || '-' ||
	lower(hex(randomblob(6))),
	'workspace_root',
	coalesce(
		(SELECT `created_at` FROM `workspace` LIMIT 1),
		strftime('%Y-%m-%dT%H:%M:%fZ', 'now')
	)
WHERE EXISTS (SELECT 1 FROM `workspace`) OR EXISTS (SELECT 1 FROM `file`);
--> statement-breakpoint
CREATE TABLE `asset_type` (
	`id` text PRIMARY KEY NOT NULL,
	`key` text NOT NULL,
	`name` text NOT NULL,
	`sort_order` integer NOT NULL,
	`built_in` integer NOT NULL
);
--> statement-breakpoint
CREATE UNIQUE INDEX `asset_type_key_unique` ON `asset_type` (`key`);--> statement-breakpoint
CREATE TABLE `asset` (
	`id` text PRIMARY KEY NOT NULL,
	`name` text NOT NULL,
	`type_id` text NOT NULL,
	`description` text DEFAULT '' NOT NULL,
	`status` text NOT NULL,
	`created_at` text NOT NULL,
	`updated_at` text NOT NULL,
	FOREIGN KEY (`type_id`) REFERENCES `asset_type`(`id`) ON UPDATE no action ON DELETE no action,
	CONSTRAINT "asset_status_check" CHECK("asset"."status" in ('draft', 'in_progress', 'in_review', 'completed', 'archived'))
);
--> statement-breakpoint
CREATE INDEX `asset_type_id_idx` ON `asset` (`type_id`);--> statement-breakpoint
CREATE INDEX `asset_status_idx` ON `asset` (`status`);--> statement-breakpoint
CREATE TABLE `project` (
	`id` text PRIMARY KEY NOT NULL,
	`name` text NOT NULL,
	`description` text DEFAULT '' NOT NULL,
	`status` text NOT NULL,
	`created_at` text NOT NULL,
	`updated_at` text NOT NULL,
	CONSTRAINT "project_status_check" CHECK("project"."status" in ('active', 'on_hold', 'completed', 'archived'))
);
--> statement-breakpoint
CREATE TABLE `project_asset` (
	`project_id` text NOT NULL,
	`asset_id` text NOT NULL,
	`priority` text DEFAULT 'normal' NOT NULL,
	`intended_use` text DEFAULT '' NOT NULL,
	`approval_status` text DEFAULT 'pending' NOT NULL,
	`notes` text DEFAULT '' NOT NULL,
	`assigned_at` text NOT NULL,
	`updated_at` text NOT NULL,
	PRIMARY KEY(`project_id`, `asset_id`),
	FOREIGN KEY (`project_id`) REFERENCES `project`(`id`) ON UPDATE no action ON DELETE no action,
	FOREIGN KEY (`asset_id`) REFERENCES `asset`(`id`) ON UPDATE no action ON DELETE no action,
	CONSTRAINT "project_asset_priority_check" CHECK("project_asset"."priority" in ('low', 'normal', 'high')),
	CONSTRAINT "project_asset_approval_status_check" CHECK("project_asset"."approval_status" in ('pending', 'approved', 'rejected'))
);
--> statement-breakpoint
CREATE INDEX `project_asset_asset_id_idx` ON `project_asset` (`asset_id`);--> statement-breakpoint
CREATE TABLE `asset_relation` (
	`from_asset_id` text NOT NULL,
	`to_asset_id` text NOT NULL,
	`kind` text NOT NULL,
	`created_at` text NOT NULL,
	PRIMARY KEY(`from_asset_id`, `to_asset_id`, `kind`),
	FOREIGN KEY (`from_asset_id`) REFERENCES `asset`(`id`) ON UPDATE no action ON DELETE no action,
	FOREIGN KEY (`to_asset_id`) REFERENCES `asset`(`id`) ON UPDATE no action ON DELETE no action,
	CONSTRAINT "asset_relation_kind_check" CHECK("asset_relation"."kind" in ('uses', 'variant_of', 'part_of', 'derived_from')),
	CONSTRAINT "asset_relation_not_self_check" CHECK("asset_relation"."from_asset_id" <> "asset_relation"."to_asset_id")
);
--> statement-breakpoint
CREATE INDEX `asset_relation_to_asset_id_idx` ON `asset_relation` (`to_asset_id`);--> statement-breakpoint
CREATE TABLE `__new_file` (
	`id` text PRIMARY KEY NOT NULL,
	`storage_id` text NOT NULL,
	`asset_id` text,
	`role` text,
	`original_name` text NOT NULL,
	`relative_path` text NOT NULL,
	`mime_type` text NOT NULL,
	`size_bytes` integer,
	`sha256` text,
	`status` text NOT NULL,
	`error` text,
	`imported_at` text NOT NULL,
	FOREIGN KEY (`storage_id`) REFERENCES `storage`(`id`) ON UPDATE no action ON DELETE no action,
	FOREIGN KEY (`asset_id`) REFERENCES `asset`(`id`) ON UPDATE no action ON DELETE no action,
	CONSTRAINT "file_status_check" CHECK("__new_file"."status" in ('pending', 'complete', 'failed')),
	CONSTRAINT "file_role_check" CHECK("__new_file"."role" in ('reference', 'concept', 'generated', 'working', 'model', 'texture', 'final', 'other')),
	CONSTRAINT "file_asset_role_check" CHECK(("__new_file"."asset_id" is null) = ("__new_file"."role" is null))
);
--> statement-breakpoint
-- Phase 1 rows have no asset, so `role` stays NULL; every row joins the primary storage.
INSERT INTO `__new_file`("id", "storage_id", "asset_id", "role", "original_name", "relative_path", "mime_type", "size_bytes", "sha256", "status", "error", "imported_at") SELECT "id", (SELECT `id` FROM `storage` LIMIT 1), "asset_id", NULL, "original_name", "relative_path", "mime_type", "size_bytes", "sha256", "status", "error", "imported_at" FROM `file`;--> statement-breakpoint
DROP TABLE `file`;--> statement-breakpoint
ALTER TABLE `__new_file` RENAME TO `file`;--> statement-breakpoint
CREATE UNIQUE INDEX `file_storage_id_relative_path_unique` ON `file` (`storage_id`,`relative_path`);--> statement-breakpoint
CREATE INDEX `file_sha256_idx` ON `file` (`sha256`);--> statement-breakpoint
CREATE INDEX `file_status_idx` ON `file` (`status`);--> statement-breakpoint
CREATE INDEX `file_imported_at_idx` ON `file` (`imported_at`);--> statement-breakpoint
CREATE INDEX `file_asset_id_role_idx` ON `file` (`asset_id`,`role`);--> statement-breakpoint
CREATE TABLE `file_move` (
	`file_id` text PRIMARY KEY NOT NULL,
	`target_relative_path` text NOT NULL,
	`target_asset_id` text,
	`target_role` text,
	`created_at` text NOT NULL,
	FOREIGN KEY (`file_id`) REFERENCES `file`(`id`) ON UPDATE no action ON DELETE no action,
	FOREIGN KEY (`target_asset_id`) REFERENCES `asset`(`id`) ON UPDATE no action ON DELETE no action,
	CONSTRAINT "file_move_target_role_check" CHECK("file_move"."target_role" in ('reference', 'concept', 'generated', 'working', 'model', 'texture', 'final', 'other')),
	CONSTRAINT "file_move_target_check" CHECK(("file_move"."target_asset_id" is null) = ("file_move"."target_role" is null))
);

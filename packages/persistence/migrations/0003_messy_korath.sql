ALTER TABLE `asset` ADD `cover_file_id` text REFERENCES file(id) ON DELETE set null;
--> statement-breakpoint
UPDATE `file` SET `mime_type` = 'image/avif' WHERE lower(`original_name`) LIKE '%.avif';

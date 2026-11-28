ALTER TABLE `workspace` ADD `lineage_id` text;--> statement-breakpoint
UPDATE `workspace` SET `lineage_id` = lower(hex(randomblob(16))) WHERE `lineage_id` IS NULL;

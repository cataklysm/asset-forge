CREATE TABLE `prompt` (
	`id` text PRIMARY KEY NOT NULL,
	`title` text NOT NULL,
	`title_key` text NOT NULL,
	`description` text DEFAULT '' NOT NULL,
	`created_at` text NOT NULL,
	`updated_at` text NOT NULL
);
--> statement-breakpoint
CREATE UNIQUE INDEX `prompt_title_key_unique` ON `prompt` (`title_key`);--> statement-breakpoint
CREATE TABLE `prompt_tag` (
	`prompt_id` text NOT NULL,
	`tag_id` text NOT NULL,
	`created_at` text NOT NULL,
	PRIMARY KEY(`prompt_id`, `tag_id`),
	FOREIGN KEY (`prompt_id`) REFERENCES `prompt`(`id`) ON UPDATE no action ON DELETE cascade,
	FOREIGN KEY (`tag_id`) REFERENCES `tag`(`id`) ON UPDATE no action ON DELETE no action
);
--> statement-breakpoint
CREATE INDEX `prompt_tag_tag_id_idx` ON `prompt_tag` (`tag_id`);--> statement-breakpoint
CREATE TABLE `prompt_version` (
	`id` text PRIMARY KEY NOT NULL,
	`prompt_id` text NOT NULL,
	`number` integer NOT NULL,
	`content` text NOT NULL,
	`variables` text NOT NULL,
	`created_at` text NOT NULL,
	FOREIGN KEY (`prompt_id`) REFERENCES `prompt`(`id`) ON UPDATE no action ON DELETE cascade
);
--> statement-breakpoint
CREATE UNIQUE INDEX `prompt_version_prompt_id_number_unique` ON `prompt_version` (`prompt_id`,`number`);--> statement-breakpoint
ALTER TABLE `generation` ADD `prompt_version_id` text REFERENCES prompt_version(id) ON UPDATE no action ON DELETE set null;--> statement-breakpoint
ALTER TABLE `generation` ADD `prompt_title` text;--> statement-breakpoint
ALTER TABLE `generation` ADD `prompt_version_number` integer;--> statement-breakpoint
ALTER TABLE `generation` ADD `prompt_variables` text;
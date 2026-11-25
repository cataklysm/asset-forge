CREATE TABLE `asset_workflow` (
	`id` text PRIMARY KEY NOT NULL,
	`asset_id` text NOT NULL,
	`template_version_id` text NOT NULL,
	`created_at` text NOT NULL,
	FOREIGN KEY (`asset_id`) REFERENCES `asset`(`id`) ON UPDATE no action ON DELETE no action,
	FOREIGN KEY (`template_version_id`) REFERENCES `workflow_template_version`(`id`) ON UPDATE no action ON DELETE no action
);
--> statement-breakpoint
CREATE UNIQUE INDEX `asset_workflow_asset_id_unique` ON `asset_workflow` (`asset_id`);--> statement-breakpoint
CREATE TABLE `asset_workflow_step` (
	`id` text PRIMARY KEY NOT NULL,
	`asset_workflow_id` text NOT NULL,
	`step_definition_id` text NOT NULL,
	`state` text DEFAULT 'not_started' NOT NULL,
	`notes` text DEFAULT '' NOT NULL,
	`updated_at` text NOT NULL,
	`completed_at` text,
	FOREIGN KEY (`asset_workflow_id`) REFERENCES `asset_workflow`(`id`) ON UPDATE no action ON DELETE cascade,
	FOREIGN KEY (`step_definition_id`) REFERENCES `workflow_step_definition`(`id`) ON UPDATE no action ON DELETE no action,
	CONSTRAINT "asset_workflow_step_state_check" CHECK("asset_workflow_step"."state" in ('not_started', 'in_progress', 'done', 'skipped')),
	CONSTRAINT "asset_workflow_step_completed_check" CHECK(("asset_workflow_step"."state" = 'done') = ("asset_workflow_step"."completed_at" is not null))
);
--> statement-breakpoint
CREATE UNIQUE INDEX `asset_workflow_step_workflow_definition_unique` ON `asset_workflow_step` (`asset_workflow_id`,`step_definition_id`);--> statement-breakpoint
CREATE TABLE `workflow_step_definition` (
	`id` text PRIMARY KEY NOT NULL,
	`template_version_id` text NOT NULL,
	`position` integer NOT NULL,
	`key` text NOT NULL,
	`name` text NOT NULL,
	`mandatory` integer NOT NULL,
	FOREIGN KEY (`template_version_id`) REFERENCES `workflow_template_version`(`id`) ON UPDATE no action ON DELETE no action
);
--> statement-breakpoint
CREATE UNIQUE INDEX `workflow_step_definition_version_position_unique` ON `workflow_step_definition` (`template_version_id`,`position`);--> statement-breakpoint
CREATE UNIQUE INDEX `workflow_step_definition_version_key_unique` ON `workflow_step_definition` (`template_version_id`,`key`);--> statement-breakpoint
CREATE TABLE `workflow_template` (
	`id` text PRIMARY KEY NOT NULL,
	`key` text NOT NULL,
	`name` text NOT NULL,
	`built_in` integer NOT NULL,
	`created_at` text NOT NULL
);
--> statement-breakpoint
CREATE UNIQUE INDEX `workflow_template_key_unique` ON `workflow_template` (`key`);--> statement-breakpoint
CREATE TABLE `workflow_template_version` (
	`id` text PRIMARY KEY NOT NULL,
	`template_id` text NOT NULL,
	`version` integer NOT NULL,
	`created_at` text NOT NULL,
	FOREIGN KEY (`template_id`) REFERENCES `workflow_template`(`id`) ON UPDATE no action ON DELETE no action
);
--> statement-breakpoint
CREATE UNIQUE INDEX `workflow_template_version_template_id_version_unique` ON `workflow_template_version` (`template_id`,`version`);--> statement-breakpoint
ALTER TABLE `asset_type` ADD `default_workflow_template_id` text REFERENCES workflow_template(id);
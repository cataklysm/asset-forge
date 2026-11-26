ALTER TABLE `job` ADD `provider_id` text;--> statement-breakpoint
CREATE INDEX `job_provider_id_status_idx` ON `job` (`provider_id`,`status`);
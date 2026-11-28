CREATE TABLE `site_crawl_download` (
	`crawl_id` text NOT NULL,
	`url` text NOT NULL,
	`job_id` text,
	`status` text NOT NULL,
	PRIMARY KEY(`crawl_id`, `url`),
	FOREIGN KEY (`crawl_id`) REFERENCES `site_crawl`(`id`) ON UPDATE no action ON DELETE cascade,
	CONSTRAINT "site_crawl_download_status_check" CHECK("site_crawl_download"."status" in ('queued', 'running', 'waiting_remote', 'succeeded', 'failed', 'cancelled', 'retry_wait'))
);
--> statement-breakpoint
CREATE INDEX `site_crawl_download_job_idx` ON `site_crawl_download` (`job_id`);--> statement-breakpoint
CREATE INDEX `site_crawl_download_status_idx` ON `site_crawl_download` (`crawl_id`,`status`);
--> statement-breakpoint
CREATE TRIGGER `site_crawl_download_job_status`
AFTER UPDATE OF status ON job
BEGIN
  UPDATE site_crawl_download SET status = NEW.status WHERE job_id = NEW.id;
END;
--> statement-breakpoint
CREATE TRIGGER `site_crawl_download_job_delete`
AFTER DELETE ON job
BEGIN
  UPDATE site_crawl_download
  SET status = CASE WHEN OLD.status IN ('succeeded', 'failed', 'cancelled') THEN OLD.status ELSE 'cancelled' END
  WHERE job_id = OLD.id;
END;

CREATE TABLE `reminder_log` (
	`key` text PRIMARY KEY NOT NULL,
	`sent_at` integer DEFAULT (unixepoch() * 1000) NOT NULL
);
--> statement-breakpoint
ALTER TABLE `events` ADD `recurrence` text;--> statement-breakpoint
ALTER TABLE `events` ADD `exdates` text;--> statement-breakpoint
ALTER TABLE `events` ADD `recurrence_ends_at` integer;--> statement-breakpoint
ALTER TABLE `events` ADD `series_id` text REFERENCES events(id) ON DELETE cascade;--> statement-breakpoint
ALTER TABLE `events` ADD `original_start_at` integer;--> statement-breakpoint
ALTER TABLE `events` ADD `reminder_minutes` integer;--> statement-breakpoint
CREATE INDEX `events_series_idx` ON `events` (`series_id`);--> statement-breakpoint
ALTER TABLE `telegram_links` ADD `reminders` integer DEFAULT true NOT NULL;
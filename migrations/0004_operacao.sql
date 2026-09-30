CREATE TABLE `app_errors` (
	`id` text PRIMARY KEY NOT NULL,
	`source` text NOT NULL,
	`message` text NOT NULL,
	`request_id` text,
	`created_at` integer DEFAULT (unixepoch() * 1000) NOT NULL
);
--> statement-breakpoint
CREATE INDEX `app_errors_created_idx` ON `app_errors` (`created_at`);--> statement-breakpoint
CREATE TABLE `backup_runs` (
	`id` text PRIMARY KEY NOT NULL,
	`trigger` text NOT NULL,
	`status` text DEFAULT 'running' NOT NULL,
	`object_key` text,
	`size` integer,
	`tables` text,
	`error` text,
	`started_at` integer NOT NULL,
	`finished_at` integer
);
--> statement-breakpoint
CREATE INDEX `backup_runs_started_idx` ON `backup_runs` (`started_at`);
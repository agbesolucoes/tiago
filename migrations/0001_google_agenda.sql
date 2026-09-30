CREATE TABLE `calendars` (
	`id` text PRIMARY KEY NOT NULL,
	`workspace_id` text NOT NULL,
	`account_id` text NOT NULL,
	`google_calendar_id` text NOT NULL,
	`summary` text NOT NULL,
	`primary` integer DEFAULT false NOT NULL,
	`writable` integer DEFAULT false NOT NULL,
	`selected` integer DEFAULT false NOT NULL,
	`sync_token` text,
	`created_at` integer DEFAULT (unixepoch() * 1000) NOT NULL,
	`updated_at` integer DEFAULT (unixepoch() * 1000) NOT NULL,
	FOREIGN KEY (`workspace_id`) REFERENCES `workspaces`(`id`) ON UPDATE no action ON DELETE cascade,
	FOREIGN KEY (`account_id`) REFERENCES `integration_accounts`(`id`) ON UPDATE no action ON DELETE cascade
);
--> statement-breakpoint
CREATE UNIQUE INDEX `calendars_account_gid_idx` ON `calendars` (`account_id`,`google_calendar_id`);--> statement-breakpoint
CREATE TABLE `integration_accounts` (
	`id` text PRIMARY KEY NOT NULL,
	`workspace_id` text NOT NULL,
	`user_id` text NOT NULL,
	`provider` text NOT NULL,
	`external_sub` text NOT NULL,
	`email` text NOT NULL,
	`scopes` text NOT NULL,
	`refresh_token_enc` text NOT NULL,
	`access_token_enc` text,
	`access_token_expires_at` integer,
	`default_calendar_id` text,
	`status` text DEFAULT 'active' NOT NULL,
	`last_error` text,
	`last_sync_at` integer,
	`created_at` integer DEFAULT (unixepoch() * 1000) NOT NULL,
	`updated_at` integer DEFAULT (unixepoch() * 1000) NOT NULL,
	FOREIGN KEY (`workspace_id`) REFERENCES `workspaces`(`id`) ON UPDATE no action ON DELETE cascade,
	FOREIGN KEY (`user_id`) REFERENCES `users`(`id`) ON UPDATE no action ON DELETE cascade
);
--> statement-breakpoint
CREATE UNIQUE INDEX `integration_ws_provider_idx` ON `integration_accounts` (`workspace_id`,`provider`);--> statement-breakpoint
CREATE TABLE `sync_jobs` (
	`id` text PRIMARY KEY NOT NULL,
	`workspace_id` text NOT NULL,
	`kind` text NOT NULL,
	`event_id` text NOT NULL,
	`payload` text,
	`idempotency_key` text NOT NULL,
	`status` text DEFAULT 'pending' NOT NULL,
	`attempts` integer DEFAULT 0 NOT NULL,
	`next_attempt_at` integer NOT NULL,
	`error` text,
	`created_at` integer DEFAULT (unixepoch() * 1000) NOT NULL,
	`updated_at` integer DEFAULT (unixepoch() * 1000) NOT NULL,
	FOREIGN KEY (`workspace_id`) REFERENCES `workspaces`(`id`) ON UPDATE no action ON DELETE cascade
);
--> statement-breakpoint
CREATE UNIQUE INDEX `sync_jobs_idempotencyKey_unique` ON `sync_jobs` (`idempotency_key`);--> statement-breakpoint
CREATE INDEX `sync_jobs_due_idx` ON `sync_jobs` (`status`,`next_attempt_at`);
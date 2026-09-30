CREATE TABLE `attachments` (
	`id` text PRIMARY KEY NOT NULL,
	`workspace_id` text NOT NULL,
	`parent_kind` text NOT NULL,
	`parent_id` text,
	`drive_file_id` text NOT NULL,
	`name` text NOT NULL,
	`mime_type` text,
	`size` integer,
	`web_view_link` text,
	`origin` text NOT NULL,
	`created_by` text,
	`created_at` integer DEFAULT (unixepoch() * 1000) NOT NULL,
	`updated_at` integer DEFAULT (unixepoch() * 1000) NOT NULL,
	FOREIGN KEY (`workspace_id`) REFERENCES `workspaces`(`id`) ON UPDATE no action ON DELETE cascade,
	FOREIGN KEY (`created_by`) REFERENCES `users`(`id`) ON UPDATE no action ON DELETE set null
);
--> statement-breakpoint
CREATE INDEX `attachments_parent_idx` ON `attachments` (`workspace_id`,`parent_kind`,`parent_id`);--> statement-breakpoint
CREATE UNIQUE INDEX `attachments_file_parent_idx` ON `attachments` (`workspace_id`,`drive_file_id`,`parent_kind`,`parent_id`);--> statement-breakpoint
CREATE TABLE `meeting_notes` (
	`event_id` text PRIMARY KEY NOT NULL,
	`workspace_id` text NOT NULL,
	`agenda` text,
	`summary` text,
	`decisions` text DEFAULT '[]' NOT NULL,
	`updated_by` text,
	`created_at` integer DEFAULT (unixepoch() * 1000) NOT NULL,
	`updated_at` integer DEFAULT (unixepoch() * 1000) NOT NULL,
	FOREIGN KEY (`event_id`) REFERENCES `events`(`id`) ON UPDATE no action ON DELETE cascade,
	FOREIGN KEY (`workspace_id`) REFERENCES `workspaces`(`id`) ON UPDATE no action ON DELETE cascade,
	FOREIGN KEY (`updated_by`) REFERENCES `users`(`id`) ON UPDATE no action ON DELETE set null
);
--> statement-breakpoint
ALTER TABLE `integration_accounts` ADD `drive_folders` text;
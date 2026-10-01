CREATE TABLE `secretary_drafts` (
	`id` text PRIMARY KEY NOT NULL,
	`workspace_id` text NOT NULL,
	`user_id` text NOT NULL,
	`source` text NOT NULL,
	`source_name` text NOT NULL,
	`event_id` text,
	`input_text` text,
	`status` text DEFAULT 'analyzing' NOT NULL,
	`proposal` text,
	`error` text,
	`result` text,
	`created_at` integer DEFAULT (unixepoch() * 1000) NOT NULL,
	`updated_at` integer DEFAULT (unixepoch() * 1000) NOT NULL,
	FOREIGN KEY (`workspace_id`) REFERENCES `workspaces`(`id`) ON UPDATE no action ON DELETE cascade,
	FOREIGN KEY (`user_id`) REFERENCES `users`(`id`) ON UPDATE no action ON DELETE cascade,
	FOREIGN KEY (`event_id`) REFERENCES `events`(`id`) ON UPDATE no action ON DELETE set null
);
--> statement-breakpoint
CREATE INDEX `secretary_drafts_ws_idx` ON `secretary_drafts` (`workspace_id`,`created_at`);--> statement-breakpoint
ALTER TABLE `workspaces` ADD `secretary_instructions` text;
CREATE TABLE `task_comments` (
	`id` text PRIMARY KEY NOT NULL,
	`workspace_id` text NOT NULL,
	`task_id` text NOT NULL,
	`user_id` text,
	`body` text NOT NULL,
	`created_at` integer DEFAULT (unixepoch() * 1000) NOT NULL,
	`updated_at` integer DEFAULT (unixepoch() * 1000) NOT NULL,
	FOREIGN KEY (`workspace_id`) REFERENCES `workspaces`(`id`) ON UPDATE no action ON DELETE cascade,
	FOREIGN KEY (`task_id`) REFERENCES `tasks`(`id`) ON UPDATE no action ON DELETE cascade,
	FOREIGN KEY (`user_id`) REFERENCES `users`(`id`) ON UPDATE no action ON DELETE set null
);
--> statement-breakpoint
CREATE INDEX `task_comments_task_idx` ON `task_comments` (`task_id`,`created_at`);--> statement-breakpoint
CREATE TABLE `task_items` (
	`id` text PRIMARY KEY NOT NULL,
	`workspace_id` text NOT NULL,
	`task_id` text NOT NULL,
	`text` text NOT NULL,
	`done` integer DEFAULT false NOT NULL,
	`position` integer NOT NULL,
	`created_at` integer DEFAULT (unixepoch() * 1000) NOT NULL,
	`updated_at` integer DEFAULT (unixepoch() * 1000) NOT NULL,
	FOREIGN KEY (`workspace_id`) REFERENCES `workspaces`(`id`) ON UPDATE no action ON DELETE cascade,
	FOREIGN KEY (`task_id`) REFERENCES `tasks`(`id`) ON UPDATE no action ON DELETE cascade
);
--> statement-breakpoint
CREATE INDEX `task_items_task_idx` ON `task_items` (`task_id`,`position`);
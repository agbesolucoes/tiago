CREATE TABLE `market_studies` (
	`id` text PRIMARY KEY NOT NULL,
	`workspace_id` text NOT NULL,
	`address` text NOT NULL,
	`city` text,
	`lat` real,
	`lon` real,
	`verdict` text,
	`score` real,
	`coverage` real,
	`analyzed_at` integer NOT NULL,
	`state_gz` text,
	`project_id` text,
	`created_by` text,
	`created_at` integer DEFAULT (unixepoch() * 1000) NOT NULL,
	`updated_at` integer DEFAULT (unixepoch() * 1000) NOT NULL,
	FOREIGN KEY (`workspace_id`) REFERENCES `workspaces`(`id`) ON UPDATE no action ON DELETE cascade,
	FOREIGN KEY (`project_id`) REFERENCES `projects`(`id`) ON UPDATE no action ON DELETE set null,
	FOREIGN KEY (`created_by`) REFERENCES `users`(`id`) ON UPDATE no action ON DELETE no action
);
--> statement-breakpoint
CREATE INDEX `market_studies_ws_idx` ON `market_studies` (`workspace_id`,`analyzed_at`);
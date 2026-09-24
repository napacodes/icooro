CREATE TABLE `production_plans` (
	`id` varchar(36) NOT NULL,
	`project_id` varchar(36) NOT NULL,
	`episode_id` varchar(36),
	`request` text NOT NULL,
	`status` varchar(50) NOT NULL DEFAULT 'planning',
	`plan` json,
	`target_duration_seconds` int,
	`preferences` json,
	`created_at` datetime NOT NULL,
	`updated_at` datetime NOT NULL,
	CONSTRAINT `production_plans_id` PRIMARY KEY(`id`)
);
--> statement-breakpoint
ALTER TABLE `production_plans` ADD CONSTRAINT `production_plans_project_id_projects_id_fk` FOREIGN KEY (`project_id`) REFERENCES `projects`(`id`) ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
ALTER TABLE `production_plans` ADD CONSTRAINT `production_plans_episode_id_episodes_id_fk` FOREIGN KEY (`episode_id`) REFERENCES `episodes`(`id`) ON DELETE set null ON UPDATE no action;--> statement-breakpoint
CREATE INDEX `production_plans_project_id_idx` ON `production_plans` (`project_id`);--> statement-breakpoint
CREATE INDEX `production_plans_status_idx` ON `production_plans` (`status`);
-- C6.1: Users, sessions, and project ownership.
--
-- Existing projects are backfilled to a deterministic "legacy" system user
-- so the NOT NULL FK can be applied without dropping data. Real signup is
-- the only way to create a non-legacy user going forward.

CREATE TABLE `users` (
	`id` varchar(36) NOT NULL,
	`email` varchar(254) NOT NULL,
	`name` varchar(120) NOT NULL,
	`password_hash` varchar(512) NOT NULL,
	`role` varchar(20) NOT NULL DEFAULT 'user',
	`created_at` datetime NOT NULL,
	`updated_at` datetime NOT NULL,
	CONSTRAINT `users_id` PRIMARY KEY(`id`),
	CONSTRAINT `users_email_unique` UNIQUE(`email`)
);
--> statement-breakpoint
INSERT INTO `users` (`id`, `email`, `name`, `password_hash`, `role`, `created_at`, `updated_at`)
VALUES ('00000000-0000-0000-0000-000000000000', 'legacy@icooro.local', 'Legacy system user', '!disabled', 'admin', NOW(), NOW());
--> statement-breakpoint
CREATE TABLE `sessions` (
	`id` varchar(36) NOT NULL,
	`token_hash` varchar(128) NOT NULL,
	`user_id` varchar(36) NOT NULL,
	`expires_at` datetime NOT NULL,
	`created_at` datetime NOT NULL,
	CONSTRAINT `sessions_id` PRIMARY KEY(`id`),
	CONSTRAINT `sessions_token_hash_unique` UNIQUE(`token_hash`)
);
--> statement-breakpoint
ALTER TABLE `projects` ADD `owner_id` varchar(36);--> statement-breakpoint
UPDATE `projects` SET `owner_id` = '00000000-0000-0000-0000-000000000000' WHERE `owner_id` IS NULL;--> statement-breakpoint
ALTER TABLE `projects` MODIFY COLUMN `owner_id` varchar(36) NOT NULL;--> statement-breakpoint
ALTER TABLE `sessions` ADD CONSTRAINT `sessions_user_id_users_id_fk` FOREIGN KEY (`user_id`) REFERENCES `users`(`id`) ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
CREATE INDEX `sessions_user_id_idx` ON `sessions` (`user_id`);--> statement-breakpoint
CREATE INDEX `sessions_expires_at_idx` ON `sessions` (`expires_at`);--> statement-breakpoint
ALTER TABLE `projects` ADD CONSTRAINT `projects_owner_id_users_id_fk` FOREIGN KEY (`owner_id`) REFERENCES `users`(`id`) ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
CREATE INDEX `projects_owner_id_idx` ON `projects` (`owner_id`);

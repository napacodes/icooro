CREATE TABLE `asset_versions` (
	`id` varchar(36) NOT NULL,
	`asset_id` varchar(36) NOT NULL,
	`version` int NOT NULL,
	`status` varchar(50) NOT NULL DEFAULT 'ready',
	`source_kind` varchar(50) NOT NULL DEFAULT 'upload',
	`storage_key` varchar(1024) NOT NULL,
	`file_extension` varchar(20),
	`mime_type` varchar(255),
	`file_size` bigint,
	`checksum` varchar(128),
	`width` int,
	`height` int,
	`duration` int,
	`fps` int,
	`sample_rate` int,
	`channels` int,
	`codec` varchar(100),
	`prompt` text,
	`negative_prompt` text,
	`job_id` varchar(36),
	`metadata` json,
	`created_at` datetime NOT NULL,
	`updated_at` datetime NOT NULL,
	CONSTRAINT `asset_versions_id` PRIMARY KEY(`id`),
	CONSTRAINT `asset_versions_asset_version_unique` UNIQUE(`asset_id`,`version`)
);
--> statement-breakpoint
CREATE TABLE `shot_assets` (
	`id` varchar(36) NOT NULL,
	`shot_id` varchar(36) NOT NULL,
	`asset_id` varchar(36) NOT NULL,
	`asset_role` varchar(50) NOT NULL DEFAULT 'reference',
	`created_at` datetime NOT NULL,
	CONSTRAINT `shot_assets_id` PRIMARY KEY(`id`),
	CONSTRAINT `shot_assets_pair_unique` UNIQUE(`shot_id`,`asset_id`)
);
--> statement-breakpoint
ALTER TABLE `assets` MODIFY COLUMN `storage_key` varchar(1024);--> statement-breakpoint
ALTER TABLE `locations` ADD `reference_asset_id` varchar(36);--> statement-breakpoint
ALTER TABLE `props` ADD `reference_asset_id` varchar(36);--> statement-breakpoint
ALTER TABLE `assets` ADD `name` varchar(255) DEFAULT '' NOT NULL;--> statement-breakpoint
ALTER TABLE `assets` ADD `description` text;--> statement-breakpoint
ALTER TABLE `assets` ADD `status` varchar(50) DEFAULT 'draft' NOT NULL;--> statement-breakpoint
ALTER TABLE `assets` ADD `approved_version_id` varchar(36);--> statement-breakpoint
ALTER TABLE `assets` ADD `scene_id` varchar(36);--> statement-breakpoint
ALTER TABLE `assets` ADD `character_id` varchar(36);--> statement-breakpoint
ALTER TABLE `assets` ADD `location_id` varchar(36);--> statement-breakpoint
ALTER TABLE `assets` ADD `prop_id` varchar(36);--> statement-breakpoint
ALTER TABLE `ai_jobs` ADD `asset_version_id` varchar(36);--> statement-breakpoint
ALTER TABLE `ai_jobs` ADD `prompt` text;--> statement-breakpoint
ALTER TABLE `ai_jobs` ADD `negative_prompt` text;--> statement-breakpoint
ALTER TABLE `ai_jobs` ADD `target_media_type` varchar(50);--> statement-breakpoint
ALTER TABLE `ai_jobs` ADD `requested_duration` int;--> statement-breakpoint
ALTER TABLE `ai_jobs` ADD `requested_width` int;--> statement-breakpoint
ALTER TABLE `ai_jobs` ADD `requested_height` int;--> statement-breakpoint
ALTER TABLE `ai_jobs` ADD `progress` int DEFAULT 0 NOT NULL;--> statement-breakpoint
ALTER TABLE `asset_versions` ADD CONSTRAINT `asset_versions_asset_id_assets_id_fk` FOREIGN KEY (`asset_id`) REFERENCES `assets`(`id`) ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
ALTER TABLE `asset_versions` ADD CONSTRAINT `asset_versions_job_id_ai_jobs_id_fk` FOREIGN KEY (`job_id`) REFERENCES `ai_jobs`(`id`) ON DELETE set null ON UPDATE no action;--> statement-breakpoint
ALTER TABLE `shot_assets` ADD CONSTRAINT `shot_assets_shot_id_shots_id_fk` FOREIGN KEY (`shot_id`) REFERENCES `shots`(`id`) ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
ALTER TABLE `shot_assets` ADD CONSTRAINT `shot_assets_asset_id_assets_id_fk` FOREIGN KEY (`asset_id`) REFERENCES `assets`(`id`) ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
CREATE INDEX `asset_versions_asset_id_idx` ON `asset_versions` (`asset_id`);--> statement-breakpoint
CREATE INDEX `asset_versions_status_idx` ON `asset_versions` (`status`);--> statement-breakpoint
CREATE INDEX `asset_versions_source_kind_idx` ON `asset_versions` (`source_kind`);--> statement-breakpoint
CREATE INDEX `asset_versions_job_id_idx` ON `asset_versions` (`job_id`);--> statement-breakpoint
CREATE INDEX `shot_assets_shot_id_idx` ON `shot_assets` (`shot_id`);--> statement-breakpoint
CREATE INDEX `shot_assets_asset_id_idx` ON `shot_assets` (`asset_id`);--> statement-breakpoint
CREATE INDEX `shot_assets_asset_role_idx` ON `shot_assets` (`asset_role`);--> statement-breakpoint
ALTER TABLE `locations` ADD CONSTRAINT `locations_reference_asset_id_assets_id_fk` FOREIGN KEY (`reference_asset_id`) REFERENCES `assets`(`id`) ON DELETE set null ON UPDATE no action;--> statement-breakpoint
ALTER TABLE `props` ADD CONSTRAINT `props_reference_asset_id_assets_id_fk` FOREIGN KEY (`reference_asset_id`) REFERENCES `assets`(`id`) ON DELETE set null ON UPDATE no action;--> statement-breakpoint
ALTER TABLE `assets` ADD CONSTRAINT `assets_approved_version_id_asset_versions_id_fk` FOREIGN KEY (`approved_version_id`) REFERENCES `asset_versions`(`id`) ON DELETE set null ON UPDATE no action;--> statement-breakpoint
ALTER TABLE `assets` ADD CONSTRAINT `assets_scene_id_scenes_id_fk` FOREIGN KEY (`scene_id`) REFERENCES `scenes`(`id`) ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
ALTER TABLE `assets` ADD CONSTRAINT `assets_character_id_characters_id_fk` FOREIGN KEY (`character_id`) REFERENCES `characters`(`id`) ON DELETE set null ON UPDATE no action;--> statement-breakpoint
ALTER TABLE `assets` ADD CONSTRAINT `assets_location_id_locations_id_fk` FOREIGN KEY (`location_id`) REFERENCES `locations`(`id`) ON DELETE set null ON UPDATE no action;--> statement-breakpoint
ALTER TABLE `assets` ADD CONSTRAINT `assets_prop_id_props_id_fk` FOREIGN KEY (`prop_id`) REFERENCES `props`(`id`) ON DELETE set null ON UPDATE no action;--> statement-breakpoint
ALTER TABLE `ai_jobs` ADD CONSTRAINT `ai_jobs_asset_version_id_asset_versions_id_fk` FOREIGN KEY (`asset_version_id`) REFERENCES `asset_versions`(`id`) ON DELETE set null ON UPDATE no action;--> statement-breakpoint
CREATE INDEX `locations_reference_asset_id_idx` ON `locations` (`reference_asset_id`);--> statement-breakpoint
CREATE INDEX `props_reference_asset_id_idx` ON `props` (`reference_asset_id`);--> statement-breakpoint
CREATE INDEX `assets_scene_id_idx` ON `assets` (`scene_id`);--> statement-breakpoint
CREATE INDEX `assets_character_id_idx` ON `assets` (`character_id`);--> statement-breakpoint
CREATE INDEX `assets_location_id_idx` ON `assets` (`location_id`);--> statement-breakpoint
CREATE INDEX `assets_prop_id_idx` ON `assets` (`prop_id`);--> statement-breakpoint
CREATE INDEX `assets_status_idx` ON `assets` (`status`);--> statement-breakpoint
CREATE INDEX `assets_approved_version_id_idx` ON `assets` (`approved_version_id`);--> statement-breakpoint
CREATE INDEX `ai_jobs_asset_version_id_idx` ON `ai_jobs` (`asset_version_id`);
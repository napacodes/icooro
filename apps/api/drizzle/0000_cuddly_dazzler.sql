CREATE TABLE `projects` (
	`id` varchar(36) NOT NULL,
	`name` varchar(255) NOT NULL,
	`description` text,
	`status` varchar(50) NOT NULL DEFAULT 'draft',
	`created_at` datetime NOT NULL,
	`updated_at` datetime NOT NULL,
	CONSTRAINT `projects_id` PRIMARY KEY(`id`)
);
--> statement-breakpoint
CREATE TABLE `episodes` (
	`id` varchar(36) NOT NULL,
	`project_id` varchar(36) NOT NULL,
	`title` varchar(255) NOT NULL,
	`episode_number` int NOT NULL,
	`status` varchar(50) NOT NULL DEFAULT 'draft',
	`created_at` datetime NOT NULL,
	`updated_at` datetime NOT NULL,
	CONSTRAINT `episodes_id` PRIMARY KEY(`id`),
	CONSTRAINT `episodes_project_number_unique` UNIQUE(`project_id`,`episode_number`)
);
--> statement-breakpoint
CREATE TABLE `scripts` (
	`id` varchar(36) NOT NULL,
	`episode_id` varchar(36) NOT NULL,
	`content` text NOT NULL,
	`version` int NOT NULL,
	`created_at` datetime NOT NULL,
	`updated_at` datetime NOT NULL,
	CONSTRAINT `scripts_id` PRIMARY KEY(`id`),
	CONSTRAINT `scripts_episode_version_unique` UNIQUE(`episode_id`,`version`)
);
--> statement-breakpoint
CREATE TABLE `characters` (
	`id` varchar(36) NOT NULL,
	`project_id` varchar(36) NOT NULL,
	`name` varchar(255) NOT NULL,
	`description` text,
	`visual_description` text,
	`reference_asset_id` varchar(36),
	`created_at` datetime NOT NULL,
	`updated_at` datetime NOT NULL,
	CONSTRAINT `characters_id` PRIMARY KEY(`id`)
);
--> statement-breakpoint
CREATE TABLE `locations` (
	`id` varchar(36) NOT NULL,
	`project_id` varchar(36) NOT NULL,
	`name` varchar(255) NOT NULL,
	`description` text,
	`visual_description` text,
	`created_at` datetime NOT NULL,
	`updated_at` datetime NOT NULL,
	CONSTRAINT `locations_id` PRIMARY KEY(`id`)
);
--> statement-breakpoint
CREATE TABLE `props` (
	`id` varchar(36) NOT NULL,
	`project_id` varchar(36) NOT NULL,
	`name` varchar(255) NOT NULL,
	`description` text,
	`visual_description` text,
	`created_at` datetime NOT NULL,
	`updated_at` datetime NOT NULL,
	CONSTRAINT `props_id` PRIMARY KEY(`id`)
);
--> statement-breakpoint
CREATE TABLE `scenes` (
	`id` varchar(36) NOT NULL,
	`episode_id` varchar(36) NOT NULL,
	`name` varchar(255) NOT NULL,
	`description` text,
	`order_index` int NOT NULL,
	`created_at` datetime NOT NULL,
	`updated_at` datetime NOT NULL,
	CONSTRAINT `scenes_id` PRIMARY KEY(`id`)
);
--> statement-breakpoint
CREATE TABLE `shots` (
	`id` varchar(36) NOT NULL,
	`scene_id` varchar(36) NOT NULL,
	`order_index` int NOT NULL,
	`prompt` text,
	`duration` int,
	`status` varchar(50) NOT NULL DEFAULT 'pending',
	`created_at` datetime NOT NULL,
	`updated_at` datetime NOT NULL,
	CONSTRAINT `shots_id` PRIMARY KEY(`id`)
);
--> statement-breakpoint
CREATE TABLE `shot_characters` (
	`id` varchar(36) NOT NULL,
	`shot_id` varchar(36) NOT NULL,
	`character_id` varchar(36) NOT NULL,
	`created_at` datetime NOT NULL,
	CONSTRAINT `shot_characters_id` PRIMARY KEY(`id`),
	CONSTRAINT `shot_characters_pair_unique` UNIQUE(`shot_id`,`character_id`)
);
--> statement-breakpoint
CREATE TABLE `shot_versions` (
	`id` varchar(36) NOT NULL,
	`shot_id` varchar(36) NOT NULL,
	`version` int NOT NULL,
	`prompt` text,
	`status` varchar(50) NOT NULL DEFAULT 'pending',
	`provider_id` varchar(36),
	`model_id` varchar(36),
	`asset_id` varchar(36),
	`duration` int,
	`error` text,
	`created_at` datetime NOT NULL,
	`updated_at` datetime NOT NULL,
	CONSTRAINT `shot_versions_id` PRIMARY KEY(`id`),
	CONSTRAINT `shot_versions_shot_version_unique` UNIQUE(`shot_id`,`version`)
);
--> statement-breakpoint
CREATE TABLE `assets` (
	`id` varchar(36) NOT NULL,
	`project_id` varchar(36),
	`episode_id` varchar(36),
	`shot_id` varchar(36),
	`type` varchar(50) NOT NULL,
	`storage_key` varchar(1024) NOT NULL,
	`mime_type` varchar(255),
	`file_size` int,
	`width` int,
	`height` int,
	`duration` int,
	`metadata` json,
	`created_at` datetime NOT NULL,
	`updated_at` datetime NOT NULL,
	CONSTRAINT `assets_id` PRIMARY KEY(`id`)
);
--> statement-breakpoint
CREATE TABLE `ai_providers` (
	`id` varchar(36) NOT NULL,
	`name` varchar(255) NOT NULL,
	`provider_type` varchar(100) NOT NULL,
	`enabled` boolean NOT NULL DEFAULT true,
	`config` json,
	`created_at` datetime NOT NULL,
	`updated_at` datetime NOT NULL,
	CONSTRAINT `ai_providers_id` PRIMARY KEY(`id`)
);
--> statement-breakpoint
CREATE TABLE `ai_models` (
	`id` varchar(36) NOT NULL,
	`provider_id` varchar(36) NOT NULL,
	`name` varchar(255) NOT NULL,
	`model_id` varchar(255) NOT NULL,
	`capability` varchar(100) NOT NULL,
	`enabled` boolean NOT NULL DEFAULT true,
	`metadata` json,
	`created_at` datetime NOT NULL,
	`updated_at` datetime NOT NULL,
	CONSTRAINT `ai_models_id` PRIMARY KEY(`id`),
	CONSTRAINT `ai_models_provider_model_unique` UNIQUE(`provider_id`,`model_id`)
);
--> statement-breakpoint
CREATE TABLE `ai_jobs` (
	`id` varchar(36) NOT NULL,
	`job_type` varchar(100) NOT NULL,
	`status` varchar(50) NOT NULL DEFAULT 'queued',
	`provider_id` varchar(36),
	`model_id` varchar(36),
	`external_job_id` varchar(255),
	`project_id` varchar(36),
	`episode_id` varchar(36),
	`scene_id` varchar(36),
	`shot_id` varchar(36),
	`shot_version_id` varchar(36),
	`asset_id` varchar(36),
	`error` text,
	`metadata` json,
	`created_at` datetime NOT NULL,
	`updated_at` datetime NOT NULL,
	CONSTRAINT `ai_jobs_id` PRIMARY KEY(`id`),
	CONSTRAINT `ai_jobs_external_job_id_unique` UNIQUE(`external_job_id`)
);
--> statement-breakpoint
ALTER TABLE `episodes` ADD CONSTRAINT `episodes_project_id_projects_id_fk` FOREIGN KEY (`project_id`) REFERENCES `projects`(`id`) ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
ALTER TABLE `scripts` ADD CONSTRAINT `scripts_episode_id_episodes_id_fk` FOREIGN KEY (`episode_id`) REFERENCES `episodes`(`id`) ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
ALTER TABLE `characters` ADD CONSTRAINT `characters_project_id_projects_id_fk` FOREIGN KEY (`project_id`) REFERENCES `projects`(`id`) ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
ALTER TABLE `characters` ADD CONSTRAINT `characters_reference_asset_id_assets_id_fk` FOREIGN KEY (`reference_asset_id`) REFERENCES `assets`(`id`) ON DELETE set null ON UPDATE no action;--> statement-breakpoint
ALTER TABLE `locations` ADD CONSTRAINT `locations_project_id_projects_id_fk` FOREIGN KEY (`project_id`) REFERENCES `projects`(`id`) ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
ALTER TABLE `props` ADD CONSTRAINT `props_project_id_projects_id_fk` FOREIGN KEY (`project_id`) REFERENCES `projects`(`id`) ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
ALTER TABLE `scenes` ADD CONSTRAINT `scenes_episode_id_episodes_id_fk` FOREIGN KEY (`episode_id`) REFERENCES `episodes`(`id`) ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
ALTER TABLE `shots` ADD CONSTRAINT `shots_scene_id_scenes_id_fk` FOREIGN KEY (`scene_id`) REFERENCES `scenes`(`id`) ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
ALTER TABLE `shot_characters` ADD CONSTRAINT `shot_characters_shot_id_shots_id_fk` FOREIGN KEY (`shot_id`) REFERENCES `shots`(`id`) ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
ALTER TABLE `shot_characters` ADD CONSTRAINT `shot_characters_character_id_characters_id_fk` FOREIGN KEY (`character_id`) REFERENCES `characters`(`id`) ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
ALTER TABLE `shot_versions` ADD CONSTRAINT `shot_versions_shot_id_shots_id_fk` FOREIGN KEY (`shot_id`) REFERENCES `shots`(`id`) ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
ALTER TABLE `shot_versions` ADD CONSTRAINT `shot_versions_provider_id_ai_providers_id_fk` FOREIGN KEY (`provider_id`) REFERENCES `ai_providers`(`id`) ON DELETE set null ON UPDATE no action;--> statement-breakpoint
ALTER TABLE `shot_versions` ADD CONSTRAINT `shot_versions_model_id_ai_models_id_fk` FOREIGN KEY (`model_id`) REFERENCES `ai_models`(`id`) ON DELETE set null ON UPDATE no action;--> statement-breakpoint
ALTER TABLE `shot_versions` ADD CONSTRAINT `shot_versions_asset_id_assets_id_fk` FOREIGN KEY (`asset_id`) REFERENCES `assets`(`id`) ON DELETE set null ON UPDATE no action;--> statement-breakpoint
ALTER TABLE `assets` ADD CONSTRAINT `assets_project_id_projects_id_fk` FOREIGN KEY (`project_id`) REFERENCES `projects`(`id`) ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
ALTER TABLE `assets` ADD CONSTRAINT `assets_episode_id_episodes_id_fk` FOREIGN KEY (`episode_id`) REFERENCES `episodes`(`id`) ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
ALTER TABLE `assets` ADD CONSTRAINT `assets_shot_id_shots_id_fk` FOREIGN KEY (`shot_id`) REFERENCES `shots`(`id`) ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
ALTER TABLE `ai_models` ADD CONSTRAINT `ai_models_provider_id_ai_providers_id_fk` FOREIGN KEY (`provider_id`) REFERENCES `ai_providers`(`id`) ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
ALTER TABLE `ai_jobs` ADD CONSTRAINT `ai_jobs_provider_id_ai_providers_id_fk` FOREIGN KEY (`provider_id`) REFERENCES `ai_providers`(`id`) ON DELETE set null ON UPDATE no action;--> statement-breakpoint
ALTER TABLE `ai_jobs` ADD CONSTRAINT `ai_jobs_model_id_ai_models_id_fk` FOREIGN KEY (`model_id`) REFERENCES `ai_models`(`id`) ON DELETE set null ON UPDATE no action;--> statement-breakpoint
ALTER TABLE `ai_jobs` ADD CONSTRAINT `ai_jobs_project_id_projects_id_fk` FOREIGN KEY (`project_id`) REFERENCES `projects`(`id`) ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
ALTER TABLE `ai_jobs` ADD CONSTRAINT `ai_jobs_episode_id_episodes_id_fk` FOREIGN KEY (`episode_id`) REFERENCES `episodes`(`id`) ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
ALTER TABLE `ai_jobs` ADD CONSTRAINT `ai_jobs_scene_id_scenes_id_fk` FOREIGN KEY (`scene_id`) REFERENCES `scenes`(`id`) ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
ALTER TABLE `ai_jobs` ADD CONSTRAINT `ai_jobs_shot_id_shots_id_fk` FOREIGN KEY (`shot_id`) REFERENCES `shots`(`id`) ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
ALTER TABLE `ai_jobs` ADD CONSTRAINT `ai_jobs_shot_version_id_shot_versions_id_fk` FOREIGN KEY (`shot_version_id`) REFERENCES `shot_versions`(`id`) ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
ALTER TABLE `ai_jobs` ADD CONSTRAINT `ai_jobs_asset_id_assets_id_fk` FOREIGN KEY (`asset_id`) REFERENCES `assets`(`id`) ON DELETE set null ON UPDATE no action;--> statement-breakpoint
CREATE INDEX `episodes_project_id_idx` ON `episodes` (`project_id`);--> statement-breakpoint
CREATE INDEX `scripts_episode_id_idx` ON `scripts` (`episode_id`);--> statement-breakpoint
CREATE INDEX `characters_project_id_idx` ON `characters` (`project_id`);--> statement-breakpoint
CREATE INDEX `characters_reference_asset_id_idx` ON `characters` (`reference_asset_id`);--> statement-breakpoint
CREATE INDEX `locations_project_id_idx` ON `locations` (`project_id`);--> statement-breakpoint
CREATE INDEX `props_project_id_idx` ON `props` (`project_id`);--> statement-breakpoint
CREATE INDEX `scenes_episode_id_idx` ON `scenes` (`episode_id`);--> statement-breakpoint
CREATE INDEX `shots_scene_id_idx` ON `shots` (`scene_id`);--> statement-breakpoint
CREATE INDEX `shots_status_idx` ON `shots` (`status`);--> statement-breakpoint
CREATE INDEX `shot_characters_shot_id_idx` ON `shot_characters` (`shot_id`);--> statement-breakpoint
CREATE INDEX `shot_characters_character_id_idx` ON `shot_characters` (`character_id`);--> statement-breakpoint
CREATE INDEX `shot_versions_shot_id_idx` ON `shot_versions` (`shot_id`);--> statement-breakpoint
CREATE INDEX `shot_versions_status_idx` ON `shot_versions` (`status`);--> statement-breakpoint
CREATE INDEX `shot_versions_provider_id_idx` ON `shot_versions` (`provider_id`);--> statement-breakpoint
CREATE INDEX `shot_versions_model_id_idx` ON `shot_versions` (`model_id`);--> statement-breakpoint
CREATE INDEX `shot_versions_asset_id_idx` ON `shot_versions` (`asset_id`);--> statement-breakpoint
CREATE INDEX `assets_project_id_idx` ON `assets` (`project_id`);--> statement-breakpoint
CREATE INDEX `assets_episode_id_idx` ON `assets` (`episode_id`);--> statement-breakpoint
CREATE INDEX `assets_shot_id_idx` ON `assets` (`shot_id`);--> statement-breakpoint
CREATE INDEX `assets_type_idx` ON `assets` (`type`);--> statement-breakpoint
CREATE INDEX `ai_providers_provider_type_idx` ON `ai_providers` (`provider_type`);--> statement-breakpoint
CREATE INDEX `ai_providers_enabled_idx` ON `ai_providers` (`enabled`);--> statement-breakpoint
CREATE INDEX `ai_models_provider_id_idx` ON `ai_models` (`provider_id`);--> statement-breakpoint
CREATE INDEX `ai_models_capability_idx` ON `ai_models` (`capability`);--> statement-breakpoint
CREATE INDEX `ai_models_enabled_idx` ON `ai_models` (`enabled`);--> statement-breakpoint
CREATE INDEX `ai_jobs_status_idx` ON `ai_jobs` (`status`);--> statement-breakpoint
CREATE INDEX `ai_jobs_job_type_idx` ON `ai_jobs` (`job_type`);--> statement-breakpoint
CREATE INDEX `ai_jobs_provider_id_idx` ON `ai_jobs` (`provider_id`);--> statement-breakpoint
CREATE INDEX `ai_jobs_model_id_idx` ON `ai_jobs` (`model_id`);--> statement-breakpoint
CREATE INDEX `ai_jobs_project_id_idx` ON `ai_jobs` (`project_id`);--> statement-breakpoint
CREATE INDEX `ai_jobs_episode_id_idx` ON `ai_jobs` (`episode_id`);--> statement-breakpoint
CREATE INDEX `ai_jobs_scene_id_idx` ON `ai_jobs` (`scene_id`);--> statement-breakpoint
CREATE INDEX `ai_jobs_shot_id_idx` ON `ai_jobs` (`shot_id`);--> statement-breakpoint
CREATE INDEX `ai_jobs_shot_version_id_idx` ON `ai_jobs` (`shot_version_id`);--> statement-breakpoint
CREATE INDEX `ai_jobs_asset_id_idx` ON `ai_jobs` (`asset_id`);
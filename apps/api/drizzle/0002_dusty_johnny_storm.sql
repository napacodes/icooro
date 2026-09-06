CREATE TABLE `shot_locations` (
	`id` varchar(36) NOT NULL,
	`shot_id` varchar(36) NOT NULL,
	`location_id` varchar(36) NOT NULL,
	`created_at` datetime NOT NULL,
	CONSTRAINT `shot_locations_id` PRIMARY KEY(`id`),
	CONSTRAINT `shot_locations_pair_unique` UNIQUE(`shot_id`,`location_id`)
);
--> statement-breakpoint
CREATE TABLE `shot_props` (
	`id` varchar(36) NOT NULL,
	`shot_id` varchar(36) NOT NULL,
	`prop_id` varchar(36) NOT NULL,
	`created_at` datetime NOT NULL,
	CONSTRAINT `shot_props_id` PRIMARY KEY(`id`),
	CONSTRAINT `shot_props_pair_unique` UNIQUE(`shot_id`,`prop_id`)
);
--> statement-breakpoint
ALTER TABLE `shot_locations` ADD CONSTRAINT `shot_locations_shot_id_shots_id_fk` FOREIGN KEY (`shot_id`) REFERENCES `shots`(`id`) ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
ALTER TABLE `shot_locations` ADD CONSTRAINT `shot_locations_location_id_locations_id_fk` FOREIGN KEY (`location_id`) REFERENCES `locations`(`id`) ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
ALTER TABLE `shot_props` ADD CONSTRAINT `shot_props_shot_id_shots_id_fk` FOREIGN KEY (`shot_id`) REFERENCES `shots`(`id`) ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
ALTER TABLE `shot_props` ADD CONSTRAINT `shot_props_prop_id_props_id_fk` FOREIGN KEY (`prop_id`) REFERENCES `props`(`id`) ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
CREATE INDEX `shot_locations_shot_id_idx` ON `shot_locations` (`shot_id`);--> statement-breakpoint
CREATE INDEX `shot_locations_location_id_idx` ON `shot_locations` (`location_id`);--> statement-breakpoint
CREATE INDEX `shot_props_shot_id_idx` ON `shot_props` (`shot_id`);--> statement-breakpoint
CREATE INDEX `shot_props_prop_id_idx` ON `shot_props` (`prop_id`);
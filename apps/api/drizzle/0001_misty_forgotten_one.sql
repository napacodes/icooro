ALTER TABLE `shots` ADD `purpose` varchar(100);--> statement-breakpoint
ALTER TABLE `shots` ADD `shot_type` varchar(100);--> statement-breakpoint
ALTER TABLE `shots` ADD `framing` varchar(100);--> statement-breakpoint
ALTER TABLE `shots` ADD `camera_movement` varchar(100);--> statement-breakpoint
ALTER TABLE `shots` ADD `camera_angle` varchar(100);--> statement-breakpoint
ALTER TABLE `shots` ADD `visual_description` text;--> statement-breakpoint
ALTER TABLE `shots` ADD `action_description` text;--> statement-breakpoint
ALTER TABLE `shots` ADD `dialogue` text;--> statement-breakpoint
ALTER TABLE `shots` ADD `transition` varchar(100);--> statement-breakpoint
ALTER TABLE `shots` ADD `production_notes` text;--> statement-breakpoint
ALTER TABLE `shot_versions` ADD `production_ready` int DEFAULT 0 NOT NULL;
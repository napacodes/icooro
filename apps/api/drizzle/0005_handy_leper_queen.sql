-- C6.3: Database-driven AI provider + model configuration.
--
-- Providers gain a base URL and a sealed API-key envelope so admins can
-- configure credentials from the Control Plane. The key is stored only in
-- `api_key_secret` (AES-256-GCM, see src/providers/secrets.ts) and is never
-- returned by any API response.
--
-- Models gain `job_types` to declare which generation job types they support.

ALTER TABLE `ai_providers` ADD `base_url` varchar(500);--> statement-breakpoint
ALTER TABLE `ai_providers` ADD `api_key_secret` text;--> statement-breakpoint
ALTER TABLE `ai_models` ADD `job_types` json;

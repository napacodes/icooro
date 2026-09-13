# Icooro

Icooro is an original AI video production platform. It is being built to create educational YouTube Shorts, animated stories, short dramas, social media videos, marketing videos, and later SaaS customer projects.

This repository is an early production foundation for the Icooro platform.

## Current development milestone

## Current development milestone

Current milestone — Phase C4 media assets foundation:

- Vue 3 / Nuxt 3 creative production workspace with Media Assets management
- Hono API with Projects, storytelling domain, media assets, shot attachments, AI jobs, and providers
- Storage Abstraction (`StorageProvider`) with local disk driver and strict path traversal protection
- AI Provider Abstraction (`ProviderRegistry`) with capability lookups, credential stripping, and `MockMediaProvider`
- Drizzle ORM schema and migrations (`0001`, `0002`, `0003`)
- Shared TypeScript package
- Comprehensive automated test suite (`pnpm test`) covering all 17 media lifecycle, storage, and provider scenarios
- Docker Compose (MySQL 8, API, web)

Production AI vendor calls (e.g. Kling, Veo, Flux), video timeline editor, server-side FFmpeg rendering pipelines, billing, and auth are planned for subsequent phases.

## Requirements

- Node.js 20 or newer
- [pnpm](https://pnpm.io/) 9 (via Corepack: `corepack enable`)
- Docker and Docker Compose (for containerized services)

## Installation

```bash
corepack enable
pnpm install
```

## Environment setup

Copy `.env.example` to `.env` and fill in local values. Do not commit `.env`.

```bash
cp .env.example .env
```

On Windows PowerShell:

```powershell
Copy-Item .env.example .env
```

`.env.example` lists variable names only. It does not contain real secrets or API keys.

- `STORAGE_DRIVER`: storage backend (`local`). Default: `local`.
- `STORAGE_LOCAL_ROOT`: local filesystem root for media files. Default: `./storage`.
- `NUXT_PUBLIC_API_BASE`: browser-visible API origin (not a secret). Provider keys must never be placed in Nuxt public runtime config.

## Running tests

The codebase includes automated tests covering storage, path traversal security, provider registries, generation job state transitions, validation schemas, and the complete asset lifecycle:

```bash
pnpm test
```

## Starting Docker

From the repository root, with required variables set in `.env` or the shell:

```bash
docker compose up --build
```

- MySQL data is stored in the `mysql_data` Docker volume.
- API: `http://localhost:${API_PORT}` (default `3001`)
- Web: `http://localhost:${WEB_PORT}` (default `3000`)
- MySQL: `localhost:${MYSQL_PORT}` (default `3306`)

The API requires `DATABASE_URL` and uses the existing Drizzle schema for database-backed routes.

## Starting development servers

Without Docker (MySQL not required for Phase A):

```bash
pnpm install
pnpm --filter @icooro/shared build
pnpm dev
```

Or separately:

```bash
pnpm dev:api
pnpm dev:web
```

Useful scripts:

| Script | Purpose |
| --- | --- |
| `pnpm dev` | API and web in watch mode |
| `pnpm build` | Build shared, API, and web |
| `pnpm typecheck` | Typecheck all workspaces |
| `pnpm test` | Run automated test suite |

## Health endpoint

```bash
curl http://localhost:3001/health
```

Expected JSON:

```json
{
  "ok": true,
  "service": "icooro-api"
}
```

## Projects API

The API exposes unauthenticated CRUD endpoints under `/api/v1/projects`:

| Method | Endpoint | Purpose |
| --- | --- | --- |
| `GET` | `/api/v1/projects` | List projects |
| `POST` | `/api/v1/projects` | Create a project |
| `GET` | `/api/v1/projects/:id` | Get a project |
| `PATCH` | `/api/v1/projects/:id` | Update one or more project fields |
| `DELETE` | `/api/v1/projects/:id` | Delete a project and its cascading records |

## Storytelling foundation

C2 & C3 establish the relational hierarchy:

`Project → Episode → Script, Characters, Locations, Props, Scenes → Shots → Shot Versions`

Characters are project-owned so they can be reused across episodes. Scenes and
shots remain episode/scene-owned, and shot-character links use the existing
many-to-many join table.

## Phase C4: Media Assets Foundation

Phase C4 introduces the media data architecture and asset lifecycle.

### Core Concepts

1. **Logical Asset (`assets`)**:
   Represents a media concept (e.g. "Hero Character Model", "Intro Plate Video", "Laser Gun Foley"). Contains project scoping, entity associations (episode, scene, shot, character, location, prop), lifecycle status (`draft`, `processing`, `ready`, `approved`, `rejected`, `archived`), and points to the currently `approved_version_id`.

2. **Physical Asset Version (`asset_versions`)**:
   Immutable file revision associated with an asset. Identified deterministically by `(asset_id, version)` where versions are sequential positive integers (v1, v2, ...). Stores technical metadata (file size, checksum, mime type, resolution, fps, duration, sample rate, codec), source kind (`upload`, `generated`, `derived`, `imported`), and generation prompt/job references.

3. **Generation Job (`ai_jobs`)**:
   Represents an AI task execution (prompt, settings, progress, provider, model) separate from the resulting media asset. Follows a strict lifecycle state machine (`queued` → `submitted` → `processing` → `downloading` → `completed` / `failed` / `cancelled`). On completion, a new `asset_version` is produced and attached.

4. **Shot Attachments (`shot_assets`)**:
   Normalized join table linking assets to shots with roles (`reference`, `background`, `plate`, `vfx_element`, `audio_track`). Enforces strict project isolation.

### Storage Abstraction

The storage layer exposes `StorageProvider` interface implemented by `LocalStorageProvider` (`apps/api/src/storage/`):
- Clean abstraction for `put`, `get`, `exists`, `delete`, and `getMetadata`.
- Strict path traversal prevention: rejects `..`, absolute paths, Windows drive letters, null bytes, and any paths resolving outside the configured root directory.

### Provider Abstraction & Registry

- `ProviderRegistry` (`apps/api/src/providers/registry.ts`): Registers and manages providers (`VideoProvider`, `ImageProvider`, `AudioProvider`, `TextProvider`). Sanitizes all provider configuration to strip secrets and API keys before returning data to clients.
- `MockMediaProvider` (`apps/api/src/providers/mock.ts`): Deterministic mock provider producing valid mock PNG and MP4 headers for local testing without external AI dependencies.

### Database Migrations

- `0001_misty_forgotten_one.sql`: Shot production metadata
- `0002_dusty_johnny_storm.sql`: Shot-location and shot-prop join tables
- `0003_flippant_master_chief.sql`: Asset extensions with approved_version_id FK, `asset_versions`, `shot_assets`, `locations.reference_asset_id`, `props.reference_asset_id`, and `ai_jobs` extensions.

Apply migrations with:

```bash
pnpm --filter @icooro/api db:migrate
```

## Current limitations

- No real external AI vendor calls (mock provider utilized for deterministic verification)
- Timeline video editor and server-side FFmpeg rendering pipelines (planned for future phases)
- Production authentication, authorization, and multi-tenant billing
- Cloud storage drivers (S3, GCS) planned for cloud production phase

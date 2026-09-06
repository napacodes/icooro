# Icooro

Icooro is an original AI video production platform. It is being built to create educational YouTube Shorts, animated stories, short dramas, social media videos, marketing videos, and later SaaS customer projects.

This repository is an early production foundation for the Icooro platform.

## Current development milestone

Current milestone — Phase C3 creative production foundation:

- Vue 3 / Nuxt 3 creative production workspace
- Hono API with health endpoints, Projects CRUD, and storytelling domain routes
- Drizzle ORM schema and initial MySQL migration
- Shared TypeScript package
- Docker Compose (MySQL 8, API, web)
- Local filesystem storage directory (empty)

AI providers, video generation, authentication, and production infrastructure are not implemented.

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

`NUXT_PUBLIC_API_BASE` is the browser-visible API origin (not a secret). Provider keys must never be placed in Nuxt public runtime config.

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

Create and update requests must contain JSON. `name` is required when creating
a project and must be a non-empty string of at most 255 characters.
`description` may be a string or `null`, and `status` must be a non-empty string
of at most 50 characters.

## Storytelling foundation

C2 establishes the relational hierarchy:

`Project → Episode → Script, Characters, Locations, Props, Scenes → Shots → Shot Versions`

Characters are project-owned so they can be reused across episodes. Scenes and
shots remain episode/scene-owned, and shot-character links use the existing
many-to-many join table. The existing C2 schema already contains these tables,
foreign keys, cascade rules, and uniqueness constraints, so no new migration is
required.

The API provides nested creation/listing routes for episodes, scripts, creative
entities, scenes, shots, shot-character relationships, and shot versions, along
with top-level CRUD routes for Projects, Episodes, Scripts, Characters,
Locations, Props, Scenes, Shots, Shot-Character relationships, and Shot
Versions. See the route modules for the complete endpoint contract.

The frontend provides the Projects page and a project workspace at
`/projects/:id`. The workspace supports episode and script version CRUD,
project-owned character/location/prop CRUD, ordered scene and shot planning,
shot production metadata, shot-character assignment, and ordered shot-version
revisions with a production-ready marker. It uses the API as its source of
truth and includes loading, empty, error, success, and destructive-action
confirmation states.

## Creative production API

The existing C2 resource groups now form the C3 production contract:

- `GET/POST /api/v1/projects/:projectId/episodes`
- `GET/POST /api/v1/episodes/:episodeId/script`
- `GET/POST /api/v1/episodes/:episodeId/{characters|locations|props|scenes}`
- `GET/POST /api/v1/scenes/:sceneId/shots`
- `GET/POST /api/v1/projects/:projectId/{characters|locations|props}`
- `GET/POST /api/v1/shots/:shotId/{characters|locations|props|versions}` with relationship deletion routes
- Top-level `GET/PATCH/DELETE` routes for all storytelling resources

Shot records carry production purpose, shot type, framing, camera movement and
angle, visual/action/dialogue descriptions, transitions, notes, duration,
ordering, and status. Shot versions have deterministic `(shot, version)`
identity and a `productionReady` marker. Parent changes are rejected after
creation to protect hierarchy ownership. Shot-character, shot-location, and
shot-prop relationships are project-scoped and reject duplicate or
cross-project assignments. The workspace requests creative assets through
project-scoped endpoints rather than loading global collections.

C3 migrations are `apps/api/drizzle/0001_misty_forgotten_one.sql` (shot production
fields) and `apps/api/drizzle/0002_dusty_johnny_storm.sql` (shot-location and
shot-prop join tables). Both are non-destructive. Apply them with
`pnpm --filter @icooro/api db:migrate` against the configured MySQL database
before starting the API.

## Current limitations

- No real AI generation, rendering, voice generation, workers, or production queue
- Authentication and authorization
- Billing and SaaS/multi-tenancy
- Binary asset upload and reference-asset management
- `APP_ENCRYPTION_KEY` is reserved for later phases

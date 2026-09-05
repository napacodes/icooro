# Icooro

Icooro is an original AI video production platform. It is being built to create educational YouTube Shorts, animated stories, short dramas, social media videos, marketing videos, and later SaaS customer projects.

This repository is an early production foundation for the Icooro platform.

## Current development milestone

Current milestone — Phase C1 Projects backend foundation:

- Vue 3 / Nuxt 3 frontend placeholder
- Hono API with health endpoints and Projects CRUD routes
- Drizzle ORM schema and initial MySQL migration
- Shared TypeScript package
- Docker Compose (MySQL 8, API, web)
- Local filesystem storage directory (empty)

AI providers, video generation, authentication, and frontend project workflows are not implemented.

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

## Current limitations

- No episode, script, character, scene, or shot API routes
- No AI provider abstraction or adapters
- No video generation, mock generator, or job worker
- No authentication, billing, or multi-tenant SaaS
- Frontend is a placeholder homepage only
- `DATABASE_URL` and `APP_ENCRYPTION_KEY` are reserved for later phases

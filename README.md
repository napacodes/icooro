# Icooro

Icooro is an original AI video production platform. It is being built to create educational YouTube Shorts, animated stories, short dramas, social media videos, marketing videos, and later SaaS customer projects.

This repository is **Phase A**: a runnable monorepo skeleton. It is not a product yet.

## Current development milestone

Phase A — initialize the workspace:

- Vue 3 / Nuxt 3 frontend placeholder
- Hono API with `GET /health`
- Shared TypeScript package
- Docker Compose (MySQL 8, API, web)
- Local filesystem storage directory (empty)

AI providers, video generation, jobs, database schema, and application domain models are **not** implemented.

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

The API does not connect to MySQL in Phase A. The database service is included so later phases can use it.

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

## Current limitations

- No projects, episodes, scripts, characters, scenes, or shots
- No AI provider abstraction or adapters
- No video generation, mock generator, or job worker
- No MySQL schema or migrations
- No authentication, billing, or multi-tenant SaaS
- Frontend is a placeholder homepage only
- `DATABASE_URL` and `APP_ENCRYPTION_KEY` are reserved for later phases

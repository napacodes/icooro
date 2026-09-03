FROM node:22-alpine

RUN corepack enable && corepack prepare pnpm@9.15.9 --activate

WORKDIR /app

COPY package.json pnpm-workspace.yaml pnpm-lock.yaml ./
COPY apps/web apps/web
COPY apps/api/package.json apps/api/package.json
COPY packages/shared packages/shared

RUN pnpm install --frozen-lockfile --ignore-scripts
RUN pnpm --filter @icooro/shared build && pnpm --filter @icooro/web build

ENV HOST=0.0.0.0
ENV PORT=3000
ENV NUXT_PUBLIC_API_BASE=http://localhost:3001
EXPOSE 3000

CMD ["node", "apps/web/.output/server/index.mjs"]

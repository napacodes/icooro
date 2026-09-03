FROM node:22-alpine

RUN corepack enable && corepack prepare pnpm@9.15.9 --activate

WORKDIR /app

COPY package.json pnpm-workspace.yaml pnpm-lock.yaml ./
COPY apps/api apps/api
COPY apps/web/package.json apps/web/package.json
COPY packages/shared packages/shared

RUN pnpm install --frozen-lockfile --ignore-scripts
RUN pnpm --filter @icooro/shared build && pnpm --filter @icooro/api build

ENV API_PORT=3001
EXPOSE 3001

CMD ["pnpm", "--filter", "@icooro/api", "start"]

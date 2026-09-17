# Development image for the Node.js workspaces (BFF, partner sandbox and the
# two Vite frontends, each started by its own docker compose command).
# Node 22 alpine per the Week 0 ticket; pnpm is pinned by the root
# package.json "packageManager" field and enabled through corepack.
FROM node:22-alpine
WORKDIR /workspace
RUN corepack enable
COPY package.json pnpm-workspace.yaml pnpm-lock.yaml tsconfig.base.json ./
COPY apps apps
COPY packages packages
COPY contract contract
RUN pnpm install --frozen-lockfile
ARG PACKAGE
# The shared UI package is consumed from its built dist/ entry point, so it
# must be built before the app under test.
RUN pnpm --filter @consenthub/ui build && pnpm --filter "${PACKAGE}" build
EXPOSE 4000 4100 5173 5174

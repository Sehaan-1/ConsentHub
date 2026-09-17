FROM node:20-bookworm-slim
WORKDIR /workspace
RUN corepack enable
COPY package.json pnpm-workspace.yaml pnpm-lock.yaml* tsconfig.base.json ./
COPY apps apps
COPY packages packages
COPY contract contract
RUN pnpm install --frozen-lockfile
ARG PACKAGE
RUN pnpm --filter @consenthub/ui build && pnpm --filter "${PACKAGE}" build
EXPOSE 3001 5173 5174

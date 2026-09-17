# Production image for the Node.js server apps (BFF and partner sandbox).
# The final stage contains only compiled output — no toolchain, no
# node_modules (neither server app has runtime dependencies) — and runs as
# the unprivileged `node` user that the base image provides.
FROM node:22-alpine AS build
WORKDIR /workspace
RUN corepack enable
COPY package.json pnpm-workspace.yaml pnpm-lock.yaml tsconfig.base.json ./
COPY apps apps
COPY packages packages
COPY contract contract
RUN pnpm install --frozen-lockfile
RUN pnpm --filter @consenthub/ui build \
    && pnpm --filter @consenthub/bff build \
    && pnpm --filter @consenthub/partner-sandbox build

FROM node:22-alpine
ENV NODE_ENV=production
WORKDIR /workspace
COPY --from=build /workspace/apps/bff/package.json apps/bff/package.json
COPY --from=build /workspace/apps/bff/dist apps/bff/dist
COPY --from=build /workspace/apps/partner-sandbox/package.json apps/partner-sandbox/package.json
COPY --from=build /workspace/apps/partner-sandbox/dist apps/partner-sandbox/dist
USER node
EXPOSE 4000 4100
HEALTHCHECK --interval=10s --timeout=5s --start-period=10s --retries=6 \
    CMD node -e "fetch('http://127.0.0.1:' + (process.env.PORT || '4000') + '/health').then(r => process.exit(r.ok ? 0 : 1)).catch(() => process.exit(1))"
CMD ["node", "apps/bff/dist/index.js"]

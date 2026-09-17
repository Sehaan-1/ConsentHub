# Production image for one Vite single-page app, served by nginx.
# The SPA is built in the first stage; the second stage is stock
# nginx:alpine with the static files and a /api reverse proxy to the BFF.
#
# Build args:
#   APP_DIR  workspace directory name under apps/ (e.g. customer-portal)
FROM node:22-alpine AS build
WORKDIR /workspace
RUN corepack enable
COPY package.json pnpm-workspace.yaml pnpm-lock.yaml tsconfig.base.json ./
COPY apps apps
COPY packages packages
COPY contract contract
RUN pnpm install --frozen-lockfile
ARG APP_DIR
RUN pnpm --filter @consenthub/ui build && pnpm --filter "./apps/${APP_DIR}" build

FROM nginx:1.27-alpine
ARG APP_DIR
# /api/* requests are forwarded to the BFF service on the docker network.
# Substituted by the nginx image's envsubst template hook at container start.
ENV BFF_UPSTREAM=http://bff:4000
COPY --from=build /workspace/apps/${APP_DIR}/dist /usr/share/nginx/html
COPY docker/nginx/default.conf.template /etc/nginx/templates/default.conf.template
EXPOSE 80
HEALTHCHECK --interval=10s --timeout=5s --start-period=10s --retries=6 \
    CMD wget -qO /dev/null http://127.0.0.1/ || exit 1

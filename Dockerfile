# syntax=docker/dockerfile:1

FROM node:22-alpine AS build
WORKDIR /app
COPY package.json package-lock.json ./
RUN npm ci
COPY tsconfig.json ./
COPY src ./src
RUN npx tsc -p tsconfig.json

FROM node:22-alpine AS deps
WORKDIR /app
COPY package.json package-lock.json ./
RUN npm ci --omit=dev && npm cache clean --force

FROM node:22-alpine AS runtime
WORKDIR /app
ENV NODE_ENV=production
# tini reaps zombies and forwards SIGTERM, so shutdown is clean.
RUN apk add --no-cache tini
COPY --from=deps /app/node_modules ./node_modules
COPY --from=build /app/dist ./dist
COPY package.json ./

# Seed the mount points so the volumes come up owned correctly.
#
# Docker initialises an EMPTY named volume from the image directory it is
# mounted over, copying ownership and mode along with any contents. Creating
# these here is therefore how the volumes get a usable owner, with no runtime
# chown and no root container.
#
# /vault is shared with livesync-bridge, which runs as its own `deno` user, so
# it is owned by that uid rather than by `node`. VAULT_UID must match the uid
# the bridge runs as; check with `docker exec <bridge> id`. vault-service runs
# under the same uid, set in docker-compose.yml.
#
# /render holds only the bridge config this image writes, so `node` owns it.
# Mode 755 lets the bridge traverse it and read the 644 config as any uid.
ARG VAULT_UID=1993
ARG VAULT_GID=1993
RUN mkdir -p /vault /render \
    && chown "${VAULT_UID}:${VAULT_GID}" /vault \
    && chown node:node /render \
    && chmod 755 /vault /render

USER node
EXPOSE 8080

HEALTHCHECK --interval=30s --timeout=5s --start-period=10s --retries=3 \
  CMD node -e "fetch('http://127.0.0.1:'+(process.env.PORT||8080)+'/health').then(r=>process.exit(r.ok?0:1)).catch(()=>process.exit(1))"

ENTRYPOINT ["/sbin/tini", "--"]
CMD ["node", "dist/index.js"]

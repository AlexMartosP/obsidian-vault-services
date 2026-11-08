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

# su-exec drops privileges in the entrypoint; tini reaps zombies and forwards
# SIGTERM so shutdown is clean.
RUN apk add --no-cache su-exec
COPY docker/entrypoint.sh /usr/local/bin/entrypoint.sh
RUN chmod +x /usr/local/bin/entrypoint.sh

# Create the mount points so they exist in the image. Ownership is corrected
# at runtime by the entrypoint rather than baked here: Docker only seeds
# ownership from the image when a named volume is empty, which covers neither
# bind mounts nor an existing deployment.
RUN mkdir -p /vault /render

# Starts as root on purpose, then the entrypoint execs the command as
# PUID:PGID. Set `user:` in compose to skip that if your platform forbids
# root; the entrypoint detects it and leaves ownership alone.
EXPOSE 8080

HEALTHCHECK --interval=30s --timeout=5s --start-period=10s --retries=3 \
  CMD node -e "fetch('http://127.0.0.1:'+(process.env.PORT||8080)+'/health').then(r=>process.exit(r.ok?0:1)).catch(()=>process.exit(1))"

ENTRYPOINT ["/sbin/tini", "--", "/usr/local/bin/entrypoint.sh"]
CMD ["node", "dist/index.js"]

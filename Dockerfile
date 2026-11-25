# syntax=docker/dockerfile:1
# Synrgy production image: one container serves the API and the built web app.
#   docker build -t synrgy .
#   docker run -p 4000:4000 -e DATABASE_URL=postgres://... -e CLIENT_ORIGIN=https://hr.example.com synrgy

ARG NODE_VERSION=26

# ---- Install all dependencies (for building the client) ----
FROM node:${NODE_VERSION}-alpine AS deps
WORKDIR /app
COPY package.json package-lock.json ./
COPY server/package.json server/
COPY client/package.json client/
RUN npm ci --no-audit --no-fund

# ---- Build the web app ----
FROM deps AS build
COPY client client
RUN npm run build -w client

# ---- Production dependencies for the API only ----
FROM node:${NODE_VERSION}-alpine AS prod-deps
WORKDIR /app
COPY package.json package-lock.json ./
COPY server/package.json server/
COPY client/package.json client/
RUN npm ci --omit=dev --workspace server --no-audit --no-fund

# ---- Runtime ----
FROM node:${NODE_VERSION}-alpine
ENV NODE_ENV=production \
    PORT=4000 \
    STATIC_DIR=/app/client/dist \
    MIGRATE_ON_START=true
WORKDIR /app
COPY --from=prod-deps /app/node_modules node_modules
COPY server/package.json server/
COPY server/src server/src
COPY server/migrations server/migrations
COPY --from=build /app/client/dist client/dist

# Node runs the TypeScript sources directly (type stripping); there is no server build step.
USER node
EXPOSE 4000
HEALTHCHECK --interval=30s --timeout=5s --start-period=20s --retries=3 \
  CMD node -e "fetch('http://127.0.0.1:'+(process.env.PORT||4000)+'/api/health/ready').then(r=>process.exit(r.ok?0:1),()=>process.exit(1))"
STOPSIGNAL SIGTERM
CMD ["node", "server/src/index.ts"]

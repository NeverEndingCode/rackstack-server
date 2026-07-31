# --- Stage 1: build the client ---
FROM node:20-bookworm-slim AS client-build
WORKDIR /app/client
COPY client/package.json client/package-lock.json* ./
RUN npm install
COPY client/ ./
# The client's @shared Vite alias resolves '../shared' relative to
# client/vite.config.js, i.e. /app/shared from this stage's /app/client
# WORKDIR - copy shared/ one level up to match. vite.config.js also reads
# the root package.json (release-version authority) via the same
# one-level-up relative path for __APP_VERSION__.
COPY shared/ /app/shared/
COPY package.json /app/package.json
RUN npm run build

# --- Stage 2: server + runtime deps ---
FROM node:20-bookworm-slim AS server
# better-sqlite3 compiles a native addon at install time
RUN apt-get update && apt-get install -y --no-install-recommends python3 make g++ \
    && rm -rf /var/lib/apt/lists/*

WORKDIR /app
COPY package.json package-lock.json* ./
RUN npm install --omit=dev

COPY server/ ./server/
COPY shared/ ./shared/
# GET /api/changelog serves this file (server/routes/api.js resolves it at
# ../../CHANGELOG.md), and the profile's version display fetches it - without
# it in the image the endpoint silently falls back to "No changelog available."
COPY CHANGELOG.md ./CHANGELOG.md
COPY --from=client-build /app/client/dist ./client/dist

ENV NODE_ENV=production
ENV PORT=3000
ENV DB_PATH=/app/data/rackstack.db

LABEL org.opencontainers.image.source="https://github.com/NeverEndingCode/rackstack-server"
LABEL org.opencontainers.image.description="RackStack self-hosted server"
LABEL org.opencontainers.image.licenses="MIT"
LABEL org.opencontainers.image.version="1.4.0"

VOLUME ["/app/data"]
EXPOSE 3000

CMD ["node", "server/index.js"]

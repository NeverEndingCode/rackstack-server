# --- Stage 1: build the client ---
FROM node:20-bookworm-slim AS client-build
WORKDIR /app/client
COPY client/package.json client/package-lock.json* ./
RUN npm install
COPY client/ ./
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
COPY --from=client-build /app/client/dist ./client/dist

ENV NODE_ENV=production
ENV PORT=3000
ENV DB_PATH=/app/data/rackstack.db

LABEL org.opencontainers.image.source="https://github.com/NeverEndingCode/rackstack-server"
LABEL org.opencontainers.image.description="RackStack self-hosted server"
LABEL org.opencontainers.image.licenses="MIT"

VOLUME ["/app/data"]
EXPOSE 3000

CMD ["node", "server/index.js"]

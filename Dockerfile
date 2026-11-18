# SM Life Streaming — standalone copy (Render free tier, Docker + Bun)
#
# Build stage: install deps, build the client bundle + server bundle.
# Runtime stage: the two bundles, the shipped audio files, and node_modules
# (needed at runtime only for the @electric-sql/pglite test branch).

FROM oven/bun:1.3 AS build
WORKDIR /app
COPY package.json bun.lock ./
RUN bun install --frozen-lockfile
COPY . .
RUN bun run build

FROM oven/bun:1.3-slim
WORKDIR /app
ENV NODE_ENV=production
COPY --from=build /app/package.json /app/bun.lock ./
COPY --from=build /app/node_modules ./node_modules
COPY --from=build /app/server ./server
COPY --from=build /app/client/dist ./client/dist
# The server refuses to start in production without OWNER_PASS (see
# server/src/server.ts) — set it in the Render dashboard, Environment tab.
CMD ["bun", "./server/dist/server.js"]

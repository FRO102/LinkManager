FROM node:20-alpine AS builder

WORKDIR /app

# better-sqlite3 ships a native addon; if no prebuilt binary matches this
# platform it falls back to compiling from source. python3/make/g++ are the
# toolchain that build requires — kept in a separate "builder" stage so the
# final image doesn't carry them. package.json pins better-sqlite3 to an
# exact version known to support Node 20.x (this image's base) — bumping it
# without checking its `engines` field can silently break this build.
RUN apk add --no-cache python3 make g++

COPY package.json package-lock.json ./
RUN npm ci --omit=dev

FROM node:20-alpine

WORKDIR /app

# Copy the already-compiled node_modules from the builder stage instead of
# reinstalling here — keeps the final image free of the build toolchain.
COPY --from=builder /app/node_modules ./node_modules
COPY package.json ./

# Copy the rest of the app's code
COPY server.js ./
COPY lib ./lib
COPY routes ./routes
COPY public ./public

# Folder where the database (links.db) will be persisted
RUN mkdir -p /app/data
ENV DATA_DIR=/app/data
ENV PORT=3000

EXPOSE 3000

HEALTHCHECK --interval=30s --timeout=3s --start-period=5s --retries=3 \
  CMD node -e "require('http').get('http://localhost:3000/api/health', r => process.exit(r.statusCode === 200 ? 0 : 1)).on('error', () => process.exit(1))"

CMD ["node", "server.js"]

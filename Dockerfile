# Stage 1: build
FROM node:22-alpine AS builder

# Install build tools needed for better-sqlite3 native addon
RUN apk add --no-cache python3 make g++

WORKDIR /app

COPY package*.json ./
RUN npm ci

COPY tsconfig.json ./
COPY src/ ./src/

RUN npm run build

# Stage 2: production image
FROM node:22-alpine AS production

ENV NODE_ENV=production

WORKDIR /app

COPY package*.json ./

# Install build tools, compile native addons, then remove build tools
RUN apk add --no-cache --virtual .build-deps python3 make g++ \
    && npm ci --omit=dev \
    && apk del .build-deps

# Copy compiled output from builder
COPY --from=builder /app/dist ./dist

# Create non-root user and data directory
RUN addgroup -S sorokeep && adduser -S sorokeep -G sorokeep \
    && mkdir -p /home/sorokeep/.sorokeep \
    && chown -R sorokeep:sorokeep /home/sorokeep /app

USER sorokeep

# Persist SQLite database across container restarts
VOLUME ["/home/sorokeep/.sorokeep"]

ENTRYPOINT ["node", "/app/dist/index.js"]

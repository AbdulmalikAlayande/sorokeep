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

# Install runtime native-addon deps
RUN apk add --no-cache python3 make g++

WORKDIR /app

COPY package*.json ./
RUN npm ci --omit=dev

# Copy compiled output from builder
COPY --from=builder /app/dist ./dist

# Create non-root user and data directory
RUN addgroup -S sorokeep && adduser -S sorokeep -G sorokeep \
    && mkdir -p /home/sorokeep/.sorokeep \
    && chown -R sorokeep:sorokeep /home/sorokeep /app

USER sorokeep

# Persist SQLite database across container restarts
VOLUME ["/home/sorokeep/.sorokeep"]

# Future dashboard / MCP server port
EXPOSE 3000

ENTRYPOINT ["node", "/app/dist/index.js"]

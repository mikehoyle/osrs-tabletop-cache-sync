# Stage 1: Build
FROM node:20-slim AS builder

WORKDIR /app

# Copy package files and install dependencies
COPY package*.json ./
RUN npm install

# Copy source code and build
COPY . .
RUN npm run build

# Stage 2: Run
FROM node:20-slim

WORKDIR /app

# Only copy the compiled JS and production dependencies
COPY --from=builder /app/dist ./dist
COPY --from=builder /app/package*.json ./
RUN npm install --omit=dev

CMD ["node", "dist/update-caches.js"]

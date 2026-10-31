FROM node:22-alpine AS deps
WORKDIR /app
RUN apk add --no-cache python3 make g++
COPY package*.json ./
RUN npm ci --omit=dev

FROM node:22-alpine AS web
WORKDIR /app
COPY package*.json ./
# Build tooling only: skip install scripts so better-sqlite3 is not compiled here (it is built in the deps stage).
RUN npm ci --ignore-scripts
COPY tsconfig.json vite.config.ts ./
COPY web ./web
COPY public ./public
RUN npm run build:web

FROM node:22-alpine
ENV NODE_ENV=production \
    DATA_DIR=/app/data
WORKDIR /app
COPY --from=deps /app/node_modules ./node_modules
COPY package*.json ./
COPY src ./src
COPY public ./public
COPY --from=web /app/public/*.js /app/public/*.css ./public/
RUN mkdir -p /app/data && chown -R 1000:1000 /app/data
USER 1000:1000
EXPOSE 3000
HEALTHCHECK --interval=30s --timeout=5s --retries=3 \
  CMD node -e "fetch('http://127.0.0.1:3000/healthz').then(r=>process.exit(r.ok?0:1)).catch(()=>process.exit(1))"
CMD ["node", "src/index.js"]

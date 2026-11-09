# school-service: збірка TypeScript в окремому етапі, у фінальному образі — лише dist і прод-залежності.
FROM node:24-bookworm-slim AS build
WORKDIR /app
COPY package.json package-lock.json ./
RUN npm ci
COPY tsconfig.json tsconfig.build.json ./
COPY src ./src
RUN npm run build && npm prune --omit=dev

FROM node:24-bookworm-slim
ENV NODE_ENV=production
WORKDIR /app
COPY --from=build /app/package.json ./
COPY --from=build /app/node_modules ./node_modules
COPY --from=build /app/dist ./dist
USER node
# 3002 — публічний API (через шлюз), 3102 — /internal/v1 (лише мережа compose, шлюз туди не веде).
EXPOSE 3002 3102
HEALTHCHECK --interval=10s --timeout=3s --start-period=10s --retries=6 \
  CMD ["node", "-e", "fetch('http://127.0.0.1:' + (process.env.PORT || 3002) + '/health').then((r) => process.exit(r.ok ? 0 : 1)).catch(() => process.exit(1))"]
# Міграції — окремою командою роллю school_owner: docker run ... node dist/migrate.js
CMD ["node", "dist/server.js"]

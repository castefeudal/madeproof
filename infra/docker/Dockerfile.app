# syntax=docker/dockerfile:1.7
FROM node:24.20.0-bookworm-slim AS build
WORKDIR /src
COPY package.json package-lock.json ./
RUN npm install --ignore-scripts
COPY . .
RUN npm run build && npm prune --omit=dev
FROM node:24.20.0-bookworm-slim AS runtime
ENV NODE_ENV=production
WORKDIR /app
COPY --from=build --chown=node:node /src/package.json /src/package-lock.json ./
COPY --from=build --chown=node:node /src/node_modules ./node_modules
COPY --from=build --chown=node:node /src/dist ./dist
COPY --from=build --chown=node:node /src/packages/db/migrations ./packages/db/migrations
COPY --from=build --chown=node:node /src/apps/web/public ./apps/web/public
COPY --from=build --chown=node:node /src/examples/demo-target ./examples/demo-target
USER node
EXPOSE 3210
HEALTHCHECK --interval=30s --timeout=5s --start-period=10s --retries=3 CMD ["node","-e","fetch('http://127.0.0.1:3210/health/live').then(r=>{if(!r.ok)process.exit(1)}).catch(()=>process.exit(1))"]
CMD ["node","dist/apps/api/src/main.js"]

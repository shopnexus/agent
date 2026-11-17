# The agent service's image. The build stage compiles the TypeScript and
# generates the Prisma client; the runtime stage keeps dist/, the production
# dependencies and prisma/ for `prisma migrate deploy`, and runs as node.
FROM node:24.21.0-trixie-slim AS build
WORKDIR /app
COPY package.json package-lock.json ./
RUN npm ci
COPY tsconfig.json nest-cli.json ./
COPY prisma ./prisma
COPY src ./src
RUN npx prisma generate && npm run build && npm prune --omit=dev

FROM node:24.21.0-trixie-slim
WORKDIR /app
ENV NODE_ENV=production
# Keeps the Prisma CLI from calling its update check at start.
ENV CHECKPOINT_DISABLE=1
COPY --from=build /app/package.json ./
COPY --from=build /app/node_modules ./node_modules
COPY --from=build /app/dist ./dist
COPY --from=build /app/prisma ./prisma
# node, by uid, so a cluster's runAsNonRoot can check it.
USER 1000:1000
EXPOSE 3000
CMD ["node", "dist/main.js"]

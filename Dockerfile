# The agent runtime's image. The build stage compiles the TypeScript; the
# runtime stage keeps dist/ and the production dependencies and runs as node.
FROM node:24.21.0-trixie-slim AS build
WORKDIR /app
COPY package.json package-lock.json ./
RUN npm ci
COPY tsconfig.json nest-cli.json ./
COPY src ./src
RUN npm run build && npm prune --omit=dev

FROM node:24.21.0-trixie-slim
WORKDIR /app
ENV NODE_ENV=production
COPY --from=build /app/package.json ./
COPY --from=build /app/node_modules ./node_modules
COPY --from=build /app/dist ./dist
# node, by uid, so a cluster's runAsNonRoot can check it.
USER 1000:1000
EXPOSE 3000
CMD ["node", "dist/main.js"]

FROM node:24-slim AS build

WORKDIR /app
COPY package.json package-lock.json tsconfig.base.json ./
COPY apps/operator-web/package.json apps/operator-web/package.json
RUN npm ci
COPY apps/operator-web apps/operator-web
RUN npm run build --workspace @bes/operator-web

FROM node:24-slim
WORKDIR /app
ENV NODE_ENV=production
COPY --from=build /app/node_modules ./node_modules
COPY --from=build /app/apps/operator-web/dist ./dist
CMD ["node", "dist/server.js"]

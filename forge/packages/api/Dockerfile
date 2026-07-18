# V1 dev-mode image — runs TypeScript directly via tsx, no build step.
# A production image would add a `tsc -b` build stage per package and run
# the compiled JS instead; out of scope for the V1 scaffold.
FROM node:20-slim
WORKDIR /app

COPY package.json package-lock.json* ./
COPY packages/shared/package.json packages/shared/
COPY packages/db/package.json packages/db/
COPY packages/worker/package.json packages/worker/
COPY packages/api/package.json packages/api/
RUN npm install

COPY packages/shared packages/shared
COPY packages/db packages/db
COPY packages/worker packages/worker
COPY packages/api packages/api

WORKDIR /app/packages/api
EXPOSE 8787
CMD ["npx", "tsx", "src/server.ts"]

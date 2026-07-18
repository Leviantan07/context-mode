# V1 dev-mode image — see packages/api/Dockerfile for the same caveat.
# Not used by docker-compose.yml today (the API calls the worker in-process
# for V1 — see docs/ARCHITECTURE.md); kept ready for when dispatch moves to
# a real queue and the worker becomes its own container.
FROM node:20-slim
WORKDIR /app

COPY package.json package-lock.json* ./
COPY packages/shared/package.json packages/shared/
COPY packages/db/package.json packages/db/
COPY packages/worker/package.json packages/worker/
RUN npm install

COPY packages/shared packages/shared
COPY packages/db packages/db
COPY packages/worker packages/worker

WORKDIR /app/packages/worker
CMD ["npx", "tsx", "src/worker.ts"]

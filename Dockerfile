FROM node:24.21.0-bookworm-slim
RUN apt-get update && apt-get install -y --no-install-recommends git ca-certificates && rm -rf /var/lib/apt/lists/*
WORKDIR /opt/diabagent
COPY sim/package.json sim/package-lock.json ./sim/
RUN npm ci --prefix sim
COPY . .
RUN node scripts/benchmark.mjs verify
CMD ["node", "scripts/benchmark.mjs", "verify"]

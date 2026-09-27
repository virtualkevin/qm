FROM node:24-bookworm-slim

RUN apt-get update && apt-get install -y --no-install-recommends ca-certificates curl git docker.io util-linux python3 && rm -rf /var/lib/apt/lists/*

WORKDIR /app
COPY package.json package-lock.json ./
COPY .husky/install.mjs .husky/install.mjs
COPY cli/package.json cli/package.json
RUN npm ci --no-audit --no-fund
RUN npm install --global memorable-cli@0.5.30 --no-audit --no-fund
COPY plugins/web-ui/package.json plugins/web-ui/package-lock.json plugins/web-ui/
COPY plugins/admin/package.json plugins/admin/package-lock.json plugins/admin/
RUN npm ci --prefix plugins/web-ui --no-audit --no-fund && npm ci --prefix plugins/admin --no-audit --no-fund
COPY deploy/connector-sdk deploy/connector-sdk
RUN npm ci --prefix deploy/connector-sdk --ignore-scripts --no-audit --no-fund && node deploy/connector-sdk/build.mjs
COPY . .
ENV NODE_ENV=development
CMD ["node", "src/index.ts"]

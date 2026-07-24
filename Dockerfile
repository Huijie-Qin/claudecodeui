# syntax=docker/dockerfile:1.7

ARG HWY_DOCKER_REGISTRY=swr.cn-north-4.myhuaweicloud.com/docker.io/library
ARG HWY_NODE_IMAGE=node:22-bookworm-slim
ARG HWY_DOCKER_CLI_IMAGE=docker:29-cli

FROM ${HWY_DOCKER_REGISTRY}/${HWY_NODE_IMAGE} AS builder

WORKDIR /app

# The postinstall lifecycle script references this file, so copy it before npm ci.
COPY package.json package-lock.json ./
COPY scripts/fix-node-pty.js ./scripts/fix-node-pty.js
RUN HUSKY=0 npm ci

COPY . .
# Docker mode always supplies its own Claude wrapper, so the SDK's large
# platform-native CLI packages are not used in the application container.
RUN npm run build \
    && HUSKY=0 npm prune --omit=dev \
    && rm -rf node_modules/@anthropic-ai/claude-agent-sdk-linux-*


FROM ${HWY_DOCKER_REGISTRY}/${HWY_DOCKER_CLI_IMAGE} AS docker-cli


FROM ${HWY_DOCKER_REGISTRY}/${HWY_NODE_IMAGE} AS runtime

ENV NODE_ENV=production \
    HOST=0.0.0.0 \
    SERVER_PORT=3001 \
    HOME=/home/cloudcli

# The daemon remains on the host and is reached through /var/run/docker.sock.
# The official current CLI is copied below because Debian Bookworm's 20.10 client
# does not implement the JSON stats format used by the runtime monitor.
RUN apt-get update \
    && apt-get install -y --no-install-recommends \
        bash \
        ca-certificates \
        git \
        gosu \
        openssh-client \
        python3 \
    && rm -rf /var/lib/apt/lists/*

WORKDIR /app
COPY --from=docker-cli /usr/local/bin/docker /usr/local/bin/docker
COPY --from=builder /app/package.json /app/package-lock.json ./
COPY --from=builder /app/node_modules ./node_modules
COPY --from=builder /app/dist ./dist
COPY --from=builder /app/dist-server ./dist-server
COPY --from=builder /app/public ./public
COPY --from=builder /app/scripts ./scripts
COPY scripts/docker-entrypoint.sh /usr/local/bin/cloudcli-docker-entrypoint

RUN chmod 0755 /usr/local/bin/cloudcli-docker-entrypoint \
    && mkdir -p /home/cloudcli \
    && chown node:node /home/cloudcli

EXPOSE 3001

ENTRYPOINT ["cloudcli-docker-entrypoint"]
CMD ["node", "dist-server/server/index.js"]

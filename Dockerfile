# The public SWR mirror exposes the AMD64 images used by this deployment.
ARG HWY_DOCKER_REGISTRY=swr.cn-north-4.myhuaweicloud.com/ddn-k8s/docker.io
ARG HWY_NODE_IMAGE=node:22-bookworm-slim
ARG HWY_DOCKER_CLI_IMAGE=docker:29-cli
ARG HWY_PLATFORM=linux/amd64

FROM --platform=${HWY_PLATFORM} ${HWY_DOCKER_REGISTRY}/${HWY_NODE_IMAGE} AS node-base

ARG APT_DEBIAN_MIRROR=http://deb.debian.org/debian
ARG APT_DEBIAN_SECURITY_MIRROR=http://deb.debian.org/debian-security

# Configure the Debian sources once so both the native-module builder and the
# final runtime use the mirrors supplied by the build host.
RUN set -eux; \
    test -n "$APT_DEBIAN_MIRROR"; \
    test -n "$APT_DEBIAN_SECURITY_MIRROR"; \
    sources_file=/etc/apt/sources.list.d/debian.sources; \
    test -f "$sources_file"; \
    sed -Ei \
        -e "s|^URIs: https?://deb[.]debian[.]org/debian$|URIs: $APT_DEBIAN_MIRROR|" \
        -e "s|^URIs: https?://deb[.]debian[.]org/debian-security$|URIs: $APT_DEBIAN_SECURITY_MIRROR|" \
        "$sources_file"; \
    grep -Fqx "URIs: $APT_DEBIAN_MIRROR" "$sources_file"; \
    grep -Fqx "URIs: $APT_DEBIAN_SECURITY_MIRROR" "$sources_file"


FROM node-base AS builder

ARG NPM_REGISTRY=https://registry.npmjs.org/
ARG NPM_STRICT_SSL=false

WORKDIR /app

# Prebuilt native modules can be unavailable on isolated networks. Keep the
# compiler toolchain in this throwaway stage so node-gyp can build from source.
RUN apt-get update \
    && apt-get install -y --no-install-recommends \
        build-essential \
        python3 \
    && rm -rf /var/lib/apt/lists/*

# The postinstall lifecycle script references this file, so copy it before npm ci.
COPY package.json package-lock.json ./
COPY scripts/fix-node-pty.js ./scripts/fix-node-pty.js
RUN test -n "$NPM_REGISTRY" \
    && test -f /usr/local/include/node/node.h \
    && HUSKY=0 \
        npm_config_python=/usr/bin/python3 \
        npm_config_nodedir=/usr/local \
        npm ci \
        --no-audit \
        --no-fund \
        --registry="$NPM_REGISTRY" \
        --replace-registry-host=always \
        --strict-ssl="$NPM_STRICT_SSL"

COPY . .
# Docker mode always supplies its own Claude wrapper, so the SDK's large
# platform-native CLI packages are not used in the application container.
RUN npm run build \
    && HUSKY=0 npm prune --omit=dev \
    && rm -rf node_modules/@anthropic-ai/claude-agent-sdk-linux-*


FROM --platform=${HWY_PLATFORM} ${HWY_DOCKER_REGISTRY}/${HWY_DOCKER_CLI_IMAGE} AS docker-cli


FROM node-base AS runtime

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

RUN sed -i 's/\r$//' /usr/local/bin/cloudcli-docker-entrypoint \
    && chmod 0755 /usr/local/bin/cloudcli-docker-entrypoint \
    && mkdir -p /home/cloudcli \
    && chown node:node /home/cloudcli

EXPOSE 3001

ENTRYPOINT ["/usr/local/bin/cloudcli-docker-entrypoint"]
CMD ["node", "dist-server/server/index.js"]

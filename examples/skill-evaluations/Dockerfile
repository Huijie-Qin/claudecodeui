# Build once; the evaluation worker never pulls images or installs dependencies.
FROM node:22-bookworm-slim
RUN apt-get update && apt-get install -y --no-install-recommends python3 \
    && rm -rf /var/lib/apt/lists/*
USER 1000:1000
WORKDIR /work
CMD ["sleep", "infinity"]

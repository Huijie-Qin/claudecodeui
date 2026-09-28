# Built once, optionally during backend startup. Evaluation containers use the same network and Claude CLI as sessions.
FROM docker.io/cloudcliai/sandbox:claude-code
USER root
RUN apt-get update && apt-get install -y --no-install-recommends python3 \
    && rm -rf /var/lib/apt/lists/*
USER 1000:1000
WORKDIR /work
CMD ["sleep", "infinity"]

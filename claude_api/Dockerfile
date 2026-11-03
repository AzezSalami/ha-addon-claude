# syntax=docker/dockerfile:1
# Hard-coded Debian (glibc) base; the Supervisor's BUILD_FROM would substitute an Alpine image.
FROM node:22-bookworm-slim

RUN set -eux; \
    apt-get update; \
    apt-get install -y --no-install-recommends ca-certificates jq tini; \
    rm -rf /var/lib/apt/lists/*; \
    npm install -g @anthropic-ai/claude-code

COPY server.js /app/server.js
COPY run.sh /run.sh
RUN chmod +x /run.sh

ENTRYPOINT ["/usr/bin/tini", "--"]
CMD ["/run.sh"]

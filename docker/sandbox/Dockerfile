# Agent Factory Sandbox Image
# Generic Node subprocess environment with security hardening.
# Built-in Agents run in the server's TypeScript loop, not this container.

FROM node:20-slim

# Security: run as non-root user
RUN groupadd -r agent && useradd -r -g agent -d /workspace -s /bin/bash agent

# Security: remove package managers to prevent escape
RUN apt-get purge -y --auto-remove && \
    rm -rf /var/lib/apt/lists/*

# Default working directory
WORKDIR /workspace
RUN chown agent:agent /workspace

USER agent

# Health check
HEALTHCHECK --interval=30s --timeout=3s CMD echo ok

ENTRYPOINT []
CMD ["node"]

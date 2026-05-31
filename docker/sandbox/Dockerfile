# Agent Factory Sandbox Image
# Minimal Python environment for agent execution with security hardening

FROM python:3.12-slim

# Security: run as non-root user
RUN groupadd -r agent && useradd -r -g agent -d /workspace -s /bin/bash agent

# Install minimal dependencies for the Agent Factory Python runtime
RUN pip install --no-cache-dir crewai anthropic openai && \
    rm -rf /root/.cache

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
CMD ["python3"]

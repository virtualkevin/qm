FROM node:24-bookworm-slim
RUN apt-get update && apt-get install -y --no-install-recommends bash curl git python3 ca-certificates util-linux && rm -rf /var/lib/apt/lists/*
COPY aws/microvm-agent/agent.mjs /opt/microvm-agent/agent.mjs
WORKDIR /root
EXPOSE 8080
CMD ["node", "/opt/microvm-agent/agent.mjs"]

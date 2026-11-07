#!/bin/sh
# Run from the server/ folder on Windows (Git Bash): copies the app to Unraid, rebuilds and restarts the container.
set -e
HOST=${NF_HOST:-root@192.168.0.49}  # your Unraid box (override: NF_HOST=root@1.2.3.4 sh deploy.sh)
DIR=/mnt/user/appdata/nuniflix
ssh $HOST "mkdir -p $DIR/build $DIR/data && chown 99:100 $DIR/data"
tar -cf - Dockerfile requirements.txt app | ssh $HOST "rm -rf $DIR/build/* && tar -xf - -C $DIR/build"
ssh $HOST "cd $DIR/build && docker build -q -t nuniflix:latest . >/dev/null && \
  (docker rm -f nuniflix >/dev/null 2>&1 || true) && \
  docker run -d --name nuniflix --restart unless-stopped -p 8095:8000 -v $DIR/data:/data \
    --label net.unraid.docker.icon=https://cdn.jsdelivr.net/gh/homarr-labs/dashboard-icons/png/overseerr.png \
    --label net.unraid.docker.webui=http://[IP]:[PORT:8095]/ nuniflix:latest >/dev/null && echo deployed"

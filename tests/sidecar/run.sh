#!/usr/bin/env bash
# Runs the sidecar, as this chart renders it, in front of a real tile server
# and database, and runs the tests in this directory against it.
#
# Needs docker, helm and node. Images can be chosen with TILE_SERVER_IMAGE,
# POSTGIS_IMAGE and NGINX_IMAGE.
set -euo pipefail

here="$(cd "$(dirname "${BASH_SOURCE[0]}")" && pwd)"
chart="$(cd "$here/../.." && pwd)"

TILE_SERVER_IMAGE="${TILE_SERVER_IMAGE:-onaio/dirt-tile-server:latest}"
POSTGIS_IMAGE="${POSTGIS_IMAGE:-postgis/postgis:16-3.4}"
NGINX_IMAGE="${NGINX_IMAGE:-nginx:1.30.5-alpine}"
SIDECAR_PORT="${SIDECAR_PORT:-58080}"
TILE_SERVER_PORT="${TILE_SERVER_PORT:-53000}"
PERMISSIONS_PORT="${PERMISSIONS_PORT:-58000}"

prefix="sidecar-test-$$"
network="$prefix"
work="$(mktemp -d)"

cleanup() {
    docker rm -f "$prefix-proxy" "$prefix-tiles" "$prefix-permissions" "$prefix-database" >/dev/null 2>&1 || true
    docker network rm "$network" >/dev/null 2>&1 || true
    rm -rf "$work"
}
trap cleanup EXIT

helm template dirt-tile-server "$chart" -f "$here/values.yaml" \
    --show-only templates/sidecar-configmap.yaml \
    | awk 'found { sub(/^    /, ""); print } /^  nginx.conf: \|/ { found = 1 }' \
    > "$work/nginx.conf"

docker network create "$network" >/dev/null

# Both spellings of each setting are given, for the images that differ on them.
docker run -d --name "$prefix-database" --network "$network" --network-alias database \
    -e POSTGRES_USER=tiles \
    -e POSTGRES_PASSWORD=tiles -e POSTGRES_PASS=tiles \
    -e POSTGRES_DB=tiles -e POSTGRES_DBNAME=tiles \
    "$POSTGIS_IMAGE" >/dev/null

query() {
    docker exec -i -e PGPASSWORD=tiles "$prefix-database" \
        psql -q -v ON_ERROR_STOP=1 -h localhost -U tiles -d tiles "$@"
}

# Some images start the database, stop it and start it again while setting
# up, so being answered once does not mean it is ready. Loading the fixture
# starts by dropping what it creates, and is tried until it goes through.
for _ in $(seq 1 90); do
    if query < "$here/fixture.sql" >/dev/null 2>&1 \
        && query -c "SELECT count(*) FROM logger_instance" >/dev/null 2>&1; then
        loaded=1
        break
    fi
    sleep 1
done
[ "${loaded:-0}" = 1 ] || { echo "the database did not start" >&2; exit 1; }

docker run -d --name "$prefix-permissions" --network "$network" --network-alias permissions \
    -p "127.0.0.1:$PERMISSIONS_PORT:8000" \
    -v "$here/permissions.js:/permissions.js:ro" \
    --entrypoint node "$TILE_SERVER_IMAGE" /permissions.js >/dev/null

# The sidecar joins this container's network, as it would in a pod, so its
# port is published here.
docker run -d --name "$prefix-tiles" --network "$network" \
    -p "127.0.0.1:$TILE_SERVER_PORT:3000" -p "127.0.0.1:$SIDECAR_PORT:8080" \
    -e POSTGRES_CONNECTION="postgres://tiles:tiles@database:5432/tiles" \
    -e TABLE_NAME=logger_instance -e TABLE_COLUMN=geom \
    -e ONADATA_URL=http://permissions:8000 \
    -e FORMS_ENDPOINT=/api/v1/forms/ \
    -e DATAVIEWS_ENDPOINT=/api/v1/dataviews/ \
    -e MERGED_DATASETS_ENDPOINT=/api/v1/merged-datasets/ \
    -e CORS_ORIGINS="https://first.example.test,https://second.example.test" \
    -e SERVER_LOGGER=true \
    "$TILE_SERVER_IMAGE" >/dev/null

# Run as the chart runs it: an unprivileged user, nothing writable but the
# volume its caches live on.
docker run -d --name "$prefix-proxy" --network "container:$prefix-tiles" \
    --user 101:101 --read-only --tmpfs /tmp:uid=101,gid=101 \
    --cap-drop ALL --security-opt no-new-privileges \
    -v "$work/nginx.conf:/etc/nginx/nginx.conf:ro" \
    "$NGINX_IMAGE" >/dev/null

for _ in $(seq 1 60); do
    if curl -fs "http://127.0.0.1:$SIDECAR_PORT/health-check" >/dev/null 2>&1; then
        serving=1
        break
    fi
    sleep 1
done
if [ "${serving:-0}" != 1 ]; then
    echo "the sidecar did not start" >&2
    docker logs "$prefix-proxy" >&2 || true
    docker logs "$prefix-tiles" >&2 || true
    exit 1
fi

SIDECAR_URL="http://127.0.0.1:$SIDECAR_PORT" \
TILE_SERVER_URL="http://127.0.0.1:$TILE_SERVER_PORT" \
PERMISSIONS_URL="http://127.0.0.1:$PERMISSIONS_PORT" \
PROXY_CONTAINER="$prefix-proxy" \
    node --test --test-concurrency=1 "$here"/*.test.js

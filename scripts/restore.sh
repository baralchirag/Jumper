#!/usr/bin/env bash
# Restore a backup made by scripts/backup.sh into a docker-compose deployment.
#
#   scripts/restore.sh <backup-dir>
#
# This REPLACES the current database and repositories. Run it on a fresh or stopped stack:
#   docker compose -f docker/docker-compose.yml up -d postgres redis minio   # start only the data services
#   scripts/restore.sh backups/20260101-120000
#   docker compose -f docker/docker-compose.yml up -d                         # then everything else
set -euo pipefail

DIR=${1:?usage: scripts/restore.sh <backup-dir>}
COMPOSE=(docker compose -f docker/docker-compose.yml)
PROJECT=${COMPOSE_PROJECT_NAME:-pcbhub}

[ -f "$DIR/database.dump" ] || { echo "no database.dump in $DIR" >&2; exit 1; }
(cd "$DIR" && sha256sum -c SHA256SUMS)

read -r -p "This overwrites the current database and repositories. Type 'restore' to continue: " ok
[ "$ok" = restore ] || { echo "aborted"; exit 1; }

"${COMPOSE[@]}" stop api worker web 2>/dev/null || true

echo "→ database"
"${COMPOSE[@]}" exec -T postgres dropdb -U pcbhub --if-exists pcbhub
"${COMPOSE[@]}" exec -T postgres createdb -U pcbhub pcbhub
"${COMPOSE[@]}" exec -T postgres pg_restore -U pcbhub -d pcbhub --no-owner < "$DIR/database.dump"

for vol in repos miniodata; do
  [ -f "$DIR/$vol.tgz" ] || continue
  echo "→ volume $vol"
  docker run --rm -v "${PROJECT}_${vol}:/data" -v "$(cd "$DIR" && pwd):/in:ro" alpine \
    sh -c "rm -rf /data/* /data/.[!.]* 2>/dev/null; tar xzf /in/${vol}.tgz -C /data"
done
echo "✓ restored. Start the rest of the stack: ${COMPOSE[*]} up -d"

#!/usr/bin/env bash
# Back up a docker-compose deployment: database, git repositories and stored artifacts, into one folder.
#
#   scripts/backup.sh [output-dir]        (default: ./backups/<timestamp>)
#
# Run it from the repository root on the host that runs `docker compose`. Safe to run while the site is up:
# the database is dumped transactionally and git repositories are copied atomically per file.
set -euo pipefail

COMPOSE=(docker compose -f docker/docker-compose.yml)
PROJECT=${COMPOSE_PROJECT_NAME:-pcbhub}
OUT=${1:-backups/$(date +%Y%m%d-%H%M%S)}
mkdir -p "$OUT"

echo "→ database"
"${COMPOSE[@]}" exec -T postgres pg_dump -U pcbhub -Fc pcbhub > "$OUT/database.dump"

for vol in repos miniodata; do
  echo "→ volume $vol"
  docker run --rm -v "${PROJECT}_${vol}:/data:ro" -v "$(cd "$OUT" && pwd):/out" alpine \
    tar czf "/out/${vol}.tgz" -C /data .
done

# A backup you cannot read back is not a backup.
pg_check=$("${COMPOSE[@]}" exec -T postgres pg_restore --list < "$OUT/database.dump" | wc -l)
[ "$pg_check" -gt 10 ] || { echo "database dump looks empty" >&2; exit 1; }
tar tzf "$OUT/repos.tgz" > /dev/null

(cd "$OUT" && sha256sum database.dump repos.tgz miniodata.tgz > SHA256SUMS)
echo "✓ backup written to $OUT ($(du -sh "$OUT" | cut -f1))"

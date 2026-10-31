#!/bin/sh
# Regenerates the 0.2.0 cache fixtures of keep-cursors-on-upgrade
# (src/store/__tests__/v020-cache.ts documents what the tests rely on).
#
# Usage, from the repository root, after `npm run build` (the script uses
# the built library only to encode the event files that 0.2.0 cannot
# write: ticket.supersede, ticket.reconcile, ticket.renumber and the
# "late" comment; every cache row is written by 0.2.0 itself):
#
#   sh src/store/__tests__/fixtures/v020-cache/make-fixture.sh
#
# The published 0.2.0 runs as `npx -y @bendechrai/agentboard@0.2.0`, or as
# the command in AGENTBOARD_020 (for example AGENTBOARD_020=agentboard when
# 0.2.0 is installed on the PATH); the script stops unless that command
# reports version 0.2.0. It never touches a board other than the two
# scratch boards it creates under a temporary directory.
#
# Each 0.2.0 command runs with a clock preload (NODE_OPTIONS --import) that
# sets Date.now to BASE plus the minute offset given for that command plus
# the real time elapsed in the process, so event walls are spread over more
# than three hours whatever the real time. After the last command the
# script checkpoints the WAL (PRAGMA wal_checkpoint(TRUNCATE)) with
# node:sqlite and copies `events/` and `cache.sqlite` into
#
#   plain/    only events 0.2.0 knows; cursors of alice (inbox at minute
#             35) and bob (inbox at minute 185); carol never ran inbox;
#             late/ holds one comment at minute 20 that is NOT in events/
#             (an event file the 0.2.0 cache never recorded)
#   unknown/  a ticket.supersede (minute 10), a ticket.reconcile (minute
#             15) and a ticket.renumber (minute 150), recorded by 0.2.0
#             as unknown kinds; cursors of carol (inbox at minute 55),
#             alice (minute 175) and bob (minute 185)
#
# Ticket ids (ULIDs) are random, so a regenerated fixture differs from the
# committed one in ids and hashes; the tests read ids, hashes and the old
# rows from the fixture itself and never hard-code them.

set -eu

HERE=$(cd "$(dirname "$0")" && pwd)
ROOT=$(cd "$HERE/../../../../.." && pwd)
DIST="$ROOT/dist/index.js"
if [ ! -f "$DIST" ]; then
  echo "make-fixture: $DIST is missing; run npm run build first" >&2
  exit 1
fi
AB=${AGENTBOARD_020:-npx -y @bendechrai/agentboard@0.2.0}
VERSION=$($AB version)
if [ "$VERSION" != "0.2.0" ]; then
  echo "make-fixture: '$AB version' printed '$VERSION', expected 0.2.0" >&2
  exit 1
fi

WORK=$(mktemp -d)
trap 'rm -rf "$WORK"' EXIT

cat > "$WORK/clock.mjs" <<'EOF'
const base = 1_790_000_000_000;
const offset = Number(process.env.FIXTURE_MINUTE ?? '0') * 60_000;
const real = Date.now.bind(Date);
const start = real();
Date.now = () => base + offset + (real() - start);
EOF

# ab <board root> <minute> <args...>: one 0.2.0 command at that minute.
ab() {
  dir=$1
  minute=$2
  shift 2
  (cd "$dir" && FIXTURE_MINUTE=$minute NODE_OPTIONS="--import=file://$WORK/clock.mjs" \
    NODE_NO_WARNINGS=1 $AB "$@")
}

# put <events dir> <json of the event>: writes a canonical event file with
# the built library and prints its hash.
put() {
  node --input-type=module -e "
    import { canonicalEncode, sha256Hex, validateEvent } from '$DIST';
    import { writeFileSync } from 'node:fs';
    const event = JSON.parse(process.argv[2]);
    const check = validateEvent(event);
    if (!check.ok) { throw new Error(JSON.stringify(check)); }
    const bytes = canonicalEncode(event);
    const hash = sha256Hex(bytes);
    writeFileSync(process.argv[1] + '/' + hash + '.json', bytes);
    console.log(hash);
  " "$1" "$2"
}

# wall <minute>: the wall of a hand-written event at that minute.
wall() {
  echo $((1790000000000 + $1 * 60000))
}

# id <json>: the ticket id of a `new --json` result.
id() {
  node -e "console.log(JSON.parse(process.argv[1]).ticket.id)" "$1"
}

checkpoint() {
  node -e "
    const { DatabaseSync } = require('node:sqlite');
    const db = new DatabaseSync(process.argv[1]);
    db.exec('PRAGMA wal_checkpoint(TRUNCATE)');
    db.close();
  " "$1"
}

save() {
  board=$1
  out=$2
  checkpoint "$board/.board/cache.sqlite"
  rm -rf "$out/events" "$out/cache.sqlite"
  mkdir -p "$out"
  cp -R "$board/.board/events" "$out/events"
  cp "$board/.board/cache.sqlite" "$out/cache.sqlite"
}

# --- plain ---------------------------------------------------------------
P="$WORK/plain"
mkdir -p "$P/.board/events"
T1=$(id "$(ab "$P" 0 new First --change demo --group 1 --checklist one --as orch --json)")
T2=$(id "$(ab "$P" 5 new Second --adhoc fixture --as orch --json)")
ab "$P" 10 comment "$T1" "minute 10" --as impl >/dev/null
ab "$P" 30 comment "$T2" "minute 30" --as impl >/dev/null
ab "$P" 35 inbox --as alice >/dev/null
for m in 45 60 75 90 105 120 140 160 180; do
  ab "$P" "$m" comment "$T1" "minute $m" --as impl >/dev/null
done
ab "$P" 185 inbox --as bob >/dev/null
ab "$P" 190 comment "$T2" "minute 190" --as orch >/dev/null
mkdir -p "$WORK/late"
put "$WORK/late" "{\"v\":1,\"kind\":\"ticket.comment\",\"ticket\":\"$T1\",\"actor\":\"impl\",\"ts\":{\"wall\":$(wall 20),\"counter\":0,\"actor\":\"impl\"},\"body\":{\"text\":\"late note\"}}" >/dev/null
save "$P" "$HERE/plain"
rm -rf "$HERE/plain/late"
cp -R "$WORK/late" "$HERE/plain/late"

# --- unknown -------------------------------------------------------------
U="$WORK/unknown"
E="$U/.board/events"
mkdir -p "$E"
U2=$(id "$(ab "$U" 0 new Superseded --change demo --group 2 --as orch --json)")
put "$E" "{\"v\":1,\"kind\":\"ticket.supersede\",\"ticket\":\"$U2\",\"actor\":\"orch\",\"ts\":{\"wall\":$(wall 10),\"counter\":0,\"actor\":\"orch\"},\"body\":{\"reason\":\"group removed from tasks.md\"}}" >/dev/null
U1=$(id "$(ab "$U" 12 new Kept --change demo --group 1 --checklist one --checklist two --as orch --json)")
put "$E" "{\"v\":1,\"kind\":\"ticket.reconcile\",\"ticket\":\"$U1\",\"actor\":\"orch\",\"ts\":{\"wall\":$(wall 15),\"counter\":0,\"actor\":\"orch\"},\"body\":{\"title\":\"Kept, retitled\",\"updated\":[],\"removed\":[1],\"added\":[],\"forced\":false,\"source\":\"openspec:demo\"}}" >/dev/null
for m in 20 35 50; do
  ab "$U" "$m" comment "$U1" "minute $m" --as impl >/dev/null
done
ab "$U" 55 inbox --as carol >/dev/null
for m in 70 90 110 130; do
  ab "$U" "$m" comment "$U1" "minute $m" --as impl >/dev/null
done
put "$E" "{\"v\":1,\"kind\":\"ticket.renumber\",\"ticket\":\"$U1\",\"actor\":\"orch\",\"ts\":{\"wall\":$(wall 150),\"counter\":0,\"actor\":\"orch\"},\"body\":{\"from\":\"1\",\"to\":\"3\"}}" >/dev/null
for m in 160 170; do
  ab "$U" "$m" comment "$U1" "minute $m" --as impl >/dev/null
done
ab "$U" 175 inbox --as alice >/dev/null
ab "$U" 180 comment "$U1" "minute 180" --as impl >/dev/null
ab "$U" 185 inbox --as bob >/dev/null
ab "$U" 190 comment "$U1" "minute 190" --as orch >/dev/null
save "$U" "$HERE/unknown"

echo "make-fixture: wrote $HERE/plain and $HERE/unknown"

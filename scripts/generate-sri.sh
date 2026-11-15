#!/usr/bin/env bash
# Print the pinned jsDelivr <script> tag, with a SHA-384 SRI hash, for the
# browser snippet (dist/snippet.global.js).
#
# The hash always comes from an npm tarball, never from the network: a CDN
# error page or an empty body (sha384-OLBgp1Gs...) must never become the
# published integrity value. Adapted from getformo/sdk scripts/generate-sri.sh.
#
# Usage:
#   scripts/generate-sri.sh                         # npm pack this checkout (dry run)
#   scripts/generate-sri.sh --tarball pkg.tgz       # hash an existing tarball
#   scripts/generate-sri.sh --version 0.4.0         # download the published tarball from npm
#   scripts/generate-sri.sh --version 0.4.0 --check-registry --check-cdn
#
# Options:
#   --tarball FILE     Hash this tarball instead of packing or downloading one.
#   --version X.Y.Z    Version for the CDN URL; without --tarball, `npm pack` it from npm.
#   --check-registry   Poll npm until the registry's dist.integrity for the version
#                      equals this tarball's sha512 (proves it is the published one).
#   --check-cdn        Poll jsDelivr until it serves bytes identical to the tarball.
#   --attempts N       Poll attempts (default 20).  --interval S  Seconds between (default 30).
#
# The snippet goes to stdout; progress goes to stderr.
set -euo pipefail

# SRI_PACKAGE / SRI_FILE exist only to test the script against another published package.
PACKAGE="${SRI_PACKAGE:-@untitled-analytics/web}"
FILE="${SRI_FILE:-dist/snippet.global.js}"
TARBALL=""
VERSION=""
CHECK_REGISTRY=false
CHECK_CDN=false
ATTEMPTS=20
INTERVAL=30

log() { echo "$@" >&2; }
die() { log "Error: $*"; exit 1; }
sri() { openssl dgst "-$1" -binary "$2" | openssl base64 -A; }

while (($#)); do
  case "$1" in
    --tarball) TARBALL="${2:?--tarball needs a file}"; shift 2 ;;
    --version) VERSION="${2:?--version needs a value}"; shift 2 ;;
    --check-registry) CHECK_REGISTRY=true; shift ;;
    --check-cdn) CHECK_CDN=true; shift ;;
    --attempts) ATTEMPTS="${2:?}"; shift 2 ;;
    --interval) INTERVAL="${2:?}"; shift 2 ;;
    -h|--help) sed -n '2,23p' "$0" | sed 's/^# \{0,1\}//' >&2; exit 0 ;;
    *) die "unknown argument: $1" ;;
  esac
done
[[ "$ATTEMPTS" =~ ^[1-9][0-9]*$ ]] || die "--attempts must be a positive integer"
[[ "$INTERVAL" =~ ^[0-9]+$ ]] || die "--interval must be a whole number of seconds"
[[ -z "$VERSION" || "$VERSION" =~ ^[0-9]+\.[0-9]+\.[0-9]+(-[0-9A-Za-z.-]+)?$ ]] || die "invalid version: $VERSION"

WORK=$(mktemp -d)
trap 'rm -rf "$WORK"' EXIT

if [[ -z "$TARBALL" ]]; then
  if [[ -n "$VERSION" ]]; then
    log "Downloading published tarball $PACKAGE@$VERSION from npm"
    SPEC="$PACKAGE@$VERSION"
    (cd "$WORK" && npm pack "$SPEC" --silent >/dev/null) || die "could not download $SPEC from npm (is it published?)"
  else
    log "Packing this checkout (dry run; runs the prepare build)"
    ROOT=$(cd "$(dirname "$0")/.." && pwd)
    (cd "$ROOT" && npm pack --pack-destination "$WORK" --silent >/dev/null) || die "npm pack failed in $ROOT"
  fi
  shopt -s nullglob
  TARBALLS=("$WORK"/*.tgz)
  shopt -u nullglob
  ((${#TARBALLS[@]} == 1)) || die "expected exactly one tarball, found ${#TARBALLS[@]}"
  TARBALL="${TARBALLS[0]}"
fi
test -s "$TARBALL" || die "missing or empty tarball: $TARBALL"

mkdir "$WORK/extract"
tar -xzf "$TARBALL" -C "$WORK/extract"
BUNDLE="$WORK/extract/package/$FILE"
# An empty file hashes to sha384-OLBgp1Gs...; never publish that.
test -s "$BUNDLE" || die "missing or empty $FILE in $TARBALL"

PKG_JSON="$WORK/extract/package/package.json"
PKG_NAME=$(node -p "require(process.argv[1]).name" "$PKG_JSON")
PKG_VERSION=$(node -p "require(process.argv[1]).version" "$PKG_JSON")
[[ "$PKG_NAME" == "$PACKAGE" ]] || die "tarball is $PKG_NAME, expected $PACKAGE"
if [[ -n "$VERSION" ]]; then
  [[ "$PKG_VERSION" == "$VERSION" ]] || die "tarball version $PKG_VERSION does not match $VERSION"
else
  VERSION="$PKG_VERSION"
fi

HASH=$(sri sha384 "$BUNDLE")
log "Tarball: $TARBALL"
log "SRI:     sha384-$HASH"

if $CHECK_REGISTRY; then
  TARBALL_INTEGRITY="sha512-$(sri sha512 "$TARBALL")"
  REGISTRY_INTEGRITY=""
  for attempt in $(seq 1 "$ATTEMPTS"); do
    REGISTRY_INTEGRITY=$(npm view "$PACKAGE@$VERSION" dist.integrity 2>/dev/null || true)
    [[ "$REGISTRY_INTEGRITY" == "$TARBALL_INTEGRITY" ]] && break
    log "Attempt $attempt: registry integrity '${REGISTRY_INTEGRITY:-none}' does not match $TARBALL_INTEGRITY"
    ((attempt < ATTEMPTS)) && sleep "$INTERVAL"
  done
  [[ "$REGISTRY_INTEGRITY" == "$TARBALL_INTEGRITY" ]] || die "npm registry does not serve this tarball for $PACKAGE@$VERSION"
  log "Registry: tarball matches the published $PACKAGE@$VERSION"
fi

URL="https://cdn.jsdelivr.net/npm/$PACKAGE@$VERSION/$FILE"
if $CHECK_CDN; then
  CDN_HASH=""
  for attempt in $(seq 1 "$ATTEMPTS"); do
    rm -f "$WORK/cdn.js"
    if curl --fail --silent --show-error --location --max-time 60 -o "$WORK/cdn.js" "$URL" && test -s "$WORK/cdn.js"; then
      CDN_HASH=$(sri sha384 "$WORK/cdn.js")
      [[ "$CDN_HASH" == "$HASH" ]] && break
      log "Attempt $attempt: CDN hash sha384-$CDN_HASH does not match sha384-$HASH"
    else
      CDN_HASH=""
      log "Attempt $attempt: CDN fetch failed or returned an empty body"
    fi
    ((attempt < ATTEMPTS)) && sleep "$INTERVAL"
  done
  [[ "$CDN_HASH" == "$HASH" ]] || die "$URL did not serve the published bundle (sha384-$HASH) in time"
  log "CDN: $URL serves identical bytes"
fi

cat <<EOF
<script
  src="$URL"
  integrity="sha384-$HASH"
  crossorigin="anonymous"
  data-publishable-key="YOUR_PUBLISHABLE_KEY"
  data-endpoint="https://YOUR_COLLECTOR_ENDPOINT"
  defer
></script>
EOF

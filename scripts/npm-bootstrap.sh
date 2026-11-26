#!/usr/bin/env bash
# One-time setup of a new npm package for trusted publishing (RELEASING.md).
#
#   npm login
#   scripts/npm-bootstrap.sh @manalens/web
#
# npm adds a trusted publisher only to a package that exists. This publishes a
# placeholder (README only, version 0.0.0-bootstrap.0), deprecates it, and
# trusts .github/workflows/release.yml in the npm-publish environment. After
# that, the Release workflow publishes every version with OIDC and provenance.
set -euo pipefail

name="${1:-}"
case "$name" in
  @manalens/web|@manalens/node) ;;
  *) echo "usage: scripts/npm-bootstrap.sh @manalens/web|@manalens/node" >&2; exit 1 ;;
esac
version=0.0.0-bootstrap.0
npm whoami >/dev/null || { echo "Run npm login first." >&2; exit 1; }

if npm view "$name" version >/dev/null 2>&1; then
  echo "$name already exists on npm: skipping the placeholder."
else
  dir="$(mktemp -d)"
  trap 'rm -rf "$dir"' EXIT
  cat > "$dir/package.json" <<JSON
{
  "name": "$name",
  "version": "$version",
  "description": "Placeholder for trusted publishing setup. Use the latest version.",
  "license": "MIT",
  "repository": { "type": "git", "url": "git+https://github.com/manalens/manalens-js.git" },
  "files": ["README.md"]
}
JSON
  printf '# %s\n\nPlaceholder for the npm trusted publishing setup. Install the latest version.\n' "$name" > "$dir/README.md"
  (cd "$dir" && npm publish --access public --tag bootstrap)
fi

# A new package can take a few minutes to appear on the registry.
for _ in $(seq 1 60); do
  npm view "$name@$version" version >/dev/null 2>&1 && break
  echo "Waiting for npm to show $name@$version ..."; sleep 10
done
npm view "$name@$version" version >/dev/null 2>&1 || { echo "npm does not show $name@$version yet. Run this script again in a few minutes." >&2; exit 1; }
if [ -z "$(npm view "$name@$version" deprecated 2>/dev/null)" ]; then
  npm deprecate "$name@$version" "Placeholder. Install the latest version."
fi

npm trust github "$name" --repo manalens/manalens-js --file release.yml --env npm-publish --allow-publish --yes
npm trust list "$name"
echo "Done. Now set Publishing access to 'Require two-factor authentication and disallow tokens' on https://www.npmjs.com/package/$name/access"

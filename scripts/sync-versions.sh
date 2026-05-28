#!/usr/bin/env bash
# Bump every @strav/* package's version in lockstep.
# Usage:
#   ./scripts/sync-versions.sh patch        # 0.1.0 → 0.1.1
#   ./scripts/sync-versions.sh minor        # 0.1.0 → 0.2.0
#   ./scripts/sync-versions.sh major        # 0.1.0 → 1.0.0
#   ./scripts/sync-versions.sh set 0.2.0    # set every package to 0.2.0
#   ./scripts/sync-versions.sh set 1.0.0-alpha.1
#
# Excludes @strav/spring (versioned independently per spec/packages.md).

set -euo pipefail

RED=$'\033[0;31m'; GREEN=$'\033[0;32m'; YELLOW=$'\033[1;33m'
BLUE=$'\033[0;34m'; CYAN=$'\033[0;36m'; NC=$'\033[0m'

# ─── usage ─────────────────────────────────────────────────────────────────────
usage() {
  cat <<EOF
Usage:
  $0 patch                  Bump patch: 0.1.0 → 0.1.1
  $0 minor                  Bump minor: 0.1.0 → 0.2.0
  $0 major                  Bump major: 0.1.0 → 1.0.0
  $0 set <version>          Set every package to <version>
  $0 --help                 Show this help

Notes:
  - @strav/spring is excluded (independent versioning).
  - All other packages move in lockstep.
EOF
}

[[ $# -eq 0 ]] && { usage; exit 1; }

WORKSPACE_ROOT="$(cd "$(dirname "${BASH_SOURCE[0]}")/.." && pwd)"
cd "$WORKSPACE_ROOT"

if ! command -v jq &>/dev/null; then
  echo -e "${RED}❌ jq is required. Install via your package manager.${NC}"
  exit 1
fi

# ─── packages to bump (everything except spring) ───────────────────────────────
# Portable across bash 3 (macOS) and bash 4+.
PACKAGES=()
while IFS= read -r line; do PACKAGES+=("$line"); done \
  < <(find packages -mindepth 1 -maxdepth 1 -type d -not -name spring | sort)

(( ${#PACKAGES[@]} == 0 )) && { echo -e "${YELLOW}No packages found under packages/${NC}"; exit 0; }

# ─── determine target version ──────────────────────────────────────────────────
MODE="$1"
NEW_VERSION=""

# Pick reference version from first non-spring package
REF_PKG="${PACKAGES[0]}"
[[ ! -f "$REF_PKG/package.json" ]] && { echo -e "${RED}❌ $REF_PKG/package.json missing${NC}"; exit 1; }
CURRENT=$(jq -r '.version' "$REF_PKG/package.json")

case "$MODE" in
  patch|minor|major)
    # Parse semver core (strip prerelease tag if any)
    CORE="${CURRENT%%-*}"
    PRE="${CURRENT#"$CORE"}"
    IFS='.' read -ra PARTS <<< "$CORE"
    MAJ=${PARTS[0]:-0}; MIN=${PARTS[1]:-0}; PAT=${PARTS[2]:-0}
    case "$MODE" in
      patch) PAT=$((PAT + 1));;
      minor) MIN=$((MIN + 1)); PAT=0;;
      major) MAJ=$((MAJ + 1)); MIN=0; PAT=0;;
    esac
    # If bumping a release version, drop pre-release tag
    if [[ -n "$PRE" ]]; then
      echo -e "${YELLOW}Note: dropping pre-release tag '$PRE' from $CURRENT${NC}"
    fi
    NEW_VERSION="$MAJ.$MIN.$PAT"
    ;;
  set)
    [[ -z "${2:-}" ]] && { echo -e "${RED}❌ 'set' requires a version argument${NC}"; usage; exit 1; }
    NEW_VERSION="$2"
    ;;
  --help|-h)
    usage; exit 0 ;;
  *)
    echo -e "${RED}Unknown mode: $MODE${NC}"
    usage; exit 1 ;;
esac

echo -e "${CYAN}Bumping ${#PACKAGES[@]} packages: ${CURRENT} → ${NEW_VERSION}${NC}"
echo

# ─── apply ─────────────────────────────────────────────────────────────────────
UPDATED=0
for pkg_dir in "${PACKAGES[@]}"; do
  pkg_file="$pkg_dir/package.json"
  [[ ! -f "$pkg_file" ]] && continue

  name=$(jq -r '.name' "$pkg_file")
  old=$(jq -r '.version' "$pkg_file")

  tmp="${pkg_file}.tmp"
  jq --arg v "$NEW_VERSION" '.version = $v' "$pkg_file" > "$tmp"
  mv "$tmp" "$pkg_file"

  echo -e "  ${GREEN}✓${NC} $name: $old → $NEW_VERSION"
  UPDATED=$((UPDATED + 1))
done

echo
echo -e "${GREEN}🎉 Updated $UPDATED packages to $NEW_VERSION${NC}"
echo -e "${BLUE}Next: review with 'git diff', commit, tag.${NC}"

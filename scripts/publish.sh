#!/usr/bin/env bash
# Publish @strav/* packages to npm, in dependency order.
# Replaces workspace:* refs with concrete versions, publishes via bun publish,
# then restores the originals. Skips already-published versions and private packages.

set -euo pipefail

RED=$'\033[0;31m'; GREEN=$'\033[0;32m'; YELLOW=$'\033[1;33m'
BLUE=$'\033[0;34m'; CYAN=$'\033[0;36m'; NC=$'\033[0m'

# ─── args ──────────────────────────────────────────────────────────────────────
DRY_RUN=false
SKIP_CHECK=false
SPECIFIC_PACKAGES=""

while [[ $# -gt 0 ]]; do
  case $1 in
    --dry-run)    DRY_RUN=true; shift ;;
    --skip-check) SKIP_CHECK=true; shift ;;
    --package)    SPECIFIC_PACKAGES="$2"; shift 2 ;;
    --help|-h)
      cat <<EOF
Usage: $0 [options]

Options:
  --dry-run             Test without publishing
  --skip-check          Skip npm login verification
  --package <names>     Comma-separated subset to publish (e.g. kernel,http)
  --help, -h            Show this help

Examples:
  $0                                  # publish all packages
  $0 --dry-run                        # rehearse
  $0 --package kernel                 # one package
  $0 --package kernel,http,database   # subset
EOF
      exit 0 ;;
    *) echo -e "${RED}Unknown option: $1${NC}"; exit 1 ;;
  esac
done

WORKSPACE_ROOT="$(cd "$(dirname "${BASH_SOURCE[0]}")/.." && pwd)"
cd "$WORKSPACE_ROOT"

# ─── package list (lockstep, dependency order) ─────────────────────────────────
# Independent: @strav/spring is versioned outside the lockstep; publish it
# separately via `--package spring`.
#
# Deferred to post-1.0: audit, transit (not in this list).
# Dropped: oauth2, pdf, publish, mcp (folded into brain).
#
# Vendor adapters (stripe, omise, line, google, facebook) live as subpath
# exports under @strav/payment and @strav/social — they are NOT standalone
# npm packages and must NOT be listed here.
ALL_PACKAGES=(
  # Tier 1 — kernel only
  kernel

  # Tier 2 — depend on kernel
  http database workflow auth

  # Tier 3 — depend on tier 2
  view queue social payment machine

  # Tier 4 — depend on tier 3
  signal durable brain

  # Tier 5 — depend on tier 4
  cli rag

  # Test-only (devDependency in consumers)
  testing
)

if [[ -n "$SPECIFIC_PACKAGES" ]]; then
  IFS=',' read -ra PACKAGES <<< "$SPECIFIC_PACKAGES"
  echo -e "${CYAN}🎯 Publishing subset: ${PACKAGES[*]}${NC}"
else
  PACKAGES=("${ALL_PACKAGES[@]}")
  echo -e "${CYAN}📚 Publishing all packages${NC}"
fi

[[ "$DRY_RUN" == true ]] && echo -e "${YELLOW}DRY RUN — nothing will be published${NC}"

# ─── npm auth check ────────────────────────────────────────────────────────────
if [[ "$SKIP_CHECK" == false ]]; then
  echo -e "${BLUE}🔐 Checking npm auth...${NC}"
  if ! npm whoami &>/dev/null; then
    echo -e "${RED}❌ Not logged in to npm. Run: npm login${NC}"
    exit 1
  fi
  echo -e "${GREEN}✓ Logged in as: $(npm whoami)${NC}"
fi

# ─── jq required for safe workspace dep rewriting ──────────────────────────────
if ! command -v jq &>/dev/null; then
  echo -e "${RED}❌ jq is required. Install via your package manager (brew install jq).${NC}"
  exit 1
fi

# ─── helpers ───────────────────────────────────────────────────────────────────
get_version() {
  jq -r '.version' "$1/package.json"
}

is_private() {
  [[ "$(jq -r '.private // false' "$1/package.json")" == "true" ]]
}

fix_workspace_deps() {
  # NOTE: split into separate declarations — combining on one line
  # ("local pkg_file=$1 version=$2 tmp_file=${pkg_file}.tmp") trips
  # `set -u` because bash sees the ${pkg_file} reference before the
  # assignment on the same line completes.
  local pkg_file=$1
  local version=$2
  local tmp_file="${pkg_file}.tmp"
  jq --arg v "$version" '
    def fix_deps:
      if . == null then null
      else with_entries(
        if .value == "workspace:*" and (.key | startswith("@strav/"))
        then .value = $v
        else .
        end)
      end;
    .dependencies     = (.dependencies     | fix_deps) |
    .peerDependencies = (.peerDependencies | fix_deps) |
    .devDependencies  = (.devDependencies  | fix_deps)
  ' "$pkg_file" > "$tmp_file"
  mv "$tmp_file" "$pkg_file"
}

is_published() {
  npm view "@strav/$1@$2" version &>/dev/null
}

publish_package() {
  local pkg_name=$1 pkg_dir="packages/$1"

  if [[ ! -d "$pkg_dir" ]]; then
    echo -e "  ${YELLOW}⚠️  Skipping $pkg_name — directory not found${NC}"
    SKIPPED_PACKAGES+=("$pkg_name (missing)")
    return 0
  fi

  pushd "$pkg_dir" >/dev/null

  if is_private "."; then
    echo -e "  ${YELLOW}⏭️  Skipping $pkg_name — private${NC}"
    SKIPPED_PACKAGES+=("$pkg_name (private)")
    popd >/dev/null
    return 0
  fi

  local version
  version=$(get_version ".")

  if is_published "$pkg_name" "$version"; then
    echo -e "  ${CYAN}✓ @strav/$pkg_name@$version already published${NC}"
    SKIPPED_PACKAGES+=("$pkg_name@$version (already published)")
    popd >/dev/null
    return 0
  fi

  echo -e "  ${BLUE}📦 Publishing @strav/$pkg_name@$version...${NC}"

  if [[ "$DRY_RUN" == true ]]; then
    echo -e "    ${YELLOW}[DRY RUN] Would publish${NC}"
    popd >/dev/null
    return 0
  fi

  cp package.json package.json.original
  fix_workspace_deps "package.json" "$version"

  if bun publish --access public 2>&1 | grep -v "npm notice"; then
    echo -e "  ${GREEN}✅ Published @strav/$pkg_name@$version${NC}"
    PUBLISHED_PACKAGES+=("$pkg_name@$version")
  else
    echo -e "  ${RED}❌ Failed to publish @strav/$pkg_name${NC}"
    FAILED_PACKAGES+=("$pkg_name")
  fi

  mv package.json.original package.json
  popd >/dev/null
}

# ─── run ───────────────────────────────────────────────────────────────────────
PUBLISHED_PACKAGES=()
FAILED_PACKAGES=()
SKIPPED_PACKAGES=()

echo -e "\n${BLUE}📚 Publishing...${NC}"
for pkg in "${PACKAGES[@]}"; do
  publish_package "$pkg"
done

# ─── summary ───────────────────────────────────────────────────────────────────
echo -e "\n${BLUE}📊 Summary${NC}"
echo -e "${BLUE}─────────────────────────────────${NC}"

if (( ${#PUBLISHED_PACKAGES[@]} > 0 )); then
  echo -e "${GREEN}✅ Published (${#PUBLISHED_PACKAGES[@]})${NC}"
  for p in "${PUBLISHED_PACKAGES[@]}"; do echo "   • @strav/$p"; done
fi

if (( ${#SKIPPED_PACKAGES[@]} > 0 )); then
  echo -e "${YELLOW}⏭️  Skipped (${#SKIPPED_PACKAGES[@]})${NC}"
  for p in "${SKIPPED_PACKAGES[@]}"; do echo "   • $p"; done
fi

if (( ${#FAILED_PACKAGES[@]} > 0 )); then
  echo -e "${RED}❌ Failed (${#FAILED_PACKAGES[@]})${NC}"
  for p in "${FAILED_PACKAGES[@]}"; do echo "   • $p"; done
  exit 1
fi

if [[ "$DRY_RUN" == true ]]; then
  echo -e "\n${YELLOW}Dry run complete.${NC}"
elif (( ${#PUBLISHED_PACKAGES[@]} > 0 )); then
  echo -e "\n${GREEN}🎉 Done.${NC}"
fi

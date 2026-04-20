#!/usr/bin/env bash
#
# Scaffold an output directory for a generated three-platform project.
# Usage: scripts/init-generated-project.sh <spec-slug>
#
# Creates ./out/<slug>/{rails,ios,android}, each initialized as an
# independent git repo on `main`. Errors if ./out/<slug> already exists
# to avoid clobbering a prior run.

set -euo pipefail

if [[ $# -ne 1 ]]; then
  echo "usage: $0 <spec-slug>" >&2
  exit 64
fi

slug="$1"

if [[ ! "$slug" =~ ^[a-z0-9][a-z0-9-]*$ ]]; then
  echo "error: slug must be lowercase alphanumeric with hyphens (got: $slug)" >&2
  exit 65
fi

repo_root="$(cd "$(dirname "$0")/.." && pwd)"
out_root="$repo_root/out/$slug"

if [[ -e "$out_root" ]]; then
  echo "error: $out_root already exists; refusing to overwrite" >&2
  exit 73
fi

for platform in rails ios android; do
  target="$out_root/$platform"
  mkdir -p "$target"
  git -C "$target" init -q -b main
  echo "initialized $target"
done

echo "done: $out_root"

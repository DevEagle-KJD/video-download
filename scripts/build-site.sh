#!/usr/bin/env bash
# Assembles the GitHub Pages site into site/: the app, plus every finished
# download at files/<job id>/<name>. The app fetches files from its own
# origin because GitHub's release file host (release-assets.githubusercontent.com)
# doesn't send CORS headers, so browsers block reading it from another site.
set -euo pipefail

BUDGET=${BUDGET:-900000000}   # Pages sites are capped at 1 GB
rm -rf site
mkdir -p site
cp -r app/. site/
used=$(du -sb site | cut -f1)

# Newest first, so if the budget runs out it's the oldest files that are left out.
while read -r tag name size; do
  [ -n "$tag" ] || continue
  if [ $((used + size)) -gt "$BUDGET" ]; then
    echo "Skipping $tag/$name ($size bytes): over the Pages size budget"
    continue
  fi
  mkdir -p "site/files/${tag#dl-}"
  gh release download "$tag" -R "$GITHUB_REPOSITORY" -p "$name" -D "site/files/${tag#dl-}"
  used=$((used + size))
  echo "Added $tag/$name"
done < <(gh api "repos/$GITHUB_REPOSITORY/releases?per_page=100" --jq '
  sort_by(.created_at) | reverse | .[]
  | select(.tag_name | startswith("dl-")) | .tag_name as $t
  | .assets[] | "\($t) \(.name) \(.size)"')

echo "Site size: $(du -sh site | cut -f1)"

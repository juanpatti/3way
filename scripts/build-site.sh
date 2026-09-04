#!/usr/bin/env bash
# Assembles dist-site/ : the 3way.dev site at the root, demos nested beneath it.
#
#   /                 the argument            site/
#   /demo/halden/     the shop demo           sites/flagship/
#   /demo/clinic/     the records demo        sites/clinic/      (built only if present)
# Every demo directory is self-contained — its own widget/ and config/, all paths
# relative — which is why they can be nested at any depth without edits. WebAuthn binds to
# the DOMAIN, not the path, so moving a demo deeper does not touch RP_ID or EXPECTED_ORIGIN.
set -euo pipefail
cd "$(dirname "$0")/.."

export THREEWAY_BUILD_API_BASE="${THREEWAY_API_BASE:-https://api.3way.dev}"

WIDGET=packages/widget/dist/3way.js
BUNDLE=packages/widget/dist/3way.bundle.js
POLYFILL=packages/widget/vendor/webmcp-polyfill.js
[ -f "$WIDGET" ] || { echo "missing $WIDGET — run npm run build first" >&2; exit 1; }

rm -rf dist-site
mkdir -p dist-site
cp -r site/. dist-site/

# The site's own stylesheet and nav script, versioned by content for the same reason the
# demo assets are: Pages serves static assets with max-age=14400 whatever _headers says
# (only the HTML honours no-cache), so a redesign shipped as new HTML over a cached
# stylesheet, and the new Demos button rendered as a bare native <button> for the person
# looking at it. Same bug the demo assets already guard against, a third time.
SITE_CSS_V=$(shasum -a 256 site/assets/site.css | cut -c1-10)
NAV_JS_V=$(shasum -a 256 site/assets/nav.js | cut -c1-10)
for page in dist-site/*.html; do
  perl -pi -e "s{(\\./assets/site\\.css)(\\?v=[a-f0-9]+)?}{\$1?v=$SITE_CSS_V}g; s{(\\./assets/nav\\.js)(\\?v=[a-f0-9]+)?}{\$1?v=$NAV_JS_V}g" "$page"
done

# The probe is published from docs/probe/ rather than copied into site/, so the page a
# visitor runs and the page that produced docs/research/runtime-findings.md are the same file. Two
# copies would let the published instrument drift from the recorded measurement, which is
# the one thing an instrument cannot survive.
mkdir -p dist-site/probe
cp docs/probe/index.html dist-site/probe/index.html

install_demo() {         # $1 = source dir, $2 = destination path under dist-site
  local src="$1" dest="dist-site/$2"
  [ -d "$src" ] || { echo "  skip $2 (no $src yet)"; return 0; }
  mkdir -p "$dest/widget"
  cp -r "$src/." "$dest/"
  cp "$WIDGET" "$POLYFILL" "$dest/widget/"
  cp site/demo-bar.js "$dest/"
  cp site/favicon.svg "$dest/"
  [ -f "$BUNDLE" ] && cp "$BUNDLE" "$dest/widget/"
  perl -pi -e 's{data-3way-api="[^"]+"}{data-3way-api="$ENV{THREEWAY_BUILD_API_BASE}"}g' "$dest/index.html"
  # Cache-bust the widget by CONTENT rather than by trusting headers. The bundle ships from
  # a stable filename on purpose — the embed snippet must stay copy-pasteable — and
  # Cloudflare Pages overrides Cache-Control for static assets, so a returning visitor would
  # keep executing whatever they cached for four hours. Found the honest way: a correctly
  # deployed fix looked like a code bug until the page under test was forced off its cache.
  # A ?v= that changes only when the bytes do means a deploy lands immediately, and an
  # unchanged deploy still hits cache.
  # EVERY mutable script the page loads, not just the widget — the first pass versioned
  # the bundle alone and the demo bar then shipped a change nobody could see for four
  # hours, which is the same bug a second time in the same afternoon.
  local v b
  v=$(shasum -a 256 "$BUNDLE" | cut -c1-10)
  b=$(shasum -a 256 site/demo-bar.js | cut -c1-10)
  perl -pi -e "s{(widget/3way\\.bundle\\.js)(\\?v=[a-f0-9]+)?}{\$1?v=$v}g" "$dest/index.html"
  perl -pi -e "s{(\\./demo-bar\\.js)(\\?v=[a-f0-9]+)?}{\$1?v=$b}g" "$dest/index.html"
  node scripts/version-demo-assets.mjs "$src" "$dest"
  echo "  built $2  (all local assets content-versioned)"
}

# A versioned copy at the site root, so the install page's snippet is a real URL rather
# than an illustration. Versioned on purpose: an unversioned /3way.bundle.js means any
# change silently reaches every page that ever embedded it.
if [ -f "$BUNDLE" ]; then
  mkdir -p dist-site/v1
  cp "$BUNDLE" dist-site/v1/
  # Subresource Integrity, published beside the file. A hosted consent widget that cannot
  # be pinned is a script somebody else can swap; this is the project's own argument
  # applied to its own distribution.
  SRI="sha384-$(openssl dgst -sha384 -binary "$BUNDLE" | openssl base64 -A)"
  printf '%s\n' "$SRI" > dist-site/v1/3way.bundle.js.sri
  # The install page quotes this hash. Injected here rather than pasted in by hand,
  # because a published integrity hash that has drifted from its file is worse than none:
  # every embed using it simply stops loading.
  if [ -f dist-site/install.html ]; then
    perl -pi -e "s|\{\{SRI\}\}|$SRI|g" dist-site/install.html
  fi
  echo "  built v1/3way.bundle.js  ($SRI)"
fi

install_demo sites/flagship    demo/halden
install_demo sites/clinic      demo/clinic

[ -f dist-site/_headers ] || { echo "missing dist-site/_headers — a stale widget bundle will outlive every deploy" >&2; exit 1; }
echo "dist-site assembled:"
find dist-site -maxdepth 2 -name '*.html' | sort | sed 's/^/  /'

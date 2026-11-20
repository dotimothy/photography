#!/bin/sh
# Refresh build/ from the source pages, regenerate the gallery pages from tmp/gallery with the
# current modules/builder.py injection, and serve the repo root on PORT (default 8765).
# Use --no-serve to refresh files only.
# Needs one full `make build` first (downloads photos into build/portfolios and the template into tmp/gallery).
set -e
ROOT=$(git -C "$(dirname "$0")" rev-parse --show-toplevel); cd "$ROOT"
PORT=${PORT:-8765}
[ -d tmp/gallery ] && [ -d build/portfolios ] || { echo "Run 'make build' once first (needs build/portfolios and tmp/gallery)."; exit 1; }
cp index.html about.html linktree.html license.html manifest.json sw.js build/
[ -f contact.html ] && cp contact.html build/
rsync -a --delete vlm/ build/vlm/
rsync -a assets/ build/assets/
.venv/bin/python - <<'PY'
import os, re, shutil, html, json
from modules import builder
import preparePortfolio as pp
for g in pp.GALLERIES:
    root = os.path.join('build', 'portfolios', g)
    if not os.path.isdir(root): continue
    title = g.title()
    for a in ['index.html', 'immersive.html', 'css', 'js', 'templates']:
        src, dst = os.path.join('tmp', 'gallery', a), os.path.join(root, a)
        if os.path.isdir(src): shutil.rmtree(dst, ignore_errors=True); shutil.copytree(src, dst)
        elif os.path.exists(src): shutil.copy2(src, dst)
    shutil.copy2('license.html', os.path.join(root, 'license.html'))
    p = os.path.join(root, 'index.html'); c = open(p, encoding='utf-8').read()
    c = re.sub(r'<meta\s+name="gallery-shape-emoji"[^>]*>\s*', '', c)
    shape = pp.GALLERY_SHAPE_EMOJIS.get(g)
    if shape: c = c.replace('</head>', '<meta name="gallery-shape-emoji" content="' + html.escape(shape, quote=True) + '">\n</head>', 1)
    c = re.sub(r'<title>.*?</title>', f'<title>{title}</title>', c, flags=re.S)
    c = re.sub(r'<h1 id="title">.*?</h1>', f'<h1 id="title">{title}</h1>', c, flags=re.S)
    tint = builder.GALLERY_THEME_COLORS.get(g)
    if tint: c = re.sub(r'<meta name="theme-color" content="[^"]*">', f'<meta name="theme-color" content="{tint}">', c, count=1)
    page = builder.add_gallery_return_navigation(c); open(p, 'w', encoding='utf-8').write(page)
    p = os.path.join(root, 'immersive.html')
    if os.path.exists(p):
        page = builder.add_gallery_return_navigation(open(p, encoding='utf-8').read()); open(p, 'w', encoding='utf-8').write(page)
    view_path = os.path.join(root, 'js', 'view3d.js')
    if os.path.isfile(view_path):
        with open(view_path, encoding='utf-8') as view_file:
            view = builder.customize_gallery_view3d(view_file.read())
        with open(view_path, 'w', encoding='utf-8') as view_file:
            view_file.write(view)
    p = os.path.join(root, 'js', 'app.js')
    if os.path.exists(p):
        metadata_path = os.path.join(root, 'metadata', 'metadata.json')
        has_selects = False
        if os.path.isfile(metadata_path):
            with open(metadata_path, encoding='utf-8') as metadata_file:
                has_selects = bool(json.load(metadata_file).get('selects_order'))
        js = builder.customize_gallery_app(open(p, encoding='utf-8').read(), title, has_selects)
        open(p, 'w', encoding='utf-8').write(js)
PY
if [ "${1:-}" = "--no-serve" ]; then
  echo "Refreshed build/."
  exit 0
fi
if ! curl -s -o /dev/null "http://127.0.0.1:$PORT/index.html"; then
  (python3 -m http.server "$PORT" --bind 127.0.0.1 >/dev/null 2>&1 &); sleep 1
fi
echo "Preview: http://127.0.0.1:$PORT/build/ (as deployed); source pages at http://127.0.0.1:$PORT/"

import os
import shutil
import json
import re
import time

# Per-gallery accent tints used for <meta name="theme-color">.
GALLERY_THEME_COLORS = {
    'astronomy': '#0b1e3a',  # deep blue night sky
    'food':      '#3a2118',  # warm brown
    'landscape': '#1a3a2e',  # forest green
    'planes':    '#2a3344',  # steel blue
    'wildlife':  '#2e2a1a',  # earthy gold
}

def generate_site(target_keys, gallery_map, results_map, portfolios_root, gallery_emojis, template_src='./tmp/gallery'):
    """
    Generates the static site structure for each target gallery.
    """
    generated_count = 0
    for gallery in target_keys:
        if gallery not in gallery_map or not gallery_map[gallery]:
            continue

        emoji = gallery_emojis.get(gallery, '')
        title = f"{emoji} {gallery.title()} {emoji}"
        print(f" - Building {title}")

        # Metadata
        g_root = os.path.join(portfolios_root, gallery)
        
        # Sync local overrides into template
        if os.path.exists('license.html') and os.path.exists(template_src):
            shutil.copy2('license.html', os.path.join(template_src, 'license.html'))

        gallery_meta = {}
        file_list = []
        
        def get_sort_key(fname):
            n = os.path.splitext(fname)[0]
            if n in results_map[gallery]:
                return results_map[gallery][n].get('__dt', 0)
            return 0

        sorted_files = sorted(gallery_map[gallery], key=get_sort_key)
        
        for fname in sorted_files:
            name_no_ext = os.path.splitext(fname)[0]
            file_list.append(name_no_ext)
            if name_no_ext in results_map[gallery]:
                clean_meta = results_map[gallery][name_no_ext].copy()
                clean_meta.pop('__dt', None)
                gallery_meta[name_no_ext] = clean_meta
        
        gallery_meta['image_order'] = file_list
        os.makedirs(os.path.join(g_root, 'metadata'), exist_ok=True)
        with open(os.path.join(g_root, 'metadata', 'metadata.json'), 'w') as f:
            json.dump(gallery_meta, f, indent=4)

        # Inject Assets
        if os.path.exists(template_src):
            for asset in ['index.html', 'immersive.html', 'license.html', 'css', 'js', 'templates']:
                src = os.path.join(template_src, asset)
                dst = os.path.join(g_root, asset)
                if os.path.exists(src):
                    if os.path.isdir(src):
                        if os.path.exists(dst): shutil.rmtree(dst)
                        shutil.copytree(src, dst)
                    else:
                        shutil.copy2(src, dst)
            
            # Inject Titles + per-gallery theme color
            html_path = os.path.join(g_root, 'index.html')
            if os.path.exists(html_path):
                with open(html_path, 'r', encoding='utf-8') as f: content = f.read()
                content = re.sub(r'<title>.*?</title>', f'<title>{title}</title>', content, flags=re.DOTALL)
                content = re.sub(r'<h1 id="title">.*?</h1>', f'<h1 id="title">{title}</h1>', content, flags=re.DOTALL)
                tint = GALLERY_THEME_COLORS.get(gallery)
                if tint:
                    content = re.sub(
                        r'<meta name="theme-color" content="[^"]*">',
                        f'<meta name="theme-color" content="{tint}">',
                        content, count=1
                    )
                with open(html_path, 'w', encoding='utf-8') as f: f.write(content)

            js_path = os.path.join(g_root, 'js/app.js')
            if os.path.exists(js_path):
                with open(js_path, 'r', encoding='utf-8') as f: js_content = f.read()
                js_content = re.sub(r'const titleText = ".*Gallery Template.*";', f'const titleText = "{title}";', js_content)
                with open(js_path, 'w', encoding='utf-8') as f: f.write(js_content)
        
        generated_count += 1
    return generated_count

def generate_metadata_search_index(portfolios_root, target_keys, build_root='./build'):
    """Build a deterministic, metadata-only search index.

    This deliberately performs no image decoding and no VLM inference. An
    explicitly requested VLM recommendation can later rerank a metadata shortlist.
    """
    records = []
    gallery_counts = {}

    for gallery in target_keys:
        gallery_root = os.path.join(portfolios_root, gallery)
        metadata_path = os.path.join(gallery_root, 'metadata', 'metadata.json')
        if not os.path.exists(metadata_path):
            continue

        try:
            with open(metadata_path, 'r', encoding='utf-8') as f:
                gallery_metadata = json.load(f)
        except (OSError, json.JSONDecodeError) as error:
            print(f" - Warning: search metadata unavailable for {gallery}: {error}")
            continue

        # metadata.json stores stems in image_order. Resolve the deployed file
        # name from fulls/ so non-JPEG portfolio entries remain valid.
        deployed_names = {}
        fulls_dir = os.path.join(gallery_root, 'fulls')
        if os.path.isdir(fulls_dir):
            for filename in sorted(os.listdir(fulls_dir)):
                deployed_names.setdefault(os.path.splitext(filename)[0], filename)

        count = 0
        for name in gallery_metadata.get('image_order', []):
            name = str(name)
            stem = os.path.splitext(name)[0]
            filename = deployed_names.get(stem, name if os.path.splitext(name)[1] else f'{name}.jpg')
            records.append({
                'id': f'{gallery}/{name}',
                'gallery': gallery,
                'name': name,
                'filename': filename,
                'metadata': gallery_metadata.get(name, gallery_metadata.get(stem, {})),
                'source': 'metadata',
            })
            count += 1
        gallery_counts[gallery] = count

    payload = {
        'version': 1,
        'source': 'build-metadata',
        'galleries': gallery_counts,
        'records': records,
    }
    output_dir = os.path.join(build_root, 'assets')
    os.makedirs(output_dir, exist_ok=True)
    output_path = os.path.join(output_dir, 'search-index.json')
    with open(output_path, 'w', encoding='utf-8') as f:
        json.dump(payload, f, ensure_ascii=False, separators=(',', ':'))
    print(f" - Built metadata search index ({len(records)} photos)")
    return output_path

def prepare_deployment(deploy_assets, build_root='./build'):
    """
    Copies necessary assets to the final build directory for deployment.
    Also handles PWA scaffolding: copies manifest.json and writes a
    build-stamped sw.js so service-worker caches invalidate per-build.
    """
    os.makedirs(build_root, exist_ok=True)
    # Standard assets
    for item in deploy_assets:
        src = item
        dst = os.path.join(build_root, item)
        if os.path.exists(src):
            if os.path.isdir(src):
                if os.path.exists(dst): shutil.rmtree(dst)
                shutil.copytree(src, dst)
            else:
                shutil.copy2(src, dst)
            print(f" - Copied {item}")
        else:
            print(f" - Warning: {item} not found")

    # PWA: manifest.json (cache-busting via build mtime is automatic)
    if os.path.exists('manifest.json'):
        shutil.copy2('manifest.json', os.path.join(build_root, 'manifest.json'))
        print(" - Copied manifest.json")

    # PWA: sw.js with __BUILD_TIME__ replaced by current epoch second so
    # the cache name changes with every deploy and stale entries are evicted.
    if os.path.exists('sw.js'):
        with open('sw.js', 'r', encoding='utf-8') as f: sw = f.read()
        sw = sw.replace('__BUILD_TIME__', str(int(time.time())))
        with open(os.path.join(build_root, 'sw.js'), 'w', encoding='utf-8') as f: f.write(sw)
        print(" - Wrote sw.js (build-stamped)")

    # Copy TouchManager for VLM use on landing/about pages where the gallery
    # template's TouchManager isn't bundled. Source of truth lives in the
    # gallery template; this is just a copy.
    src_tm = os.path.join('tmp', 'gallery', 'js', 'TouchManager.js')
    dst_dir = os.path.join(build_root, 'assets', 'js')
    if os.path.exists(src_tm):
        os.makedirs(dst_dir, exist_ok=True)
        shutil.copy2(src_tm, os.path.join(dst_dir, 'TouchManager.js'))
        print(" - Copied assets/js/TouchManager.js (VLM shared)")

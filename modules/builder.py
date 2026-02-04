import os
import shutil
import json
import re

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
            
            # Inject Titles
            html_path = os.path.join(g_root, 'index.html')
            if os.path.exists(html_path):
                with open(html_path, 'r', encoding='utf-8') as f: content = f.read()
                content = re.sub(r'<title>.*?</title>', f'<title>{title}</title>', content, flags=re.DOTALL)
                content = re.sub(r'<h1 id="title">.*?</h1>', f'<h1 id="title">{title}</h1>', content, flags=re.DOTALL)
                with open(html_path, 'w', encoding='utf-8') as f: f.write(content)

            js_path = os.path.join(g_root, 'js/app.js')
            if os.path.exists(js_path):
                with open(js_path, 'r', encoding='utf-8') as f: js_content = f.read()
                js_content = re.sub(r'const titleText = ".*Gallery Template.*";', f'const titleText = "{title}";', js_content)
                with open(js_path, 'w', encoding='utf-8') as f: f.write(js_content)
        
        generated_count += 1
    return generated_count

def prepare_deployment(deploy_assets, build_root='./build'):
    """
    Copies necessary assets to the final build directory for deployment.
    """
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

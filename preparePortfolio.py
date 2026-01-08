"""
TheDoShoots Portfolio Preparer
------------------------------
A multiprocessing-enabled build tool for generating photography galleries.
Handles Git synchronization, asset copying, EXIF data modification, 
watermarking, and site generation via external scripts.
"""

import os
import shutil
import git
import tqdm
import webbrowser
import argparse
import subprocess
import socket
import time
import csv
import re
import requests
from multiprocessing import Pool, cpu_count
from PIL import Image  # Requires pip install Pillow

# --- Configuration ---
GALLERY_REPO = 'https://github.com/dotimothy/gallery.git'
PORTFOLIO_CSV_PATH = './assets/portfolio.csv'
PORTFOLIO_CSV_ID = '1PrLEoVooon_-rOZRGzH1BuZbNWLaHDqV'
WATERMARK_PATH = './assets/watermark.png'
PORTFOLIOS_ROOT = './portfolios'

# Map folder names to Emojis
GALLERY_EMOJIS = {
    'astronomy': '🌌',
    'food': '🍱',
    'landscape': '🏞️',
    'planes': '✈️',
    'wildlife':  '🐿️ '
}

class color:
     BOLD = '\033[1m'
     END = '\033[0m'

def is_port_open(host, port, timeout=1):
    """Checks if a given TCP port on a host is open."""
    sock = socket.socket(socket.AF_INET, socket.SOCK_STREAM)
    sock.settimeout(timeout)
    try:
        sock.connect((host, port))
        return True
    except socket.error:
        return False
    finally:
        sock.close()

def updateGalleryRepo():
    """Clones or pulls the latest gallery template."""
    os.makedirs('tmp', exist_ok=True)
    if not os.path.exists('./tmp/gallery'):
        print(f"{color.BOLD}Cloning gallery repo from {GALLERY_REPO}{color.END}")
        git.Repo.clone_from(GALLERY_REPO, 'tmp/gallery')
    else:
        print(f"Gallery repo already exists. Pulling latest changes...")
        repo = git.Repo('./tmp/gallery')
        repo.remotes.origin.pull()

def download_worker(task):
    """
    Worker function to download a single file using requests.
    Handles the Google Drive virus scan warning for large files.
    """
    input_val, output_path = task
    os.makedirs(os.path.dirname(output_path), exist_ok=True)
    
    if os.path.exists(output_path):
        return

    # Extract File ID from link or use direct ID
    file_id = input_val
    if 'id=' in str(input_val):
        file_id = input_val.split('id=')[-1].split('&')[0]
    elif 'd/' in str(input_val):
        file_id = input_val.split('d/')[-1].split('/')[0]

    download_url = f"https://drive.google.com/uc?export=download&id={file_id}"
    session = requests.Session()
    
    try:
        # Initial request to check for large file warning
        response = session.get(download_url, stream=True)
        
        # Look for the confirmation token in cookies
        token = None
        for key, value in response.cookies.items():
            if key.startswith('download_warning'):
                token = value
                break

        # If warning present, resubmit with confirmation token
        if token:
            params = {'confirm': token, 'id': file_id}
            response = session.get("https://drive.google.com/uc?export=download", params=params, stream=True)

        if response.status_code == 200:
            with open(output_path, 'wb') as f:
                for chunk in response.iter_content(chunk_size=32768):
                    if chunk: f.write(chunk)
        else:
            print(f"\n[Error] {output_path} failed with status {response.status_code}")

    except Exception as e:
        print(f"\n[Network Error] {output_path}: {e}")

def watermark_worker(image_path):
    """
    Worker function to apply watermark to a single image.
    Features:
    - Resizes watermark to 20% of image width.
    - Places watermark at bottom-right with 5% vertical padding.
    - Sets watermark transparency to 70%.
    - Preserves EXIF data from original image.
    - Maximizes output quality.
    """
    if not os.path.exists(WATERMARK_PATH):
        return
        
    try:
        exif_bytes = None
        # Open and capture info before processing
        with Image.open(image_path) as img_src:
            original_format = img_src.format
            # 1. Capture EXIF data
            exif_bytes = img_src.info.get('exif')
            base_image = img_src.convert("RGBA")
            
        watermark = Image.open(WATERMARK_PATH).convert("RGBA")

        # 2. Adjust Watermark Opacity (Transparency)
        # Scale alpha channel by 0.90 (90% opacity)
        alpha = watermark.getchannel('A')
        new_alpha = alpha.point(lambda i: int(i * 0.9))
        watermark.putalpha(new_alpha)

        # 3. Resize Watermark relative to image width (20%)
        target_width = int(base_image.width * 0.20)
        aspect_ratio = watermark.height / watermark.width
        target_height = int(target_width * aspect_ratio)
        
        if target_width > 0 and target_height > 0:
            watermark = watermark.resize((target_width, target_height), Image.Resampling.LANCZOS)

        # 4. Calculate position 
        width, height = base_image.size
        wm_width, wm_height = watermark.size
        
        
        position = (width - wm_width, height - wm_height)

        # 5. Composite
        transparent_layer = Image.new('RGBA', base_image.size, (0,0,0,0))
        transparent_layer.paste(watermark, position, mask=watermark)
        output = Image.alpha_composite(base_image, transparent_layer)
        
        # Prepare Save Arguments
        save_kwargs = {}
        if exif_bytes:
            save_kwargs['exif'] = exif_bytes

        # 6. Save preserving format, quality, and EXIF
        if original_format == 'JPEG' or image_path.lower().endswith(('.jpg', '.jpeg')):
            output = output.convert("RGB")
            # quality=100: Minimum compression
            # subsampling=0: Disable chroma subsampling (4:4:4)
            output.save(image_path, format='JPEG', quality=100, subsampling=0, **save_kwargs)
        elif original_format == 'PNG' or image_path.lower().endswith('.png'):
            output.save(image_path, format='PNG', **save_kwargs)
        else:
            output = output.convert("RGB")
            output.save(image_path, quality=100, **save_kwargs)
        
    except Exception as e:
        print(f"\n[Watermark Error] Failed to watermark {image_path}: {e}")

def download_portfolio_assets(csv_path):
    """Parses the portfolio CSV and downloads assets in parallel."""
    
    tasks = []
    try:
        with open(csv_path, 'r', encoding='utf-8') as f:
            reader = csv.DictReader(f)
            for row in reader:
                gallery = row['Gallery'].strip().lower()
                # Flexibly handle 'File ID' or 'Link' columns
                file_id = row.get('File ID') or row.get('Link')
                file_name = row['File Name']
                target_path = os.path.join(PORTFOLIOS_ROOT, gallery, 'fulls', file_name)
                tasks.append((file_id, target_path))
    except FileNotFoundError:
        print(f"Error: {csv_path} not found.")
        return

    num_processes = min(16, cpu_count(), len(tasks))
    print(f'Using {num_processes} Downloader Workers')
    with Pool(processes=num_processes) as pool:
        list(tqdm.tqdm(pool.imap_unordered(download_worker, tasks), total=len(tasks), unit="img"))

def prepareGallery(args_tuple):
    """Worker function to build a single gallery."""
    gallery, title, modifyGPS, dry_run = args_tuple
    log_prefix = f"[{gallery}]"

    if dry_run:
        time.sleep(0.1)
        return f"{gallery} (Dry Run)"

    galleryDir = os.path.join(PORTFOLIOS_ROOT, gallery)
    htmlPath = os.path.join(galleryDir, 'index.html')
    fullsPath = os.path.join(galleryDir, 'fulls')
    
    # Ensure structure exists
    os.makedirs(galleryDir, exist_ok=True)
    os.makedirs(fullsPath, exist_ok=True)

    # 1. EXIF Modification
    if modifyGPS:
         print(f"{color.BOLD} {log_prefix} Modifying EXIF...{color.END}")
         exif_script_path = os.path.abspath('./tmp/gallery/prepareExif.py')
         fulls_rel_path = f'../../{fullsPath}'

         server_process = subprocess.Popen(
             ['python', exif_script_path, '--fulls', fulls_rel_path],
             cwd='./tmp/gallery' 
         )

         host, port = '127.0.0.1', 8000
         for _ in range(30):
             if is_port_open(host, port):
                 webbrowser.open_new_tab(f'http://{host}:{port}')
                 break
             time.sleep(1)
         
         print(f"{color.BOLD}{log_prefix} Press Ctrl+C when EXIF edits are done.{color.END}")
         try:
            server_process.wait()
         except KeyboardInterrupt:
            server_process.terminate()
    
    # 2. Copy Template Assets
    assets_to_copy = ['prepareSite.py', 'index.html', 'css', 'js', 'templates']
    for asset in assets_to_copy:
        src = f'./tmp/gallery/{asset}'
        dst = os.path.join(galleryDir, asset)
        if os.path.exists(src):
            if os.path.isdir(src):
                if os.path.exists(dst): shutil.rmtree(dst)
                shutil.copytree(src, dst)
            else:
                shutil.copyfile(src, dst)

    # 3. Inject Titles
    if os.path.exists(htmlPath):
        with open(htmlPath, 'r', encoding='utf-8') as f: content = f.read()
        content = re.sub(r'<title>.*?</title>', f'<title>{title}</title>', content, flags=re.DOTALL)
        content = re.sub(r'<h1 id="title">.*?</h1>', f'<h1 id="title">{title}</h1>', content, flags=re.DOTALL)
        with open(htmlPath, 'w', encoding='utf-8') as f: f.write(content)

    jsPath = os.path.join(galleryDir, 'js/app.js')
    if os.path.exists(jsPath):
        with open(jsPath, 'r', encoding='utf-8') as f: jsContent = f.read()
        jsContent = re.sub(r'const titleText = ".*Gallery Template.*";', f'const titleText = "{title}";', jsContent)
        with open(jsPath, 'w', encoding='utf-8') as f: f.write(jsContent)

    # 4. Run Site Generator
    try:
        subprocess.run(['python', 'prepareSite.py'], cwd=galleryDir, check=True, stdout=subprocess.DEVNULL)
    except Exception:
        print(f"{log_prefix} Error: prepareSite.py failed.")

    return f"{gallery} Done"

if __name__ == '__main__':
    parser = argparse.ArgumentParser(description='TheDoShoots Portfolio Preparation Engine')
    parser.add_argument('--exif', action='store_true', help='Launch EXIF Editor')
    parser.add_argument('--select', nargs='+', help='Build specific galleries')
    parser.add_argument('--watermark', action='store_true', help='Apply watermark to downloaded images')
    parser.add_argument('--skip-repo', action='store_true', help='Skip git updates')
    parser.add_argument('--clean', action='store_true', help='Wipe generated assets (Keep images)')
    parser.add_argument('--full-clean', action='store_true', help='Wipe entire portfolios folder and CSV')
    parser.add_argument('--dry-run', action='store_true', help='Simulation mode')
    parser.add_argument('-j', '--jobs', type=int, default=None, help='Parallel process count')

    args = parser.parse_args()

    target_galleries = {k: v for k, v in GALLERY_EMOJIS.items() if not args.select or k in args.select}

    print(f"{color.BOLD}*** TheDoShoots Portfolio Preperation Engine ***{color.END}")
    
    print(f"Target Galleries ({len(target_galleries)}):")
    for key, emoji in target_galleries.items():
        title = f'{emoji} {key.title()} {emoji}'
        print(f" - {key}: {title}")

    # --- STEP 0: CLEANING ---
    if (args.clean or args.full_clean) and not args.dry_run:
        print(f"\n{color.BOLD}*** Step 0: Cleaning Workspace... ***{color.END}")
        
        if args.full_clean:
            if os.path.exists(PORTFOLIOS_ROOT):
                print(f"[Full Clean] Removing {PORTFOLIOS_ROOT}/")
                shutil.rmtree(PORTFOLIOS_ROOT)
            
            if os.path.exists(PORTFOLIO_CSV_PATH):
                print(f"[Full Clean] Deleting {PORTFOLIO_CSV_PATH}")
                os.remove(PORTFOLIO_CSV_PATH)
                
        elif args.clean and os.path.exists(PORTFOLIOS_ROOT):
            print(f"[Normal Clean] Deleting Assets inside {PORTFOLIOS_ROOT}/ (Keeping images)")
            for gallery in target_galleries.keys():
                gallery_path = os.path.join(PORTFOLIOS_ROOT, gallery)
                if os.path.exists(gallery_path):
                    for item in os.listdir(gallery_path):
                        if item == 'fulls': continue
                        path = os.path.join(gallery_path, item)
                        if os.path.isdir(path): shutil.rmtree(path)
                        else: os.remove(path)

    # --- STEP 1: ASSETS & REPO ---
    print(f"\n{color.BOLD}*** Step 1: Downloading Portfolio Assets... ***{color.END}")
    os.makedirs('assets', exist_ok=True)
    if not os.path.exists(PORTFOLIO_CSV_PATH):
        download_worker((PORTFOLIO_CSV_ID, PORTFOLIO_CSV_PATH))

    if not args.dry_run:
        download_portfolio_assets(PORTFOLIO_CSV_PATH)
    
    if not args.skip_repo:
        updateGalleryRepo()

    # --- STEP 1.5: WATERMARKING ---
    if args.watermark and not args.dry_run:
        if not os.path.exists(WATERMARK_PATH):
            print(f"\n{color.BOLD}[Warning] Watermark file not found at {WATERMARK_PATH}. Skipping...{color.END}")
        else:
            all_images = []
            
            for gallery in target_galleries.keys():
                fulls_path = os.path.join(PORTFOLIOS_ROOT, gallery, 'fulls')
                if os.path.exists(fulls_path):
                    for f in os.listdir(fulls_path):
                        if f.lower().endswith(('.jpg', '.jpeg', '.png')):
                            all_images.append(os.path.join(fulls_path, f))
            
            if all_images:
                num_processes = args.jobs or min(cpu_count(), len(all_images))
                print(f"\n{color.BOLD}*** Step 1.5: Applying Watermarks with {num_processes} Workers ***{color.END}")
                with Pool(processes=num_processes) as pool:
                    list(tqdm.tqdm(pool.imap_unordered(watermark_worker, all_images), total=len(all_images), unit="img"))
            else:
                print("No images found to watermark.")

    # --- STEP 2: BUILDING ---
    tasks = [(g, f'{t} {g.title()} {t}', args.exif, args.dry_run) for g, t in target_galleries.items()]
    
    if args.exif:
        for task in tasks: prepareGallery(task)
    else:
        count = args.jobs or min(cpu_count() or 1, len(tasks))
        print(f"\n{color.BOLD}*** Step 2: Building {len(tasks)} Galleries with {count} Workers ***{color.END}")
        with Pool(processes=count) as pool:
            list(tqdm.tqdm(pool.imap_unordered(prepareGallery, tasks), total=len(tasks)))

    # Cleanup
    if os.path.exists('tmp'): shutil.rmtree('tmp')
    print(f"\n{color.BOLD}Preparation Complete!{color.END}")
"""
TheDoShoots Portfolio Engine (Consolidated & Optimized)
-------------------------------------------------------
A single-file, high-performance build tool for photography portfolios.
Features:
- Global Parallelization (Image-level vs Gallery-level)
- Smart Incremental Builds (Skips worker queue for cached files)
- Manifest-Based Caching (Only verifies assets if missing or CSV changed)
- CPU Affinity Pinning (Locks workers to specific cores)
- OpenCV-based Image Processing pipeline
- Auto-Logging and Profiling
"""

import os
import shutil
import git
import tqdm
import argparse
import time
import csv
import re
import requests
import json
import cv2 as cv
import exifread
import sys
import hashlib
from datetime import datetime
from multiprocessing import Pool, cpu_count, Value, current_process

# --- Configuration ---
GALLERY_REPO = 'https://github.com/dotimothy/gallery.git'
PORTFOLIO_CSV_PATH = './assets/portfolio.csv'
PORTFOLIO_CSV_ID = '1PrLEoVooon_-rOZRGzH1BuZbNWLaHDqV'
WATERMARK_PATH = './assets/watermark.png'
PORTFOLIOS_ROOT = './build/portfolios'
CACHE_ROOT = './.cache/images'

GALLERY_EMOJIS = {
    'astronomy': '🌌', 'food': '🍱', 'landscape': '🏞️', 'planes': '✈️', 'wildlife':  '🐿️ '
}

# --- Formatting, Profiling & Logging ---
class color:
     BOLD = '\033[1m'
     END = '\033[0m'

class DualLogger(object):
    """Writes to both stdout (terminal) and a log file."""
    def __init__(self):
        self.terminal = sys.stdout
        os.makedirs('logs', exist_ok=True)
        log_name = f"logs/build_{datetime.now().strftime('%Y-%m-%d_%H-%M-%S')}.log"
        self.log_file = open(log_name, "a", encoding='utf-8')

    def write(self, message):
        self.terminal.write(message)
        self.log_file.write(message)
        self.log_file.flush()

    def flush(self):
        self.terminal.flush()
        self.log_file.flush()

class Profiler:
    def __init__(self):
        self.metrics = {}
        self.start_times = {}

    def start(self, name):
        self.start_times[name] = time.time()

    def stop(self, name, count=0):
        if name in self.start_times:
            duration = time.time() - self.start_times[name]
            self.metrics[name] = {'time': duration, 'count': count}

    def report(self):
        print(f"\n{color.BOLD}*** Performance Report ***{color.END}")
        print(f"{'-'*75}")
        print(f"{'Step Name':<25} | {'Time':<12} | {'% Total':<10} | {'Throughput':<15}")
        print(f"{'-'*75}")
        
        total_time = sum(m['time'] for m in self.metrics.values())
        
        for name, data in self.metrics.items():
            t = data['time']
            pct = (t / total_time * 100) if total_time > 0 else 0
            
            time_str = f"{t:.2f} s"
            pct_str = f"{pct:.1f} %"
            
            if data['count'] > 0 and t > 0:
                throughput_str = f"{data['count']/t:.1f} it/s"
            else:
                throughput_str = "-"

            print(f"{name:<25} | {time_str:<12} | {pct_str:<10} | {throughput_str:<15}")
            
        print(f"{'-'*75}")
        print(f"{'Total Duration':<25} | {total_time:.2f} s     | 100.0 %    |")
        print(f"{'-'*75}")

# --- Helpers ---
def get_dir_size(start_path='.'):
    """Calculates the total size of a directory in MB."""
    total_size = 0
    for dirpath, dirnames, filenames in os.walk(start_path):
        for f in filenames:
            fp = os.path.join(dirpath, f)
            if not os.path.islink(fp):
                total_size += os.path.getsize(fp)
    return total_size / (1024 * 1024)

def calculate_file_hash(filepath):
    """Calculates MD5 hash of a file."""
    hasher = hashlib.md5()
    with open(filepath, 'rb') as f:
        buf = f.read()
        hasher.update(buf)
    return hasher.hexdigest()

# --- Global Worker State ---
worker_watermark = None

def init_worker(watermark_path, worker_counter, total_cores):
    """
    Initialize worker process:
    1. Load watermark into memory.
    2. Set CPU Affinity (Pin process to a specific core).
    """
    global worker_watermark
    
    # 1. Load Watermark
    if os.path.exists(watermark_path):
        worker_watermark = cv.imread(watermark_path, cv.IMREAD_UNCHANGED)
        
    # 2. Set CPU Affinity
    # Use the shared counter to assign a unique index to this worker
    try:
        if hasattr(os, 'sched_setaffinity'):
            with worker_counter.get_lock():
                worker_id = worker_counter.value
                worker_counter.value += 1
            
            # Map worker_id to a CPU core (cycling if tasks > cores)
            core_id = worker_id % total_cores
            os.sched_setaffinity(0, {core_id})
            # Optional debug print (commented out to keep output clean)
            # print(f"[Worker {worker_id}] Pinned to Core {core_id}")
    except Exception as e:
        # Fallback for systems that don't support affinity (e.g., MacOS/Windows sometimes)
        pass

# --- Network Worker ---
def download_worker(task):
    """Downloads a single asset using a persistent session strategy."""
    input_val, cache_path, _ = task
    
    # Return immediately if already cached
    if os.path.exists(cache_path):
        return 1

    os.makedirs(os.path.dirname(cache_path), exist_ok=True)
    
    file_id = input_val
    if 'id=' in str(input_val):
        file_id = input_val.split('id=')[-1].split('&')[0]
    elif 'd/' in str(input_val):
        file_id = input_val.split('d/')[-1].split('/')[0]

    url = "https://drive.google.com/uc?export=download"
    session = requests.Session()
    
    try:
        response = session.get(url, params={'id': file_id}, stream=True)
        token = None
        for key, value in response.cookies.items():
            if key.startswith('download_warning'):
                token = value
                break

        if token:
            response = session.get(url, params={'id': file_id, 'confirm': token}, stream=True)

        if response.status_code == 200:
            with open(cache_path, 'wb') as f:
                for chunk in response.iter_content(chunk_size=32768):
                    if chunk: f.write(chunk)
            return 1
        else:
            return 0
    except Exception as e:
        print(f"Download Error {cache_path}: {e}")
        return 0

# --- Image Processing Worker ---
def process_image_worker(task):
    """
    Single-pass processing.
    """
    source_path, full_out_path, thumb_out_path, quality, apply_watermark, gallery_name = task
    
    file_name = os.path.basename(source_path)
    name_no_ext = os.path.splitext(file_name)[0]
    
    metadata = {}
    
    # 1. Metadata Extraction (Must read raw file for ExifRead)
    try:
        with open(source_path, 'rb') as f:
            for tag in tags.keys():
                if tag not in ('JPEGThumbnail', 'TIFFThumbnail'):
                    metadata[tag] = str(tags[tag])
            
            if 'EXIF DateTimeOriginal' in tags:
                metadata['__dt'] = datetime.strptime(str(tags['EXIF DateTimeOriginal']), "%Y:%m:%d %H:%M:%S").timestamp()
            else:
                metadata['__dt'] = os.path.getmtime(source_path)

    except Exception:
        metadata['__dt'] = os.path.getmtime(source_path)

    # 2. Safety Incremental Check
    if (os.path.exists(full_out_path) and os.path.exists(thumb_out_path) and
        os.path.getmtime(full_out_path) > os.path.getmtime(source_path)):
        
        if 'Image Width' not in metadata:
             img = cv.imread(full_out_path)
             if img is not None:
                h, w, _ = img.shape
                metadata['Image Width'], metadata['Image Height'] = w, h
        metadata['File Size'] = os.path.getsize(full_out_path)
        return (gallery_name, name_no_ext, metadata)

    # 3. Load Image
    img = cv.imread(source_path)
    if img is None:
        return (gallery_name, name_no_ext, {"Error": "Corrupt Image"})

    h, w, _ = img.shape
    metadata['Image Width'] = w
    metadata['Image Height'] = h

    # 4. Watermarking
    processed_img = img
    if apply_watermark and worker_watermark is not None:
        wm = worker_watermark
        wm_target_w = int(w * 0.3)
        wm_aspect = wm.shape[0] / wm.shape[1]
        wm_target_h = int(wm_target_w * wm_aspect)
        
        if wm_target_w > 0 and wm_target_h > 0:
            wm_resized = cv.resize(wm, (wm_target_w, wm_target_h), interpolation=cv.INTER_AREA)
            
            pad_y = int(h * 0.01)
            pad_x = int(w * 0.01)
            y1, y2 = h - wm_target_h - pad_y, h - pad_y
            x1, x2 = w - wm_target_w - pad_x, w - pad_x

            if y1 > 0 and x1 > 0:
                wm_bgr = wm_resized[:, :, :3]
                wm_alpha = wm_resized[:, :, 3] / 255.0
                wm_alpha = wm_alpha * 0.6

                roi = img[y1:y2, x1:x2]
                for c in range(0, 3):
                    roi[:, :, c] = (wm_alpha * wm_bgr[:, :, c] + (1.0 - wm_alpha) * roi[:, :, c])
                
                processed_img = img
                processed_img[y1:y2, x1:x2] = roi

    # 5. Save Full
    cv.imwrite(full_out_path, processed_img, [cv.IMWRITE_JPEG_QUALITY, quality, cv.IMWRITE_JPEG_PROGRESSIVE, 1])
    metadata['File Size'] = os.path.getsize(full_out_path)

    # 6. Generate & Save Thumb
    scale = min(1200/w, 900/h)
    new_w, new_h = int(w * scale), int(h * scale)
    thumb = cv.resize(processed_img, (new_w, new_h), interpolation=cv.INTER_AREA)
    cv.imwrite(thumb_out_path, thumb, [cv.IMWRITE_JPEG_QUALITY, min(quality, 85), cv.IMWRITE_JPEG_PROGRESSIVE, 1])

    return (gallery_name, name_no_ext, metadata)

def update_gallery_repo():
    os.makedirs('tmp', exist_ok=True)
    if not os.path.exists('./tmp/gallery'):
        print(f" - Cloning gallery repo...")
        git.Repo.clone_from(GALLERY_REPO, 'tmp/gallery')
    else:
        print(f" - Pulling latest changes...")
        repo = git.Repo('./tmp/gallery')
        repo.remotes.origin.pull()

# --- Main Engine ---
def main():
    sys.stdout = DualLogger()

    parser = argparse.ArgumentParser(description='TheDoShoots Portfolio Engine')
    parser.add_argument('--select', nargs='+', help='Build specific galleries')
    parser.add_argument('--watermark', action='store_true', help='Apply watermark')
    parser.add_argument('--skip-repo', action='store_true', help='Skip git updates')
    parser.add_argument('--clean', action='store_true', help='Clean builds')
    parser.add_argument('--full-clean', action='store_true', help='Wipe everything')
    parser.add_argument('--force-download', action='store_true', help='Force verify downloads')
    parser.add_argument('-j', '--jobs', type=int, default=None, help='Threads')
    parser.add_argument('-q', '--quality', type=int, default=100, help='JPEG Quality')
    args = parser.parse_args()

    profiler = Profiler()
    num_workers = args.jobs or cpu_count()
    
    print(f"{color.BOLD}*** TheDoShoots Portfolio Engine ***{color.END}")
    print(f"Configuration: {num_workers} Workers | Quality: {args.quality}")
    
    # Check if CPU Affinity is supported
    if hasattr(os, 'sched_setaffinity'):
        print(f" - CPU Affinity: Enabled (Pinning processes to cores)")
    else:
        print(f" - CPU Affinity: Not supported on this OS (Standard scheduling)")

    target_keys = [k for k in GALLERY_EMOJIS.keys() if not args.select or k in args.select]
    print(f"Target Galleries ({len(target_keys)}):")
    for key in target_keys:
        emoji = GALLERY_EMOJIS.get(key, '')
        print(f" - {emoji} {key.title()} {emoji}")

    # --- STEP 0: CLEANUP ---
    if args.clean or args.full_clean:
        print(f"\n{color.BOLD}*** Step 0: Cleaning Workspace... ***{color.END}")
        step0_start = time.time()
        profiler.start('Cleanup')
        if args.full_clean and os.path.exists('./build'):
            print(" - [Full Clean] Removing build directory")
            shutil.rmtree('./build')
            if os.path.exists(PORTFOLIO_CSV_PATH): os.remove(PORTFOLIO_CSV_PATH)
        elif args.clean and os.path.exists(PORTFOLIOS_ROOT):
            print(" - [Fast Clean] Removing HTML/JSON/Thumbs (Keeping Fulls)")
            for g in os.listdir(PORTFOLIOS_ROOT):
                for item in ['index.html', 'thumbs', 'metadata', 'js', 'css']:
                    p = os.path.join(PORTFOLIOS_ROOT, g, item)
                    if os.path.exists(p):
                        if os.path.isdir(p): shutil.rmtree(p)
                        else: os.remove(p)
        profiler.stop('Cleanup')
        print(f"{color.BOLD}*** Step 0 Completed in {time.time() - step0_start:.2f}s ***{color.END}")

    # --- STEP 1: ASSETS & REPO ---
    print(f"\n{color.BOLD}*** Step 1: Updating Assets & Repo... ***{color.END}")
    step1_start = time.time()
    
    # Git
    if not args.skip_repo:
        profiler.start('Git Update')
        update_gallery_repo()
        profiler.stop('Git Update')
    
    # Asset Management
    profiler.start('Asset Download')
    os.makedirs('assets', exist_ok=True)
    
    # Logic: Download new CSV to temp, check if changed
    temp_csv_path = PORTFOLIO_CSV_PATH + ".tmp"
    csv_changed = True
    
    print(" - Checking Portfolio Manifest...")
    # Attempt download of CSV to temp
    if download_worker((PORTFOLIO_CSV_ID, temp_csv_path, None)):
        if os.path.exists(PORTFOLIO_CSV_PATH):
            old_hash = calculate_file_hash(PORTFOLIO_CSV_PATH)
            new_hash = calculate_file_hash(temp_csv_path)
            
            if old_hash == new_hash and not args.force_download:
                csv_changed = False
                os.remove(temp_csv_path) # Cleanup temp
                print(" - Manifest unchanged. Will only download missing files.")
            else:
                print(" - Manifest updated (or forced). Verifying all assets...")
                shutil.move(temp_csv_path, PORTFOLIO_CSV_PATH)
        else:
            print(" - Initial Manifest Download.")
            shutil.move(temp_csv_path, PORTFOLIO_CSV_PATH)
    else:
        print(" - Warning: Could not check Manifest (Offline?). Using local if available.")

    download_tasks = []
    galleries_to_process = []
    
    if os.path.exists(PORTFOLIO_CSV_PATH):
        with open(PORTFOLIO_CSV_PATH, 'r', encoding='utf-8') as f:
            reader = csv.DictReader(f)
            for row in reader:
                g = row['Gallery'].strip().lower()
                if g in target_keys:
                    fid = row.get('File ID') or row.get('Link')
                    fname = row['File Name']
                    cache_p = os.path.join(CACHE_ROOT, g, fname)
                    
                    # Always track logic for build step
                    galleries_to_process.append((g, fname, cache_p))
                    
                    # Add to download queue if:
                    # 1. Manifest changed OR
                    # 2. Local file is missing (even if manifest is same)
                    if csv_changed or not os.path.exists(cache_p):
                        download_tasks.append((fid, cache_p, None))
    
    # Run Downloads if we have tasks
    if download_tasks:
        print(f" - Downloading/Verifying {len(download_tasks)} assets...")
        with Pool(num_workers) as pool:
            list(tqdm.tqdm(pool.imap_unordered(download_worker, download_tasks), 
                           total=len(download_tasks), unit='file', desc="Downloading"))
    else:
        print(" - All assets are present locally.")
    
    profiler.stop('Asset Download', count=len(download_tasks))
    print(f"{color.BOLD}*** Step 1 Completed in {time.time() - step1_start:.2f}s ***{color.END}")

    # --- STEP 2: IMAGE PROCESSING ---
    print(f"\n{color.BOLD}*** Step 2: Processing Images... ***{color.END}")
    step2_start = time.time()
    profiler.start('Image Processing')
    
    gallery_map = {k: [] for k in target_keys}
    processing_tasks = []
    
    # Pre-load existing metadata
    existing_metadata = {}
    for g in target_keys:
        meta_path = os.path.join(PORTFOLIOS_ROOT, g, 'metadata', 'metadata.json')
        if os.path.exists(meta_path):
            try:
                with open(meta_path, 'r') as f:
                    existing_metadata[g] = json.load(f)
            except: pass

    results_map = {k: {} for k in target_keys}
    skipped_count = 0

    for gallery, fname, cache_path in galleries_to_process:
        if not os.path.exists(cache_path): continue

        g_root = os.path.join(PORTFOLIOS_ROOT, gallery)
        full_path = os.path.join(g_root, 'fulls', fname)
        thumb_path = os.path.join(g_root, 'thumbs', fname)
        
        os.makedirs(os.path.join(g_root, 'fulls'), exist_ok=True)
        os.makedirs(os.path.join(g_root, 'thumbs'), exist_ok=True)
        os.makedirs(os.path.join(g_root, 'metadata'), exist_ok=True)

        name_no_ext = os.path.splitext(fname)[0]
        gallery_map[gallery].append(fname)
        
        # --- SMART CHECK ---
        is_fully_cached = False
        if (os.path.exists(full_path) and os.path.exists(thumb_path) and 
            os.path.getmtime(full_path) > os.path.getmtime(cache_path)):
            
            if gallery in existing_metadata and name_no_ext in existing_metadata[gallery]:
                meta = existing_metadata[gallery][name_no_ext]
                # Reconstruct sorting key
                if 'EXIF DateTimeOriginal' in meta:
                    try:
                        dt_str = str(meta['EXIF DateTimeOriginal'])
                        meta['__dt'] = datetime.strptime(dt_str, "%Y:%m:%d %H:%M:%S").timestamp()
                    except:
                        meta['__dt'] = os.path.getmtime(cache_path)
                else:
                    meta['__dt'] = os.path.getmtime(cache_path)
                    
                results_map[gallery][name_no_ext] = meta
                is_fully_cached = True
                skipped_count += 1
        
        if not is_fully_cached:
            task = (cache_path, full_path, thumb_path, args.quality, args.watermark, gallery)
            processing_tasks.append(task)
    
    if skipped_count > 0:
        print(f" - Skipped {skipped_count} up-to-date images.")
    
    if processing_tasks:
        print(f" - Queued {len(processing_tasks)} images for processing...")
        
        # Initialize Shared Counter for Worker ID assignment
        worker_counter = Value('i', 0)
        
        # Init pool with cpu_pinning arguments
        with Pool(num_workers, initializer=init_worker, 
                  initargs=(WATERMARK_PATH, worker_counter, cpu_count())) as pool:
            for gallery_name, name_no_ext, meta in tqdm.tqdm(pool.imap_unordered(process_image_worker, processing_tasks), 
                                        total=len(processing_tasks), unit='img', desc="Processing"):
                results_map[gallery_name][name_no_ext] = meta
    else:
        print(" - All images are up to date.")
            
    profiler.stop('Image Processing', count=len(processing_tasks) + skipped_count)
    print(f"{color.BOLD}*** Step 2 Completed in {time.time() - step2_start:.2f}s ***{color.END}")

    # --- STEP 3: SITE GENERATION ---
    print(f"\n{color.BOLD}*** Step 3: Generating Sites... ***{color.END}")
    step3_start = time.time()
    profiler.start('Site Generation')
    
    for gallery in target_keys:
        if gallery not in gallery_map or not gallery_map[gallery]:
            continue

        emoji = GALLERY_EMOJIS.get(gallery, '')
        title = f"{emoji} {gallery.title()} {emoji}"
        print(f" - Building {title}")

        # Metadata
        g_root = os.path.join(PORTFOLIOS_ROOT, gallery)
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
        with open(os.path.join(g_root, 'metadata', 'metadata.json'), 'w') as f:
            json.dump(gallery_meta, f, indent=4)

        # Inject Assets
        tmpl_src = './tmp/gallery'
        if os.path.exists(tmpl_src):
            for asset in ['index.html', 'immersive.html', 'css', 'js', 'templates']:
                src = os.path.join(tmpl_src, asset)
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

    profiler.stop('Site Generation', count=len(target_keys))
    print(f"{color.BOLD}*** Step 3 Completed in {time.time() - step3_start:.2f}s ***{color.END}")
    
    # --- STEP 4: DEPLOYMENT PREP ---
    print(f"\n{color.BOLD}*** Step 4: Preparing Deployment... ***{color.END}")
    step4_start = time.time()
    profiler.start('Deployment Prep')
    
    deploy_assets = ['index.html', 'about.html', 'assets', 'LICENSE']
    for item in deploy_assets:
        src = item
        dst = os.path.join('./build', item)
        if os.path.exists(src):
            if os.path.isdir(src):
                if os.path.exists(dst): shutil.rmtree(dst)
                shutil.copytree(src, dst)
            else:
                shutil.copy2(src, dst)
            print(f" - Copied {item}")
        else:
            print(f" - Warning: {item} not found")
            
    profiler.stop('Deployment Prep')
    print(f"{color.BOLD}*** Step 4 Completed in {time.time() - step4_start:.2f}s ***{color.END}")

    # Stats
    cache_size = get_dir_size(CACHE_ROOT) if os.path.exists(CACHE_ROOT) else 0
    build_size = get_dir_size('./build') if os.path.exists('./build') else 0

    profiler.report()
    print(f"\n{color.BOLD}*** TheDoShoots Portfolio Build Complete! ***{color.END}")
    print(f" - Local Cache Size: {cache_size:.2f} MB")
    print(f" - Final Build Size: {build_size:.2f} MB")

if __name__ == '__main__':
    main()
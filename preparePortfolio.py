"""
TheDoShoots Portfolio Engine (Consolidated & Optimized)
-------------------------------------------------------
A single-file, high-performance build tool for photography portfolios.
Features:
- Global Parallelization (Image-level vs Gallery-level)
- Smart Incremental Builds (Skips worker queue for cached files)
- Manifest-Based Caching (Only verifies assets if missing or CSV changed)
- CPU Affinity Pinning (Locks workers to specific cores)
- Hybrid Processing: OpenCV for speed, PIL for EXIF preservation
- Auto-Logging and Profiling
"""

import os
import shutil

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
from PIL import Image, ImageOps  # Re-imported for EXIF I/O
import piexif

try:
    from modules import watermark as wm_module
except ImportError:
    # Handle case where run from root
    sys.path.append(os.getcwd())
    from modules import watermark as wm_module

try:
    from modules import logger as log_module
    from modules import builder as build_module
except ImportError:
    # Fallback/Root run
    pass

# Expose color for the rest of the script (aliasing)
color = log_module.color

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

try:
    from modules import downloader as dl_module
except ImportError:
    sys.path.append(os.getcwd())
    from modules import downloader as dl_module

def calculate_file_hash(filepath):
    return dl_module.calculate_file_hash(filepath)

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
        worker_watermark = wm_module.load_watermark(watermark_path)
        
    # 2. Set CPU Affinity
    try:
        if hasattr(os, 'sched_setaffinity'):
            with worker_counter.get_lock():
                worker_id = worker_counter.value
                worker_counter.value += 1
            
            core_id = worker_id % total_cores
            os.sched_setaffinity(0, {core_id})
    except Exception:
        pass

# --- Network Worker ---
# --- Network Worker ---
def download_worker(task):
    return dl_module.download_worker(task)

# --- Image Processing Worker ---
def process_image_worker(task):
    """
    Hybrid Pipeline:
    1. Read EXIF & Subsampling (PIL - Lazy)
    2. Process Image (OpenCV - Fast)
    3. Save Full (PIL - Preserves EXIF & Original Subsampling)
    4. Save Thumb (OpenCV - Fast, No EXIF)
    """
    source_path, full_out_path, thumb_out_path, quality, apply_watermark, gallery_name = task
    
    file_name = os.path.basename(source_path)
    name_no_ext = os.path.splitext(file_name)[0]
    
    metadata = {}
    exif_bytes = None
    original_subsampling = -1 # Default: let PIL choose based on quality

    # 1. Capture EXIF & Subsampling using PIL (Lazy read)
    try:
        with Image.open(source_path) as pil_img:
            exif_bytes = pil_img.info.get('exif')
            if hasattr(pil_img, 'subsampling'):
                original_subsampling = pil_img.subsampling
    except Exception:
        pass 

    # 2. Parse Metadata for JSON (using exifread)
    try:
        with open(source_path, 'rb') as f:
            # Removed stop_tag='DateTimeOriginal' to ensure FocalLength/ISO are read
            tags = exifread.process_file(f)
            for tag in tags.keys():
                if tag not in ('JPEGThumbnail', 'TIFFThumbnail'):
                    metadata[tag] = str(tags[tag])
            
            if 'EXIF DateTimeOriginal' in tags:
                metadata['__dt'] = datetime.strptime(str(tags['EXIF DateTimeOriginal']), "%Y:%m:%d %H:%M:%S").timestamp()
            else:
                metadata['__dt'] = os.path.getmtime(source_path)
    except Exception:
        metadata['__dt'] = os.path.getmtime(source_path)

    # 3. Safety Incremental Check
    thumb_480_path = thumb_out_path.replace(os.sep + 'thumbs' + os.sep, os.sep + 'thumbs' + os.sep + '480' + os.sep)
    thumb_800_path = thumb_out_path.replace(os.sep + 'thumbs' + os.sep, os.sep + 'thumbs' + os.sep + '800' + os.sep)
    if (os.path.exists(full_out_path) and os.path.exists(thumb_out_path) and
        os.path.exists(thumb_480_path) and os.path.exists(thumb_800_path) and
        os.path.getmtime(full_out_path) > os.path.getmtime(source_path)):

        if 'Image Width' not in metadata:
             img = cv.imread(full_out_path)
             if img is not None:
                h, w, _ = img.shape
                metadata['Image Width'], metadata['Image Height'] = w, h
        metadata['File Size'] = os.path.getsize(full_out_path)
        return (gallery_name, name_no_ext, metadata)

    # 4. Load Image (OpenCV)
    img = cv.imread(source_path)
    if img is None:
        return (gallery_name, name_no_ext, {"Error": "Corrupt Image"})

    # 4.5 Handle EXIF Orientation (Fix for upside-down watermarks)
    if exif_bytes:
        try:
            exif_dict = piexif.load(exif_bytes)
            orientation = exif_dict.get("0th", {}).get(piexif.ImageIFD.Orientation, 1)
            
            if orientation == 3:
                img = cv.rotate(img, cv.ROTATE_180)
            elif orientation == 6:
                img = cv.rotate(img, cv.ROTATE_90_CLOCKWISE)
            elif orientation == 8:
                img = cv.rotate(img, cv.ROTATE_90_COUNTERCLOCKWISE)
            
            # Reset orientation in EXIF so browser doesn't double-rotate
            if orientation != 1:
                exif_dict["0th"][piexif.ImageIFD.Orientation] = 1
                exif_bytes = piexif.dump(exif_dict)
        except Exception:
            pass

    h, w, _ = img.shape
    metadata['Image Width'] = w
    metadata['Image Height'] = h

    # 5. Watermarking (OpenCV)
    processed_img = img
    if apply_watermark and worker_watermark is not None:
        processed_img = wm_module.apply_watermark(img, worker_watermark)

    # 6. Save Full Resolution (Convert to PIL to inject EXIF)
    try:
        # Convert BGR (OpenCV) to RGB (PIL)
        img_rgb = cv.cvtColor(processed_img, cv.COLOR_BGR2RGB)
        pil_out = Image.fromarray(img_rgb)
        
        save_kwargs = {
            'quality': quality,
            'optimize': True,
            'progressive': True,
            'subsampling': original_subsampling # Preserve Original Subsampling
        }
        
        if exif_bytes:
            save_kwargs['exif'] = exif_bytes
            
        pil_out.save(full_out_path, format='JPEG', **save_kwargs)
        metadata['File Size'] = os.path.getsize(full_out_path)
    except Exception as e:
        print(f"Error Saving Full {name_no_ext}: {e}")

    # 7. Generate & Save Thumb (OpenCV - Fast, No EXIF needed)
    scale = min(1200/w, 900/h)
    new_w, new_h = int(w * scale), int(h * scale)
    thumb = cv.resize(processed_img, (new_w, new_h), interpolation=cv.INTER_AREA)
    cv.imwrite(thumb_out_path, thumb, [cv.IMWRITE_JPEG_QUALITY, min(quality, 85), cv.IMWRITE_JPEG_PROGRESSIVE, 1])

    # 7b. Generate & Save Responsive Thumb Variants (480w, 800w)
    for target_w in (800, 480):
        target_h = int(target_w * 0.75)  # 4:3 aspect to match 1200x900
        out = thumb_out_path.replace(os.sep + 'thumbs' + os.sep, os.sep + 'thumbs' + os.sep + str(target_w) + os.sep)
        os.makedirs(os.path.dirname(out), exist_ok=True)
        s = min(target_w / w, target_h / h)
        nw, nh = max(1, int(w * s)), max(1, int(h * s))
        small = cv.resize(processed_img, (nw, nh), interpolation=cv.INTER_AREA)
        cv.imwrite(out, small, [cv.IMWRITE_JPEG_QUALITY, 82, cv.IMWRITE_JPEG_PROGRESSIVE, 1])

    return (gallery_name, name_no_ext, metadata)

def update_gallery_repo():
    dl_module.update_gallery_repo(GALLERY_REPO, 'tmp/gallery')

# --- Main Engine ---
def main():
    sys.stdout = log_module.DualLogger()

    parser = argparse.ArgumentParser(description='TheDoShoots Portfolio Engine')
    parser.add_argument('--select', nargs='+', help='Build specific galleries')
    parser.add_argument('--watermark', action='store_true', help='Apply watermark')
    parser.add_argument('--skip-repo', action='store_true', help='Skip git updates')
    parser.add_argument('--clean', action='store_true', help='Clean builds')
    parser.add_argument('--full-clean', action='store_true', help='Wipe everything')
    parser.add_argument('--force-download', action='store_true', help='Force verify downloads')
    parser.add_argument('--html-only', action='store_true', help='Skip image processing, only update HTML/JS/CSS')
    parser.add_argument('-j', '--jobs', type=int, default=None, help='Threads')
    parser.add_argument('-q', '--quality', type=int, default=100, help='JPEG Quality')
    args = parser.parse_args()

    profiler = log_module.Profiler()
    verbose_logger = log_module.VerboseLogger()
    num_workers = args.jobs or cpu_count()
    
    print(f"{color.BOLD}*** TheDoShoots Portfolio Engine ***{color.END}")
    print(f"Configuration: {num_workers} Workers | Quality: {args.quality}")
    
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
                for item in ['index.html', 'license.html', 'immersive.html', 'thumbs', 'metadata', 'js', 'css']:
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
    manifest_success, _ = download_worker((PORTFOLIO_CSV_ID, temp_csv_path, None))
    if manifest_success:
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
                    
                    galleries_to_process.append((g, fname, cache_p))
                    
                    # Add to download queue if:
                    # 1. Manifest changed OR
                    # 2. Local file is missing (even if manifest is same)
                    if csv_changed or not os.path.exists(cache_p):
                        download_tasks.append((fid, cache_p, None))
    
    # Run Downloads if we have tasks
    if download_tasks:
        print(f" - Downloading/Verifying {len(download_tasks)} assets...")
        print(f"   (Detailed logs in {verbose_logger.path})")
        
        with Pool(num_workers) as pool:
            for (success, path) in tqdm.tqdm(pool.imap_unordered(download_worker, download_tasks), total=len(download_tasks), unit='file', desc="Downloading"):
                filename = os.path.basename(path)
                status = "Downloaded" if success else "Failed"
                verbose_logger.log(status, f"{filename}")

    else:
        print(" - All assets are present locally.")
    
    profiler.stop('Asset Download', count=len(download_tasks))
    print(f"{color.BOLD}*** Step 1 Completed in {time.time() - step1_start:.2f}s ***{color.END}")

    # --- SHORTCUT: HTML ONLY ---
    if args.html_only:
        print(f"\n{color.BOLD}*** [HTML-ONLY MODE] Skipping Step 2 (Processing) ***{color.END}")
        # We still need to populate results_map and gallery_map from existing metadata
        results_map = {k: {} for k in target_keys}
        gallery_map = {k: [] for k in target_keys}
        
        for g in target_keys:
            meta_path = os.path.join(PORTFOLIOS_ROOT, g, 'metadata', 'metadata.json')
            if os.path.exists(meta_path):
                print(f" - Loading metadata for {g}...")
                try:
                    with open(meta_path, 'r') as f:
                        meta = json.load(f)
                        results_map[g] = meta
                        gallery_map[g] = meta.get('image_order', [])
                except Exception as e:
                    print(f" - Error loading {g} metadata: {e}")
        
        # Jump directly to Step 3
    else:
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
            
            thumb_480_path = os.path.join(g_root, 'thumbs', '480', fname)
            thumb_800_path = os.path.join(g_root, 'thumbs', '800', fname)

            os.makedirs(os.path.join(g_root, 'fulls'), exist_ok=True)
            os.makedirs(os.path.join(g_root, 'thumbs'), exist_ok=True)
            os.makedirs(os.path.join(g_root, 'thumbs', '480'), exist_ok=True)
            os.makedirs(os.path.join(g_root, 'thumbs', '800'), exist_ok=True)
            os.makedirs(os.path.join(g_root, 'metadata'), exist_ok=True)

            name_no_ext = os.path.splitext(fname)[0]
            gallery_map[gallery].append(fname)

            # --- SMART CHECK ---
            is_fully_cached = False
            if (os.path.exists(full_path) and os.path.exists(thumb_path) and
                os.path.exists(thumb_480_path) and os.path.exists(thumb_800_path) and
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
                    verbose_logger.log("Skipped", f"{gallery}/{fname} (Up to date)")
            
            if not is_fully_cached:
                task = (cache_path, full_path, thumb_path, args.quality, args.watermark, gallery)
                processing_tasks.append(task)
        
        if skipped_count > 0:
            print(f" - Skipped {skipped_count} up-to-date images.")
            # Log skipped items (Retrospective logging since we didn't track names in the skipped block for logging, 
            # but we can log them as we add them to results_map if we wanted. 
            # For now, we trust the count or we could have logged them inside the loop above).
        
        if processing_tasks:
            print(f" - Queued {len(processing_tasks)} images for processing...")
            print(f"   (Detailed logs in {verbose_logger.path})")
            
            worker_counter = Value('i', 0)
            
            with Pool(num_workers, initializer=init_worker, 
                    initargs=(WATERMARK_PATH, worker_counter, cpu_count())) as pool:
                
                for (gallery_name, name_no_ext, meta) in tqdm.tqdm(pool.imap_unordered(process_image_worker, processing_tasks), total=len(processing_tasks), unit='img', desc="Processing"):
                    results_map[gallery_name][name_no_ext] = meta
                    
                    # Log details
                    wm_status = "Watermarked" if args.watermark else "Original"
                    verbose_logger.log("Processed", f"Gallery: {gallery_name} | Image: {name_no_ext} | Mode: {wm_status}")

        else:
            print(" - All images are up to date.")
                
        profiler.stop('Image Processing', count=len(processing_tasks) + skipped_count)
        print(f"{color.BOLD}*** Step 2 Completed in {time.time() - step2_start:.2f}s ***{color.END}")

    # --- STEP 3: SITE GENERATION ---
    print(f"\n{color.BOLD}*** Step 3: Generating Sites... ***{color.END}")
    step3_start = time.time()
    profiler.start('Site Generation')
    
    count = build_module.generate_site(target_keys, gallery_map, results_map, PORTFOLIOS_ROOT, GALLERY_EMOJIS)

    profiler.stop('Site Generation', count=count)
    print(f"{color.BOLD}*** Step 3 Completed in {time.time() - step3_start:.2f}s ***{color.END}")
    
    # --- STEP 4: DEPLOYMENT PREP ---
    print(f"\n{color.BOLD}*** Step 4: Preparing Deployment... ***{color.END}")
    step4_start = time.time()
    profiler.start('Deployment Prep')
    
    deploy_assets = ['index.html', 'about.html', 'linktree.html', 'license.html', 'assets', 'vlm', 'LICENSE']
    # manifest.json + sw.js are handled inside prepare_deployment (sw.js needs build-time stamping)
    build_module.prepare_deployment(deploy_assets)
    # Always include every gallery already present in the build. A selective
    # gallery rebuild must not shrink the portfolio-wide search index.
    build_module.generate_metadata_search_index(PORTFOLIOS_ROOT, GALLERY_EMOJIS.keys())
            
    profiler.stop('Deployment Prep')
    print(f"{color.BOLD}*** Step 4 Completed in {time.time() - step4_start:.2f}s ***{color.END}")

    # Stats
    cache_size = get_dir_size(CACHE_ROOT) if os.path.exists(CACHE_ROOT) else 0
    build_size = get_dir_size('./build') if os.path.exists('./build') else 0

    profiler.report()
    print(f"\n{color.BOLD}*** TheDoShoots Portfolio Build Complete! ***{color.END}")
    print(f" - Local Cache Size: {cache_size:.2f} MB")
    print(f" - Final Build Size: {build_size:.2f} MB")
    verbose_logger.close()

if __name__ == '__main__':
    main()
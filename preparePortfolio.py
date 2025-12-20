"""
TheDoShoots Portfolio Preparer
------------------------------
A multiprocessing-enabled build tool for generating photography galleries.
Handles Git synchronization, asset copying, EXIF data modification, and 
site generation via external scripts.
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
from multiprocessing import Pool, cpu_count

# --- Configuration ---
GALLERY_REPO = 'https://github.com/dotimothy/gallery.git'

# Map folder names to Display Titles
GALLERY_CONFIG = {
    'astronomy': '🌌 Astronomy 🌌',
    'wildlife':  '🐿️ Wildlife 🐿️'
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

def prepareGallery(args_tuple):
    """
    Worker function to build a single gallery.
    args_tuple: (gallery_name, gallery_title, modifyGPS, clean_build, dry_run)
    """
    gallery, title, modifyGPS, clean_build, dry_run = args_tuple
    log_prefix = f"[{gallery}]"

    if dry_run:
        time.sleep(0.5) # Simulate work
        return f"{gallery} (Dry Run)"

    # Define paths
    galleryDir = f'./{gallery}'
    htmlPath = f'./{gallery}/index.html'
    fullsPath = f'./{gallery}/fulls' # Path to full resolution images
    
    # 1. Clean build logic
    if clean_build and os.path.exists(galleryDir):
        shutil.rmtree(galleryDir)
    
    os.makedirs(galleryDir, exist_ok=True)

    # 2. EXIF MODIFICATION BLOCK
    if modifyGPS:
         print(f"{color.BOLD} {log_prefix} Modifying EXIF of Images...{color.END}")
         
         exif_script_path = os.path.abspath('./tmp/gallery/prepareExif.py')
         fulls_rel_path = f'../../{fullsPath}'

         print(f"{log_prefix} Starting Flask server...")
         server_process = subprocess.Popen(
             ['python', exif_script_path, '--fulls', fulls_rel_path],
             cwd='./tmp/gallery' 
         )

         # Poll until port is open
         host = '127.0.0.1'
         port = 8000
         max_retries = 30 
         
         for i in range(max_retries):
             if is_port_open(host, port):
                 print(f"{log_prefix} Server detected. Opening browser...")
                 webbrowser.open_new_tab(f'http://{host}:{port}')
                 break
             else:
                 time.sleep(1)
         else:
             print(f"{color.BOLD}{log_prefix} Warning: Flask server timed out.{color.END}")

         print(f"{color.BOLD} {log_prefix} Press Ctrl+C in terminal when finished with this gallery.{color.END}")
         try:
            server_process.wait()
         except KeyboardInterrupt:
            server_process.terminate()
         
         print(f"{log_prefix} EXIF modification finished.")
    
    # 3. Copy Assets
    assets_to_copy = ['prepareSite.py', 'index.html', 'css', 'js', 'templates']
    
    for asset in assets_to_copy:
        src = f'./tmp/gallery/{asset}'
        dst = f'./{gallery}/{asset}'
        
        if os.path.exists(src):
            if os.path.isdir(src):
                if os.path.exists(dst): shutil.rmtree(dst)
                shutil.copytree(src, dst)
            else:
                shutil.copyfile(src, dst)
        else:
             print(f"{log_prefix} Warning: Asset {asset} missing in template.")

    # 4. Modify HTML Title
    if os.path.exists(htmlPath):
        with open(htmlPath, 'r', encoding='utf-8') as file:
            content = file.read()
        
        import re
        content = re.sub(r'<title>.*?</title>', f'<title>{title}</title>', content, flags=re.DOTALL)
        content = re.sub(r'<h1 id="title">.*?</h1>', f'<h1 id="title">{title}</h1>', content, flags=re.DOTALL)
        
        with open(htmlPath, 'w', encoding='utf-8') as file:
            file.write(content)

    # 5. Modify JS Title
    jsPath = f'./{gallery}/js/app.js'
    if os.path.exists(jsPath):
        with open(jsPath, 'r', encoding='utf-8') as jsFile:
            jsContent = jsFile.read()
        
        jsContent = re.sub(r'const titleText = ".*Gallery Template.*";', f'const titleText = "{title}";', jsContent)
        
        with open(jsPath, 'w', encoding='utf-8') as jsFile:
            jsFile.write(jsContent)

    # 6. Run prepareSite.py
    # Silence stdout to keep the progress bar clean unless it fails
    try:
        subprocess.run(['python', 'prepareSite.py'], cwd=f'./{gallery}', check=True, stdout=subprocess.DEVNULL)
    except subprocess.CalledProcessError:
        print(f"{color.BOLD}{log_prefix} Error: prepareSite.py failed.{color.END}")

    return f"{gallery} Done"

if __name__ == '__main__':
    parser = argparse.ArgumentParser(description='TheDoShoots Portfolio Preparer')
    
    parser.add_argument('--exif', action='store_true', help='Launch EXIF Editor (Sequential mode only)')
    parser.add_argument('--select', nargs='+', help='Build only specific galleries (e.g. --select astronomy)')
    parser.add_argument('--skip-repo', action='store_true', help='Skip git clone/pull')
    parser.add_argument('--clean', action='store_true', help='Delete the target gallery folder before building')
    parser.add_argument('--dry-run', action='store_true', help='Print what would happen without modifying files')
    parser.add_argument('-j', '--jobs', type=int, default=None, help='Number of parallel processes (Default: Auto-scale)')

    args = parser.parse_args()

    print(f"{color.BOLD}*** TheDoShoots Portfolio Preparer ***{color.END}\n")

    # --- Step 1: Repo Management ---
    if not args.skip_repo:
        print(f"{color.BOLD}*** Step 1: Updating Template Repo *** {color.END}")
        updateGalleryRepo()
    else:
        print(f"{color.BOLD}*** Step 1: Skipping Repo Update *** {color.END}")

    print(f"\n{color.BOLD}*** Step 2: Building galleries ***{color.END}")

    # --- Step 2: Filter Galleries ---
    target_galleries = {}
    if args.select:
        for item in args.select:
            if item in GALLERY_CONFIG:
                target_galleries[item] = GALLERY_CONFIG[item]
            else:
                print(f"Warning: '{item}' is not valid. Available: {list(GALLERY_CONFIG.keys())}")
    else:
        target_galleries = GALLERY_CONFIG

    if not target_galleries:
        print("No galleries selected to build.")
        exit()

    # Prepare Task List
    tasks = []
    for g, t in target_galleries.items():
        tasks.append((g, t, args.exif, args.clean, args.dry_run))

    if args.dry_run:
        print(f"Dry Run Mode: Simulating build for {list(target_galleries.keys())}...")

    # --- Step 3: Execution ---
    if args.exif:
        print(f"{color.BOLD}Interactive EXIF mode detected. Running sequentially.{color.END}")
        for task in tasks:
            prepareGallery(task)
    else:
        # Smart Job Calculation
        if args.jobs is not None:
            count = args.jobs
        else:
            # Scale based on min(CPUs, Tasks)
            count = min(cpu_count() or 1, len(tasks))
        
        print(f"Building {len(tasks)} galleries using {count} worker processes...")
        
        # Parallel Execution
        with Pool(processes=count) as pool:
            results = list(tqdm.tqdm(pool.imap_unordered(prepareGallery, tasks), total=len(tasks)))

    print(f"\n{color.BOLD}All galleries prepared!{color.END}")
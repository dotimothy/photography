import os
import shutil
import git
import tqdm
import webbrowser
import argparse
import subprocess
import socket
import time # We'll still use a small sleep within the polling loop

GALLERY_REPO = 'https://github.com/dotimothy/gallery.git'

class color:
     BOLD = '\033[1m'
     END = '\033[0m'

def is_port_open(host, port, timeout=1):
    """
    Checks if a given TCP port on a host is open.
    Returns True if open, False otherwise.
    """
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
    os.makedirs('tmp', exist_ok=True)
    if not os.path.exists('./tmp/gallery'):
        print(f"{color.BOLD}Cloning gallery repo from {GALLERY_REPO}{color.END}")
        git.Repo.clone_from(GALLERY_REPO, 'tmp/gallery')
    else:
        print(f"Gallery repo ({GALLERY_REPO}) already exists. Pulling latest changes...")
        repo = git.Repo('./tmp/gallery')
        repo.remotes.origin.pull()

def prepareGallery(gallery, title='📷 Gallery Template!!! 📷', modifyGPS=False):
    print(f"{color.BOLD}Preparing {gallery} gallery!{color.END}")
    
    # Define paths
    galleryDir = f'./{gallery}'
    htmlPath = f'./{gallery}/index.html'
    pythonPath = f'./{gallery}/prepareSite.py'
    fullsPath = f'./{gallery}/fulls'
    
    # Create gallery directory if it doesn't exist
    os.makedirs(galleryDir, exist_ok=True)

    if modifyGPS:
         print(f"{color.BOLD} Modifying EXIF of Images!!!{color.END}")
         print(f"{color.BOLD} Please close the browser tab and press Ctrl+C in this terminal when finished.{color.END}")
         
         original_cwd = os.getcwd() # Save original current working directory
         os.chdir('./tmp/gallery')

         # Start the Flask server in a non-blocking way
         print("Starting EXIF modification server...")
         server_process = subprocess.Popen(
             ['python', 'prepareExif.py', '--fulls', f'../../{fullsPath}'],
         )

         # Poll until the server's port is open
         host = '127.0.0.1'
         port = 8000
         max_retries = 30 # Try for up to 30 seconds
         for i in range(max_retries):
             if is_port_open(host, port):
                 print(f"Flask server detected on {host}:{port}. Opening browser...")
                 webbrowser.open_new_tab(f'http://{host}:{port}')
                 break
             else:
                 print(f"Waiting for Flask server to start... (Attempt {i+1}/{max_retries})")
                 time.sleep(1) # Wait 1 second before retrying
         else:
             print(f"{color.BOLD}Warning: Flask server did not start on {host}:{port} within the expected time.{color.END}")

         # This will block until the server process terminates (e.g., by user Ctrl+C)
         server_process.wait()
         print("EXIF modification server stopped. Continuing script...")
         os.chdir(original_cwd) # Go back to the original working directory
    
    # 1. Copy Files and Folders
    # List of assets to copy from the template
    assets_to_copy = ['prepareSite.py', 'index.html', 'css', 'js', 'templates']
    
    for asset in assets_to_copy:
        src = f'./tmp/gallery/{asset}'
        dst = f'./{gallery}/{asset}'
        
        if os.path.exists(src):
            if os.path.isdir(src):
                # For directories, remove destination if it exists to ensure clean update, then copy
                if os.path.exists(dst):
                    shutil.rmtree(dst)
                shutil.copytree(src, dst)
                print(f"Updated directory: {asset}")
            else:
                # For files, just copy/overwrite
                shutil.copyfile(src, dst)
                print(f"Updated file: {asset}")
        else:
             print(f"Warning: Asset {asset} not found in template. Skipping.")

    # 2. Modify index.html title
    with open(htmlPath, 'r', encoding='utf-8') as file:
        content = file.read()
    
    # Replace the generic title with the specific gallery title
    # Note: The template might have different placeholders now. 
    # Based on checking, index.html has <h1 id="title"></h1> which is populated by JS?
    # No, wait. The previous code did string replacement on '📷 Gallery Template!!! 📷'.
    # Let's check the NEW index.html content I read earlier.
    # It has <title>Gallery Template</title> (line 7)
    # And <h1 id="title"></h1> (line 41).
    # It seems the previous string replacement strategy might fail if the placeholder changed.
    # The new index.html has <title>Gallery Template</title>.
    # I should replace THAT.
    
    # Use Regex to replace title and h1 robustly, regardless of current content
    import re
    
    # 1. Replace <title>...</title>
    content = re.sub(r'<title>.*?</title>', f'<title>{title}</title>', content, flags=re.DOTALL)
    
    # 2. Replace <h1 id="title">...</h1>
    content = re.sub(r'<h1 id="title">.*?</h1>', f'<h1 id="title">{title}</h1>', content, flags=re.DOTALL)
    
    with open(htmlPath, 'w', encoding='utf-8') as file:
        file.write(content)

    # 3. Replace JS Title in js/app.js
    # The app.js has a typeTitle function with hardcoded "📷 Gallery Template!!! 📷"
    jsPath = f'./{gallery}/js/app.js'
    if os.path.exists(jsPath):
        with open(jsPath, 'r', encoding='utf-8') as jsFile:
            jsContent = jsFile.read()
        
        # Replace the hardcoded string. 
        # We look for: const titleText = "📷 Gallery Template!!! 📷";
        # We replace it with: const titleText = "{title}";
        # Using regex again for safety against spaces/quotes
        jsContent = re.sub(r'const titleText = ".*Gallery Template.*";', f'const titleText = "{title}";', jsContent)
        
        with open(jsPath, 'w', encoding='utf-8') as jsFile:
            jsFile.write(jsContent)
            print(f"Updated app.js title for {gallery}")

    # 4. Run prepareSite.py
    print(f"Running prepareSite.py in {gallery}...")
    os.chdir(f'./{gallery}')
    # We need to make sure python calls the script in the correct cwd
    exit_code = os.system(f'python prepareSite.py')
    if exit_code != 0:
        print(f"{color.BOLD}Error: prepareSite.py failed for {gallery}{color.END}")
    
    os.chdir('..')
    print()


if __name__ == '__main__':
    parser = argparse.ArgumentParser(description='Flask EXIF Editor Application.')
    parser.add_argument('--exif', action='store_true', help='Flag to launch the EXIF Modification Web App')
    args = parser.parse_args()

    print(f"{color.BOLD}*** Preparing TheDoShoots Photography Portfolio ***{color.END}\n")
    print(f"{color.BOLD}*** Step 1: Basing Template gallery repo *** {color.END}")
    updateGalleryRepo()
    print(f"\n{color.BOLD}*** Step 2: Building galleries ***{color.END}\n")
    galleries = ['astronomy','wildlife']
    titles = ['🌌 Astronomy 🌌', '🐿️ Wildlife 🐿️']
    for gallery,title in zip(galleries,titles):
          prepareGallery(gallery,title, args.exif)
    print(f"{color.BOLD}All galleries prepared!{color.END}")
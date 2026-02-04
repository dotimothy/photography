import os
import requests
import hashlib
import git
import argparse
import sys

def calculate_file_hash(filepath):
    """Calculates MD5 hash of a file."""
    hasher = hashlib.md5()
    with open(filepath, 'rb') as f:
        buf = f.read()
        hasher.update(buf)
    return hasher.hexdigest()

def update_gallery_repo(repo_url, target_dir='tmp/gallery'):
    """
    Clones or pulls the gallery repository.
    """
    os.makedirs(os.path.dirname(target_dir), exist_ok=True)
    if not os.path.exists(target_dir):
        print(f" - Cloning gallery repo from {repo_url}...")
        git.Repo.clone_from(repo_url, target_dir)
    else:
        print(f" - Pulling latest changes in {target_dir}...")
        repo = git.Repo(target_dir)
        repo.remotes.origin.pull()

def download_worker(task):
    """Downloads a single asset using a persistent session strategy."""
    # task can be (input_val, cache_path, _) or just (input_val, cache_path)
    # supporting flexible unpacking
    if len(task) == 3:
        input_val, cache_path, _ = task
    else:
        input_val, cache_path = task
    
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
            print(f"Downloaded: {cache_path}")
            return 1
        else:
            print(f"Failed to download {file_id}: Status {response.status_code}")
            return 0
    except Exception as e:
        print(f"Download Error {cache_path}: {e}")
        return 0

def main():
    parser = argparse.ArgumentParser(description='Standalone Downloader Module')
    subparsers = parser.add_subparsers(dest='command', help='Commands')

    # Git command
    git_parser = subparsers.add_parser('git', help='Update/Clone Git Repo')
    git_parser.add_argument('--url', required=True, help='Repository URL')
    git_parser.add_argument('--dest', default='tmp/gallery', help='Destination directory')

    # Download command
    dl_parser = subparsers.add_parser('download', help='Download GDrive File')
    dl_parser.add_argument('--id', required=True, help='File ID or URL')
    dl_parser.add_argument('--output', required=True, help='Output file path')

    args = parser.parse_args()

    if args.command == 'git':
        update_gallery_repo(args.url, args.dest)
    
    elif args.command == 'download':
        download_worker((args.id, args.output, None))
    
    else:
        parser.print_help()

if __name__ == '__main__':
    main()

import cv2 as cv
import os
import argparse
import sys
import numpy as np
from pathlib import Path
from multiprocessing import Pool, cpu_count
import tqdm

def load_watermark(watermark_path):
    """
    Loads the watermark image from the specified path.
    Returns the loaded image or None if loading fails.
    """
    if not os.path.exists(watermark_path):
        print(f"Error: Watermark file not found at {watermark_path}")
        return None
    
    watermark = cv.imread(watermark_path, cv.IMREAD_UNCHANGED)
    if watermark is None:
        print(f"Error: Failed to load watermark from {watermark_path}")
    return watermark

def apply_watermark(image, watermark, opacity=0.8, scale_ratio=0.25):
    """
    Applies the watermark to the given image.
    
    Args:
        image: The target image (OpenCV object).
        watermark: The watermark image (OpenCV object, supporting transparency).
        opacity: Opacity level of the watermark (default: 0.7).
        scale_ratio: Watermark width relative to the target image width (default: 0.25).
        
    Returns:
        The processed image with watermark applied.
    """
    if watermark is None or image is None:
        return image

    h, w = image.shape[:2]
    
    # Calculate target dimensions
    wm_target_w = int(w * scale_ratio)
    wm_aspect = watermark.shape[0] / watermark.shape[1]
    wm_target_h = int(wm_target_w * wm_aspect)
    
    if wm_target_w <= 0 or wm_target_h <= 0:
        return image

    # Resize watermark
    wm_resized = cv.resize(watermark, (wm_target_w, wm_target_h), interpolation=cv.INTER_AREA)
    
    # Positioning logic (Bottom Right with padding)
    pad_y = 0
    pad_x = 0
    
    y1, y2 = h - wm_target_h - pad_y, h - pad_y
    x1, x2 = w - wm_target_w - pad_x, w - pad_x
    
    if y1 < 0 or x1 < 0:
        return image


    # Alpha Blending
    if wm_resized.shape[2] == 4: # RGBA
        wm_bgr = wm_resized[:, :, :3]
        
        # --- Adaptive Logic ---
        # Calculate ROI brightness (Luma standard for BGR: 0.114 B + 0.587 G + 0.299 R)
        roi = image[y1:y2, x1:x2]
        roi_mean = np.mean(roi, axis=(0, 1))
        bg_brightness = 0.114 * roi_mean[0] + 0.587 * roi_mean[1] + 0.299 * roi_mean[2]
        
        # Calculate Watermark brightness (ignoring transparent pixels)
        wm_alpha_raw = wm_resized[:, :, 3]
        mask = wm_alpha_raw > 0
        if np.any(mask):
            masked_bgr = wm_bgr[mask] # (N, 3)
            # Vectorized mean of visible pixels
            mean_b = np.mean(masked_bgr[:, 0])
            mean_g = np.mean(masked_bgr[:, 1])
            mean_r = np.mean(masked_bgr[:, 2])
            wm_brightness = 0.114 * mean_b + 0.587 * mean_g + 0.299 * mean_r
        else:
            wm_brightness = 128.0 # Fallback

        # Enforce Logic:
        # 1. Bright Background (>128) -> Needs Dark Watermark (<128)
        # 2. Dark Background (<=128) -> Needs Bright Watermark (>128)
        if bg_brightness > 128:
            if wm_brightness > 128:
                 wm_bgr = 255 - wm_bgr
        else:
            if wm_brightness <= 128:
                 wm_bgr = 255 - wm_bgr
            
        wm_alpha = wm_resized[:, :, 3] / 255.0
        wm_alpha = wm_alpha * opacity
        
        # Vectorized Blending for performance
        wm_alpha_3c = np.dstack([wm_alpha] * 3)
        
        # Perform blending
        blended = (wm_alpha_3c * wm_bgr + (1.0 - wm_alpha_3c) * roi)
            
        final_image = image.copy()
        final_image[y1:y2, x1:x2] = blended.astype(np.uint8)
        return final_image
    else:
        # Fallback for non-transparent watermarks (just overwrite)
        final_image = image.copy()
        final_image[y1:y2, x1:x2] = wm_resized
        return final_image

# --- Worker Logic ---
worker_watermark = None

def init_worker(watermark_path):
    """Initializer for worker processes to load watermark once."""
    global worker_watermark
    worker_watermark = load_watermark(watermark_path)

def process_batch_item(task):
    """Worker function for batch processing."""
    source_path, dest_path, opacity = task
    
    if worker_watermark is None:
        return False

    return process_file_internal(source_path, dest_path, worker_watermark, opacity)

def process_file_internal(source_path, dest_path, watermark, opacity):
    """Internal processing logic."""
    img = cv.imread(str(source_path))
    if img is None:
        # print(f"Failed to read image: {source_path}") # Quiet in batch
        return False
        
    processed_img = apply_watermark(img, watermark, opacity=opacity)
    
    os.makedirs(os.path.dirname(dest_path), exist_ok=True)
    cv.imwrite(str(dest_path), processed_img, [cv.IMWRITE_JPEG_QUALITY, 95])
    return True

def main():
    parser = argparse.ArgumentParser(description='Standalone Watermark Module')
    parser.add_argument('--input', '-i', required=True, help='Input file or directory')
    parser.add_argument('--output', '-o', help='Output file or directory (Optional)')
    parser.add_argument('--watermark', '-w', default='./assets/watermark.png', help='Path to watermark image')
    parser.add_argument('--opacity', type=float, default=0.7, help='Watermark opacity (0.0 - 1.0)')
    parser.add_argument('--jobs', '-j', type=int, default=cpu_count(), help='Number of parallel jobs')
    
    args = parser.parse_args()
    
    input_path = Path(args.input)
    
    if not input_path.exists():
        print(f"Input path does not exist: {input_path}")
        sys.exit(1)

    # validate watermark path before starting
    if not os.path.exists(args.watermark):
         print(f"Error: Watermark file not found at {args.watermark}")
         sys.exit(1)

    if input_path.is_file():
        # Single File Processing (No Pool needed)
        watermark = load_watermark(args.watermark)
        if args.output:
            dest_path = Path(args.output)
            if dest_path.is_dir():
               dest_path = dest_path / input_path.name
        else:
            p = input_path
            dest_path = p.parent / f"{p.stem}_watermarked{p.suffix}"
            
        print(f"Processing single file: {input_path}")
        if process_file_internal(input_path, dest_path, watermark, args.opacity):
            print(f"Saved to: {dest_path}")
        
    elif input_path.is_dir():
        # Batch Processing
        output_dir = Path(args.output) if args.output else input_path.parent / f"{input_path.name}_watermarked"
        output_dir.mkdir(parents=True, exist_ok=True)
        
        extensions = {'.jpg', '.jpeg', '.png', '.bmp', '.tiff'}
        files = [f for f in input_path.iterdir() if f.suffix.lower() in extensions]
        
        print(f"Found {len(files)} images in {input_path}")
        print(f"Processing with {args.jobs} workers at opacity {args.opacity}...")
        
        tasks = []
        for f in files:
            dest = output_dir / f.name
            tasks.append((f, dest, args.opacity))
            
        with Pool(args.jobs, initializer=init_worker, initargs=(args.watermark,)) as pool:
            results = list(tqdm.tqdm(pool.imap_unordered(process_batch_item, tasks), total=len(tasks), unit='img'))
            
        print(f"Batch processing complete. Output: {output_dir}")

if __name__ == "__main__":
    main()

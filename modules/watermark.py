import cv2 as cv
import os
import argparse
import sys
import numpy as np
from pathlib import Path

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

def apply_watermark(image, watermark, opacity=0.7, scale_ratio=0.25):
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
        wm_alpha = wm_resized[:, :, 3] / 255.0
        wm_alpha = wm_alpha * opacity
        
        roi = image[y1:y2, x1:x2]
        
        for c in range(0, 3):
            roi[:, :, c] = (wm_alpha * wm_bgr[:, :, c] + (1.0 - wm_alpha) * roi[:, :, c])
            
        final_image = image.copy()
        final_image[y1:y2, x1:x2] = roi
        return final_image
    else:
        # Fallback for non-transparent watermarks (just overwrite)
        final_image = image.copy()
        final_image[y1:y2, x1:x2] = wm_resized
        return final_image

def process_file(source_path, dest_path, watermark):
    """
    Reads an image, applies watermark, and saves it.
    """
    img = cv.imread(str(source_path))
    if img is None:
        print(f"Failed to read image: {source_path}")
        return False
        
    processed_img = apply_watermark(img, watermark)
    
    # Create directory if it doesn't exist
    os.makedirs(os.path.dirname(dest_path), exist_ok=True)
    
    # Save (preserve metadata/quality not main focus here, just the watermark logic as per request)
    # Using defaults for CV write
    cv.imwrite(str(dest_path), processed_img, [cv.IMWRITE_JPEG_QUALITY, 95])
    print(f"Processed: {source_path} -> {dest_path}")
    return True

def main():
    parser = argparse.ArgumentParser(description='Standalone Watermark Module')
    parser.add_argument('--input', '-i', required=True, help='Input file or directory')
    parser.add_argument('--output', '-o', help='Output file or directory (Optional). Defaults to <input>_watermarked')
    parser.add_argument('--watermark', '-w', default='./assets/watermark.png', help='Path to watermark image')
    
    args = parser.parse_args()
    
    # Load Watermark
    watermark = load_watermark(args.watermark)
    if watermark is None:
        sys.exit(1)
        
    input_path = Path(args.input)
    
    if not input_path.exists():
        print(f"Input path does not exist: {input_path}")
        sys.exit(1)

    if input_path.is_file():
        # Single File Processing
        if args.output:
            dest_path = Path(args.output)
            if dest_path.is_dir(): # User gave a dir
               dest_path = dest_path / input_path.name
        else:
            p = input_path
            dest_path = p.parent / f"{p.stem}_watermarked{p.suffix}"
            
        process_file(input_path, dest_path, watermark)
        
    elif input_path.is_dir():
        # Batch Processing
        output_dir = Path(args.output) if args.output else input_path.parent / f"{input_path.name}_watermarked"
        output_dir.mkdir(parents=True, exist_ok=True)
        
        extensions = {'.jpg', '.jpeg', '.png', '.bmp', '.tiff'}
        
        files = [f for f in input_path.iterdir() if f.suffix.lower() in extensions]
        print(f"Found {len(files)} images in {input_path}")
        
        for f in files:
            dest = output_dir / f.name
            process_file(f, dest, watermark)

if __name__ == "__main__":
    main()

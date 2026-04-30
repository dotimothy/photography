"""Generate PWA icons (192/512) for the manifest.

If `assets/source-icon.png` exists (the user-supplied 1024x1024 brand source),
downscale it to 192/512. Otherwise emit a stylized procedural camera
silhouette as a serviceable fallback.
"""
import os
from PIL import Image, ImageDraw


def fallback(size: int, path: str) -> None:
    img = Image.new('RGBA', (size, size), (5, 5, 5, 255))
    d = ImageDraw.Draw(img)
    cx, cy = size // 2, size // 2
    bw, bh = int(size * 0.70), int(size * 0.42)
    bx, by = cx - bw // 2, cy - bh // 2
    d.rounded_rectangle([bx, by, bx + bw, by + bh],
                        radius=int(size * 0.04),
                        outline=(0, 229, 255, 255),
                        width=max(2, size // 64))
    pw, ph = int(size * 0.22), int(size * 0.07)
    d.rounded_rectangle([cx - pw // 2, by - ph, cx + pw // 2, by],
                        radius=int(size * 0.02),
                        outline=(0, 229, 255, 255),
                        width=max(2, size // 64))
    lr = int(size * 0.16)
    d.ellipse([cx - lr, cy - lr, cx + lr, cy + lr],
              outline=(0, 229, 255, 255), width=max(2, size // 64))
    lr2 = int(size * 0.10)
    d.ellipse([cx - lr2, cy - lr2, cx + lr2, cy + lr2],
              outline=(0, 229, 255, 200), width=max(1, size // 96))
    img.save(path, 'PNG', optimize=True)
    print(f' - Wrote {path} ({size}x{size}, fallback)')


def main() -> None:
    src = 'assets/source-icon.png'
    targets = [(192, 'assets/icon-192.png'), (512, 'assets/icon-512.png')]
    if os.path.exists(src):
        base = Image.open(src).convert('RGBA')
        for s, p in targets:
            base.resize((s, s), Image.LANCZOS).save(p, 'PNG', optimize=True)
            print(f' - Wrote {p} (from source-icon.png)')
    else:
        print(' - No assets/source-icon.png found — using procedural fallback')
        for s, p in targets:
            fallback(s, p)


if __name__ == '__main__':
    main()

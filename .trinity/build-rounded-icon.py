#!/usr/bin/env python3
"""
Generate macOS app icon with squircle (rounded corners) baked in.
Uses the Apple superellipse formula: |x|^n + |y|^n = r^n (n≈5)
"""
import math
import os
import subprocess
import tempfile
from PIL import Image, ImageDraw

SOURCE = "/Users/playra/BrowserOS/assets/trinity-logo-full.jpg"
APP_DIR = "/Users/playra/Desktop/TRI.app"
ICON_SIZE = 1024  # Base size for the icon

def create_squircle_mask(size: int, corner_ratio: float = 0.4, n: float = 5.0) -> Image.Image:
    """Create a squircle mask using Apple's superellipse formula."""
    mask = Image.new('L', (size, size), 0)
    draw = ImageDraw.Draw(mask)
    
    cx, cy = size / 2, size / 2
    r = size / 2 * corner_ratio  # Radius for the superellipse
    
    # Draw filled squircle using point-by-point approach
    for y in range(size):
        for x in range(size):
            # Normalize coordinates to [-1, 1]
            nx = (x - cx) / r
            ny = (y - cy) / r
            
            # Superellipse equation: |x|^n + |y|^n <= 1
            if abs(nx) < 1e-10:
                nx = 1e-10
            if abs(ny) < 1e-10:
                ny = 1e-10
                
            val = abs(nx) ** n + abs(ny) ** n
            if val <= 1.0:
                mask.putpixel((x, y), 255)
    
    return mask

def create_squircle_mask_fast(size: int, padding: float = 0.1, n: float = 5.0) -> Image.Image:
    """Create squircle mask using polygon approximation (much faster)."""
    mask = Image.new('L', (size, size), 0)
    draw = ImageDraw.Draw(mask)
    
    cx, cy = size / 2, size / 2
    # The squircle should fill most of the image, with some padding
    r = size / 2 * (1 - padding)
    
    # Generate points along the superellipse
    points = []
    num_points = 360
    for i in range(num_points):
        angle = 2 * math.pi * i / num_points
        cos_a = math.cos(angle)
        sin_a = math.sin(angle)
        
        # Superellipse: x = sign(cos) * |cos|^(2/n), y = sign(sin) * |sin|^(2/n)
        exp = 2.0 / n
        x = math.copysign(abs(cos_a) ** exp, cos_a) * r + cx
        y = math.copysign(abs(sin_a) ** exp, sin_a) * r + cy
        points.append((x, y))
    
    draw.polygon(points, fill=255)
    return mask

def main():
    print("=== Building TRI icon with squircle (rounded corners) ===")
    
    # Step 1: Open source image
    print("[1/5] Loading source image...")
    img = Image.open(SOURCE).convert("RGBA")
    print(f"  Source size: {img.size}")
    
    # Step 2: Resize to 1024x1024
    print("[2/5] Resizing to 1024x1024...")
    img = img.resize((ICON_SIZE, ICON_SIZE), Image.LANCZOS)
    
    # Step 3: Apply squircle mask (rounded corners)
    print("[3/5] Applying squircle mask (n=5, Apple superellipse)...")
    mask = create_squircle_mask_fast(ICON_SIZE, padding=0.08, n=5.0)
    
    # Apply mask as alpha channel
    img.putalpha(mask)
    
    # Add white background (macOS icons typically have no transparency in the .icns)
    # Actually, keep RGBA with transparency for proper masking
    # But for .icns we need it without alpha since macOS handles the shape
    
    # For a macOS icon, we want the image to fill the squircle with a background
    bg = Image.new('RGBA', (ICON_SIZE, ICON_SIZE), (0, 0, 0, 0))
    bg.paste(img, (0, 0), img)
    img = bg
    
    # Save the masked icon
    work_dir = tempfile.mkdtemp(prefix="tri_icon_")
    masked_path = os.path.join(work_dir, "masked_1024.png")
    img.save(masked_path, "PNG")
    print(f"  Masked icon saved: {masked_path}")
    
    # Step 4: Generate all icon sizes
    print("[4/5] Generating icon sizes...")
    iconset_dir = os.path.join(work_dir, "AppIcon.iconset")
    os.makedirs(iconset_dir, exist_ok=True)
    
    sizes = [
        ("icon_16x16.png", 16),
        ("icon_16x16@2x.png", 32),
        ("icon_32x32.png", 32),
        ("icon_32x32@2x.png", 64),
        ("icon_128x128.png", 128),
        ("icon_128x128@2x.png", 256),
        ("icon_256x256.png", 256),
        ("icon_256x256@2x.png", 512),
        ("icon_512x512.png", 512),
        ("icon_512x512@2x.png", 1024),
    ]
    
    for name, size in sizes:
        resized = img.resize((size, size), Image.LANCZOS)
        path = os.path.join(iconset_dir, name)
        resized.save(path, "PNG")
        print(f"  {name} ({size}x{size})")
    
    # Step 5: Build .icns
    print("[5/5] Building AppIcon.icns...")
    icns_path = os.path.join(work_dir, "AppIcon.icns")
    result = subprocess.run(
        ["iconutil", "-c", "icns", iconset_dir, "-o", icns_path],
        capture_output=True, text=True
    )
    if result.returncode != 0:
        print(f"  iconutil error: {result.stderr}")
        # Fallback: just copy the 1024x1024 PNG
        print("  Falling back to PNG...")
        icns_path = None
    else:
        icns_size = os.path.getsize(icns_path)
        print(f"  Built: AppIcon.icns ({icns_size} bytes)")
    
    # Install to app bundle
    resources_dir = os.path.join(APP_DIR, "Contents", "Resources")
    os.makedirs(resources_dir, exist_ok=True)
    
    if icns_path:
        import shutil
        shutil.copy2(icns_path, os.path.join(resources_dir, "AppIcon.icns"))
    
    # Also save the 512x512 PNG
    img_512 = img.resize((512, 512), Image.LANCZOS)
    img_512.save(os.path.join(resources_dir, "AppIcon.png"), "PNG")
    
    # Save a copy of the rounded icon for reference
    rounded_path = "/Users/playra/BrowserOS/assets/trinity-logo-rounded.png"
    img.save(rounded_path, "PNG")
    print(f"  Rounded icon saved: {rounded_path}")
    
    # Cleanup
    import shutil
    shutil.rmtree(work_dir, ignore_errors=True)
    
    print("")
    print("=== Done! ===")
    print(f"Icon with squircle (rounded corners) installed to {APP_DIR}")

if __name__ == "__main__":
    main()

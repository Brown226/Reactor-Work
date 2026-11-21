"""Convert a PDF to per-page PNG images using pypdfium2.

pypdfium2 ships its own PDFium binary inside the Python wheel, so no system
dependency (Poppler / ImageMagick) is required.

Usage:
    python convert_pdf_to_images.py <input.pdf> <output_dir> [--dpi 200] [--max-dim 1000]
"""

import argparse
import os
import sys

import pypdfium2 as pdfium
from PIL import Image


def convert(pdf_path: str, output_dir: str, dpi: int = 200, max_dim: int = 1000) -> None:
    os.makedirs(output_dir, exist_ok=True)

    # PDFium expects a scale factor where 1.0 == 72 DPI.
    scale = dpi / 72.0

    pdf = pdfium.PdfDocument(pdf_path)
    try:
        for i, page in enumerate(pdf):
            bitmap = page.render(scale=scale)
            image = bitmap.to_pil()

            width, height = image.size
            if max_dim and (width > max_dim or height > max_dim):
                factor = min(max_dim / width, max_dim / height)
                image = image.resize((int(width * factor), int(height * factor)), Image.LANCZOS)

            image_path = os.path.join(output_dir, f"page_{i + 1}.png")
            image.save(image_path)
            print(f"Saved page {i + 1} as {image_path} (size: {image.size})")

        print(f"Converted {len(pdf)} pages to PNG images")
    finally:
        pdf.close()


def main() -> None:
    parser = argparse.ArgumentParser(description="Convert a PDF to per-page PNG images.")
    parser.add_argument("pdf_path", help="Input PDF file")
    parser.add_argument("output_dir", help="Output directory for PNG images")
    parser.add_argument("--dpi", type=int, default=200, help="Render DPI (default: 200)")
    parser.add_argument(
        "--max-dim",
        type=int,
        default=1000,
        help="Resize so the longer side is at most this many pixels (0 disables, default: 1000)",
    )
    args = parser.parse_args()

    convert(args.pdf_path, args.output_dir, dpi=args.dpi, max_dim=args.max_dim or 0)


if __name__ == "__main__":
    try:
        main()
    except FileNotFoundError as e:
        print(f"Error: {e}", file=sys.stderr)
        sys.exit(1)

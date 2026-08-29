#!/usr/bin/env python3
"""
Generates the two icons the Teams app manifest requires:

  - color.png   192x192, full-colour, opaque background. Shown in the Teams
                 app catalogue, the app details dialog, and the "..." more
                 apps flyout.
  - outline.png  32x32, transparent background, white line art only (per
                 Microsoft's Teams icon guidelines: no fill, no colour).
                 Shown in the Teams left rail when the app is pinned.

Both icons depict a simple pulse/heartbeat line inside a rounded square,
echoing "TrialPulse" without any text (small icons don't render text
legibly). Run with: python3 teams/scripts/generate_icons.py
"""
from pathlib import Path

from PIL import Image, ImageDraw

OUT_DIR = Path(__file__).resolve().parent.parent / "manifest"

# Matches the --tp-color-accent design token used throughout the Teams tab
# (see packages/teams-tab/src/styles/tokens.css), so the app icon and the
# in-app accent colour are visually consistent.
BRAND_PURPLE = (63, 61, 138, 255)  # #3f3d8a
WHITE = (255, 255, 255, 255)
TRANSPARENT = (0, 0, 0, 0)


def pulse_points(width: float, height: float) -> list[tuple[float, float]]:
    """A simple ECG-style pulse line, scaled to the given box."""
    mid = height / 2
    return [
        (width * 0.08, mid),
        (width * 0.28, mid),
        (width * 0.38, mid - height * 0.22),
        (width * 0.48, mid + height * 0.30),
        (width * 0.56, mid - height * 0.34),
        (width * 0.64, mid),
        (width * 0.92, mid),
    ]


def make_color_icon(size: int = 192) -> Image.Image:
    img = Image.new("RGBA", (size, size), TRANSPARENT)
    draw = ImageDraw.Draw(img)

    corner_radius = int(size * 0.22)
    draw.rounded_rectangle([(0, 0), (size - 1, size - 1)], radius=corner_radius, fill=BRAND_PURPLE)

    margin = size * 0.18
    box_w = size - 2 * margin
    box_h = size * 0.36
    points = [(margin + x, size / 2 - box_h / 2 + y) for x, y in pulse_points(box_w, box_h)]
    line_width = max(2, size // 24)
    draw.line(points, fill=WHITE, width=line_width, joint="curve")
    for point in (points[0], points[-1]):
        r = line_width / 2
        draw.ellipse([(point[0] - r, point[1] - r), (point[0] + r, point[1] + r)], fill=WHITE)

    return img


def make_outline_icon(size: int = 32) -> Image.Image:
    img = Image.new("RGBA", (size, size), TRANSPARENT)
    draw = ImageDraw.Draw(img)

    margin = size * 0.12
    box_w = size - 2 * margin
    box_h = size * 0.5
    points = [(margin + x, size / 2 - box_h / 2 + y) for x, y in pulse_points(box_w, box_h)]
    draw.line(points, fill=WHITE, width=2, joint="curve")

    return img


def main() -> None:
    OUT_DIR.mkdir(parents=True, exist_ok=True)
    color_path = OUT_DIR / "color.png"
    outline_path = OUT_DIR / "outline.png"

    make_color_icon().save(color_path, format="PNG")
    make_outline_icon().save(outline_path, format="PNG")

    for path, expected_size in ((color_path, 192), (outline_path, 32)):
        with Image.open(path) as check:
            assert check.size == (expected_size, expected_size), f"{path} has wrong size {check.size}"
            assert path.stat().st_size > 0, f"{path} is zero bytes"
    print(f"Wrote {color_path} and {outline_path}")


if __name__ == "__main__":
    main()

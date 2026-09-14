"""Renders the LeggiMi launcher icon (same drawing as the Android adaptive icon)
into the legacy mipmap PNGs and a 512px preview for the README."""
from PIL import Image, ImageDraw
import math
import os

HERE = os.path.dirname(os.path.abspath(__file__))
RES = os.path.join(HERE, "..", "..", "android", "app", "src", "main", "res")

INK = (23, 22, 26, 255)
MINT = (107, 203, 119, 255)
MINT_HI = (134, 216, 144, 255)
PAPER = (255, 253, 247, 255)
CORAL = (255, 107, 107, 255)
YELLOW = (255, 217, 61, 255)


def draw_icon(size, inset=0.0, background=True, round_mask=False):
    """inset 0 = art fills the tile (adaptive foreground layer),
    inset ~0.12 = legacy icon (art pulled in a bit)."""
    S = size
    ss = 4  # supersampling for smooth outlines
    W = S * ss
    img = Image.new("RGBA", (W, W), (0, 0, 0, 0))
    d = ImageDraw.Draw(img)
    if background:
        d.rectangle([0, 0, W, W], fill=MINT)
        d.polygon([(0, 0), (W, W), (W, 0)], fill=MINT_HI)

    scale = (W / 108.0) * (1.0 - inset * 2)
    off = W * inset

    def px(v):
        return off + v * scale

    stroke = max(2, int(3.5 * scale))

    # ---- sheet, drawn on its own layer and rotated by -8 degrees around (43,50)
    sheet = Image.new("RGBA", (W, W), (0, 0, 0, 0))
    sd = ImageDraw.Draw(sheet)
    sd.rounded_rectangle([px(23), px(19), px(63), px(83)], radius=px(4) - off, fill=PAPER, outline=INK, width=stroke)
    # yellow bookmark
    bm = [(px(50), px(19)), (px(59), px(19)), (px(59), px(34)), (px(54.5), px(30.5)), (px(50), px(34))]
    sd.polygon(bm, fill=YELLOW, outline=INK, width=max(2, int(3 * scale)))
    lw = max(2, int(3.5 * scale))
    for y, x2 in ((42, 46), (51, 54), (60, 54), (69, 46)):
        sd.line([(px(30), px(y)), (px(x2), px(y))], fill=INK, width=lw)
        for x in (30, x2):
            sd.ellipse([px(x) - lw / 2, px(y) - lw / 2, px(x) + lw / 2, px(y) + lw / 2], fill=INK)
    sheet = sheet.rotate(8, resample=Image.BICUBIC, center=(px(43), px(50)))
    img.alpha_composite(sheet)
    d = ImageDraw.Draw(img)

    # ---- speech bubble: tail first, bubble on top hides the tail's top edge
    tail = [(px(61), px(76)), (px(74), px(76)), (px(57), px(90))]
    d.polygon(tail, fill=CORAL, outline=INK, width=stroke)
    d.rounded_rectangle([px(54), px(47), px(93), px(80)], radius=px(10) - off, fill=CORAL, outline=INK, width=stroke)
    # speaker dot + waves
    r0 = 3.2 * scale
    d.ellipse([px(66) - r0, px(63.5) - r0, px(66) + r0, px(63.5) + r0], fill=INK)
    for r, a in ((8.5, 50), (14, 49)):
        bbox = [px(66) - r * scale, px(63.5) - r * scale, px(66) + r * scale, px(63.5) + r * scale]
        d.arc(bbox, start=-a, end=a, fill=INK, width=stroke)
        # round caps
        for ang in (-a, a):
            cx = px(66) + r * scale * math.cos(math.radians(ang))
            cy = px(63.5) + r * scale * math.sin(math.radians(ang))
            d.ellipse([cx - stroke / 2, cy - stroke / 2, cx + stroke / 2, cy + stroke / 2], fill=INK)

    if round_mask:
        mask = Image.new("L", (W, W), 0)
        ImageDraw.Draw(mask).ellipse([0, 0, W, W], fill=255)
        img.putalpha(mask)

    return img.resize((S, S), Image.LANCZOS)


def main():
    sizes = {"mdpi": 48, "hdpi": 72, "xhdpi": 96, "xxhdpi": 144, "xxxhdpi": 192}
    for dpi, s in sizes.items():
        folder = os.path.join(RES, f"mipmap-{dpi}")
        os.makedirs(folder, exist_ok=True)
        draw_icon(s, inset=0.1).save(os.path.join(folder, "ic_launcher.png"))
        draw_icon(s, inset=0.1, round_mask=True).save(os.path.join(folder, "ic_launcher_round.png"))
        for old in ("ic_launcher_adaptive_back.png", "ic_launcher_adaptive_fore.png"):
            p = os.path.join(folder, old)
            if os.path.exists(p):
                os.remove(p)
    draw_icon(512, inset=0.06).save(os.path.join(HERE, "icon-512.png"))
    draw_icon(192, inset=0.06).save(os.path.join(HERE, "icon-192.png"))
    print("icons written")


if __name__ == "__main__":
    main()

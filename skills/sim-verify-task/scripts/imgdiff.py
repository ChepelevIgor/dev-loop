#!/usr/bin/env python3
"""Compare before and after screenshots.

  imgdiff.py BEFORE_DIR AFTER_DIR DIFF_DIR --json out.json
  imgdiff.py --same a.png b.png  # exit 0 same, 1 different, 2 error

Same requires hamming <= 4, SSIM >= 0.98 and zero changed pixels above
the native-resolution color threshold. Different dimensions are an error.
SSIM uses a seven-pixel box window on a reduced grayscale copy; pHash is a
63-bit DCT hash. Bounding boxes use connected horizontal mask runs. The
heatmap highlights native-resolution color changes over the after image.
Dependencies: Pillow and NumPy.
"""
import sys, json, argparse
from pathlib import Path
import numpy as np
from PIL import Image
SAME_H, SAME_S = 4, 0.98

def load_gray(p, max_side=512):
    im = Image.open(p).convert("L")
    s = max_side / max(im.size)
    if s < 1:
        im = im.resize((max(1, int(im.width * s)), max(1, int(im.height * s))), Image.BILINEAR)
    return np.asarray(im, dtype=np.float64)

# pHash: 32x32 DCT-II, top-left 8x8 without DC, median threshold
def dct2(a):
    n = a.shape[0]
    k = np.arange(n)
    c = np.cos(np.pi * (2 * k[None, :] + 1) * k[:, None] / (2 * n))
    return c @ a @ c.T

def phash(p):
    im = Image.open(p).convert("L").resize((32, 32), Image.LANCZOS)
    d = dct2(np.asarray(im, dtype=np.float64))[:8, :8].flatten()[1:]
    return int("".join("1" if v > np.median(d) else "0" for v in d), 2)

def hamming(a, b): return bin(a ^ b).count("1")

# SSIM with a uniform box window
def box(a, w):
    c = np.cumsum(np.cumsum(np.pad(a, ((1, 0), (1, 0))), axis=0), axis=1)
    return (c[w:, w:] - c[:-w, w:] - c[w:, :-w] + c[:-w, :-w]) / (w * w)

def ssim(a, b, w=7, L=255.0):
    if min(a.shape) < w: return 1.0 if np.allclose(a, b) else 0.0
    C1, C2 = (0.01 * L) ** 2, (0.03 * L) ** 2
    mu_a, mu_b = box(a, w), box(b, w)
    va, vb, cov = box(a * a, w) - mu_a**2, box(b * b, w) - mu_b**2, box(a * b, w) - mu_a * mu_b
    s = ((2 * mu_a * mu_b + C1) * (2 * cov + C2)) / ((mu_a**2 + mu_b**2 + C1) * (va + vb + C2))
    return float(np.clip(s.mean(), 0, 1))

# Connected components over the native-resolution mask
def bboxes(mask, min_area=1):
    # Connected components over horizontal runs: full-screen changes need one
    # run per row instead of a Python queue entry per pixel.
    parents, bounds, areas = [], [], []
    previous = []
    def find(i):
        while parents[i] != i:
            parents[i] = parents[parents[i]]
            i = parents[i]
        return i
    def join(a, b):
        a, b = find(a), find(b)
        if a != b:
            parents[b] = a
            x1, y1, x2, y2 = bounds[a]
            u1, v1, u2, v2 = bounds[b]
            bounds[a] = [min(x1,u1), min(y1,v1), max(x2,u2), max(y2,v2)]
            areas[a] += areas[b]
        return a
    for y, row in enumerate(mask):
        edges = np.diff(np.pad(row.astype(np.int8), (1, 1)))
        starts, ends = np.flatnonzero(edges == 1), np.flatnonzero(edges == -1) - 1
        current, cursor = [], 0
        for start, end in zip(starts.tolist(), ends.tolist()):
            label = len(parents)
            parents.append(label); bounds.append([start, y, end, y]); areas.append(end-start+1)
            while cursor < len(previous) and previous[cursor][1] < start:
                cursor += 1
            index = cursor
            while index < len(previous) and previous[index][0] <= end:
                label = join(label, previous[index][2])
                index += 1
            current.append((start, end, label))
        previous = current
    return [bounds[i] for i in range(len(parents)) if parents[i] == i and areas[i] >= min_area]

def heatmap(before, after, out):
    a = Image.open(after).convert("RGB")
    b = Image.open(before).convert("RGB")
    delta = np.max(np.abs(np.asarray(a, dtype=float) - np.asarray(b, dtype=float)), axis=2)
    d = Image.fromarray(np.where(delta > 24, 255, 0).astype(np.uint8))
    red = Image.new("RGB", a.size, (255, 40, 40))
    Image.composite(red, a, d.point(lambda v: 160 if v else 0)).save(out)

def compare(bp, ap, dp=None):
    with Image.open(bp) as im: sb = im.size
    with Image.open(ap) as im: sa = im.size
    if sb != sa: return {"error": "size mismatch", "before": list(sb), "after": list(sa)}
    a, b = load_gray(bp), load_gray(ap)
    # Measure color at native resolution: resizing hides thin strokes and small controls.
    with Image.open(bp) as im: rgb_before = np.asarray(im.convert("RGB"), dtype=np.int16)
    with Image.open(ap) as im: rgb_after = np.asarray(im.convert("RGB"), dtype=np.int16)
    mask = np.max(np.abs(rgb_before - rgb_after), axis=2) > 24
    changed_pixels = int(np.count_nonzero(mask))
    exact_ssim = ssim(a, b)
    r = {"ssim": round(exact_ssim, 4), "hamming": hamming(phash(bp), phash(ap)),
         "changed_pixels": changed_pixels, "changed_frac": changed_pixels / mask.size,
         "bboxes": bboxes(mask), "comparison_size": list(sa)}
    # Pixel evidence is independent from the rounded display metrics.
    r["same"] = r["hamming"] <= SAME_H and exact_ssim >= SAME_S and changed_pixels == 0
    if dp: heatmap(bp, ap, dp); r["diff"] = str(dp)
    return r

if __name__ == "__main__":
    ap = argparse.ArgumentParser()
    ap.add_argument("paths", nargs="*"); ap.add_argument("--json"); ap.add_argument("--same", action="store_true")
    ns = ap.parse_args()
    if ns.same:
        if len(ns.paths) != 2: print("--same needs two paths", file=sys.stderr); sys.exit(2)
        try: r = compare(ns.paths[0], ns.paths[1])
        except Exception as e: print(f"error: {e}", file=sys.stderr); sys.exit(2)
        sys.exit(2 if "error" in r else (0 if r["same"] else 1))
    if len(ns.paths) != 3: ap.error("expected BEFORE_DIR AFTER_DIR DIFF_DIR")
    before, after, diff = map(Path, ns.paths)
    if not before.is_dir() or not after.is_dir(): ap.error("input directories must exist")
    diff.mkdir(parents=True, exist_ok=True)
    res = {}
    names = {p.name for p in before.glob("*.png")} | {p.name for p in after.glob("*.png")}
    if not names: ap.error("no screenshot pairs")
    for name in sorted(names):
        bp, apth = before / name, after / name
        if not bp.exists(): res[bp.stem] = {"error": "no before image"}; continue
        if not apth.exists(): res[bp.stem] = {"error": "no after image"}; continue
        try: res[bp.stem] = compare(bp, apth, diff / bp.name)
        except (ValueError, OSError) as exc: res[bp.stem] = {"error": str(exc)}
    s = json.dumps(res, ensure_ascii=False, indent=2)
    if ns.json: Path(ns.json).write_text(s)
    print(s)
    sys.exit(2 if any("error" in result for result in res.values()) else 0)

#!/usr/bin/env node
// Before / after screenshots: what changed on the screen, where, and a picture of it. No dependencies (PNG via zlib).
//   node workbench/scripts/img-diff.mjs before/ after/ diff/ [--json diff.json]   pairs by file name (*.png)
//   node workbench/scripts/img-diff.mjs --same a.png b.png                          exit 0 same · 1 different · 2 error
//
// Pixels: native resolution, a pixel counts as changed when any of R/G/B differs by more than 24 — so a red→green
// swap of equal brightness is caught (grayscale would miss it). Boxes: connected regions of changed pixels.
// Diff picture: the «after» faded, changed pixels in red. SSIM (7-px window on a ≤512-px gray copy) and dHash
// hamming are hints about structure only; they don't say whether the screen works.
// Errors, never "same": no pairs, a missing half, not a PNG (JPEG — "PNG needed"), 16-bit / interlaced PNG, sizes differ.
import fs from 'node:fs';
import path from 'node:path';
import zlib from 'node:zlib';

const SIG = Buffer.from([137, 80, 78, 71, 13, 10, 26, 10]);
const THRESHOLD = 24;
const SAME_HAMMING = 4;
const SAME_SSIM = 0.98;

const CRC = new Int32Array(256).map((_, n) => {
  let c = n;
  for (let k = 0; k < 8; k++) c = c & 1 ? 0xedb88320 ^ (c >>> 1) : c >>> 1;
  return c;
});
function crc32(buf) {
  let c = -1;
  for (const b of buf) c = CRC[(c ^ b) & 0xff] ^ (c >>> 8);
  return (c ^ -1) >>> 0;
}

/** PNG bytes → { width, height, data: RGBA Uint8Array }. 8-bit gray / RGB / palette / gray+alpha / RGBA. */
export function decodePng(buf, name = 'picture') {
  if (buf[0] === 0xff && buf[1] === 0xd8) throw new Error(`${name}: this is a JPEG — PNG needed`);
  if (buf.length < 8 || !buf.subarray(0, 8).equals(SIG)) throw new Error(`${name}: not a PNG — PNG needed`);
  let pos = 8;
  let ihdr = null;
  let palette = null;
  let trns = null;
  const idat = [];
  while (pos + 8 <= buf.length) {
    const len = buf.readUInt32BE(pos);
    const type = buf.toString('latin1', pos + 4, pos + 8);
    const body = buf.subarray(pos + 8, pos + 8 + len);
    if (body.length !== len) throw new Error(`${name}: PNG is truncated`);
    if (type === 'IHDR') ihdr = { width: body.readUInt32BE(0), height: body.readUInt32BE(4), depth: body[8], color: body[9], interlace: body[12] };
    else if (type === 'PLTE') palette = body;
    else if (type === 'tRNS') trns = body;
    else if (type === 'IDAT') idat.push(body);
    else if (type === 'IEND') break;
    pos += 12 + len;
  }
  if (!ihdr || !idat.length) throw new Error(`${name}: PNG has no data`);
  const { width, height, depth, color, interlace } = ihdr;
  if (depth !== 8) throw new Error(`${name}: ${depth}-bit PNG is not supported — 8-bit needed`);
  if (interlace) throw new Error(`${name}: interlaced PNG is not supported`);
  const channels = { 0: 1, 2: 3, 3: 1, 4: 2, 6: 4 }[color];
  if (!channels) throw new Error(`${name}: unknown PNG color type (${color})`);
  if (color === 3 && !palette) throw new Error(`${name}: palette PNG without PLTE`);
  let raw;
  try {
    raw = zlib.inflateSync(Buffer.concat(idat));
  } catch {
    throw new Error(`${name}: corrupt PNG data`);
  }
  const stride = width * channels;
  if (raw.length < (stride + 1) * height) throw new Error(`${name}: PNG is truncated`);
  const px = Buffer.alloc(stride * height);
  for (let y = 0; y < height; y++) {
    const f = raw[y * (stride + 1)];
    const src = y * (stride + 1) + 1;
    const out = y * stride;
    for (let x = 0; x < stride; x++) {
      const a = x >= channels ? px[out + x - channels] : 0;
      const b = y ? px[out - stride + x] : 0;
      const c = y && x >= channels ? px[out - stride + x - channels] : 0;
      let v = raw[src + x];
      if (f === 1) v += a;
      else if (f === 2) v += b;
      else if (f === 3) v += (a + b) >> 1;
      else if (f === 4) {
        const p = a + b - c;
        const pa = Math.abs(p - a);
        const pb = Math.abs(p - b);
        const pc = Math.abs(p - c);
        v += pa <= pb && pa <= pc ? a : pb <= pc ? b : c;
      } else if (f !== 0) throw new Error(`${name}: unknown PNG filter (${f})`);
      px[out + x] = v & 0xff;
    }
  }
  const data = new Uint8Array(width * height * 4);
  for (let i = 0, j = 0; i < width * height; i++, j += channels) {
    const o = i * 4;
    if (color === 6) data.set(px.subarray(j, j + 4), o);
    else if (color === 2) (data[o] = px[j]), (data[o + 1] = px[j + 1]), (data[o + 2] = px[j + 2]), (data[o + 3] = 255);
    else if (color === 0) (data[o] = data[o + 1] = data[o + 2] = px[j]), (data[o + 3] = 255);
    else if (color === 4) (data[o] = data[o + 1] = data[o + 2] = px[j]), (data[o + 3] = px[j + 1]);
    else {
      const k = px[j];
      data[o] = palette[k * 3];
      data[o + 1] = palette[k * 3 + 1];
      data[o + 2] = palette[k * 3 + 2];
      data[o + 3] = trns && k < trns.length ? trns[k] : 255;
    }
  }
  return { width, height, data };
}

/** RGBA → PNG bytes (8-bit RGBA, filter 0). */
export function encodePng({ width, height, data }) {
  const stride = width * 4;
  const raw = Buffer.alloc((stride + 1) * height);
  for (let y = 0; y < height; y++) Buffer.from(data.buffer, data.byteOffset + y * stride, stride).copy(raw, y * (stride + 1) + 1);
  const chunk = (type, body) => {
    const len = Buffer.alloc(4);
    len.writeUInt32BE(body.length);
    const tb = Buffer.concat([Buffer.from(type, 'latin1'), body]);
    const crc = Buffer.alloc(4);
    crc.writeUInt32BE(crc32(tb));
    return Buffer.concat([len, tb, crc]);
  };
  const ihdr = Buffer.alloc(13);
  ihdr.writeUInt32BE(width, 0);
  ihdr.writeUInt32BE(height, 4);
  ihdr[8] = 8;
  ihdr[9] = 6;
  return Buffer.concat([SIG, chunk('IHDR', ihdr), chunk('IDAT', zlib.deflateSync(raw)), chunk('IEND', Buffer.alloc(0))]);
}

const readPng = (p) => {
  if (!fs.existsSync(p)) throw new Error(`${p}: no such file`);
  return decodePng(fs.readFileSync(p), path.basename(p));
};

/** Gray copy, area-averaged so the longer side is ≤ max. */
function gray(img, max = 512, w0, h0) {
  const s = Math.min(1, max / Math.max(img.width, img.height));
  const w = w0 ?? Math.max(1, Math.round(img.width * s));
  const h = h0 ?? Math.max(1, Math.round(img.height * s));
  const out = new Float64Array(w * h);
  const cnt = new Float64Array(w * h);
  for (let y = 0; y < img.height; y++) {
    const ty = Math.min(h - 1, Math.floor((y * h) / img.height));
    for (let x = 0; x < img.width; x++) {
      const tx = Math.min(w - 1, Math.floor((x * w) / img.width));
      const o = (y * img.width + x) * 4;
      out[ty * w + tx] += 0.299 * img.data[o] + 0.587 * img.data[o + 1] + 0.114 * img.data[o + 2];
      cnt[ty * w + tx]++;
    }
  }
  for (let i = 0; i < out.length; i++) out[i] /= cnt[i] || 1;
  return { w, h, v: out };
}

/** Mean SSIM with a uniform w×w window (integral images). */
export function ssim(a, b, win = 7) {
  const { w, h } = a;
  if (Math.min(w, h) < win) return a.v.every((x, i) => Math.abs(x - b.v[i]) < 1e-9) ? 1 : 0;
  const C1 = (0.01 * 255) ** 2;
  const C2 = (0.03 * 255) ** 2;
  const integral = (f) => {
    const I = new Float64Array((w + 1) * (h + 1));
    for (let y = 0; y < h; y++) {
      let row = 0;
      for (let x = 0; x < w; x++) {
        row += f(y * w + x);
        I[(y + 1) * (w + 1) + x + 1] = I[y * (w + 1) + x + 1] + row;
      }
    }
    return I;
  };
  const Ia = integral((i) => a.v[i]);
  const Ib = integral((i) => b.v[i]);
  const Iaa = integral((i) => a.v[i] * a.v[i]);
  const Ibb = integral((i) => b.v[i] * b.v[i]);
  const Iab = integral((i) => a.v[i] * b.v[i]);
  const n = win * win;
  const sum = (I, x, y) => (I[(y + win) * (w + 1) + x + win] - I[y * (w + 1) + x + win] - I[(y + win) * (w + 1) + x] + I[y * (w + 1) + x]) / n;
  let total = 0;
  let count = 0;
  for (let y = 0; y + win <= h; y++)
    for (let x = 0; x + win <= w; x++) {
      const ma = sum(Ia, x, y);
      const mb = sum(Ib, x, y);
      const va = sum(Iaa, x, y) - ma * ma;
      const vb = sum(Ibb, x, y) - mb * mb;
      const cov = sum(Iab, x, y) - ma * mb;
      total += ((2 * ma * mb + C1) * (2 * cov + C2)) / ((ma * ma + mb * mb + C1) * (va + vb + C2));
      count++;
    }
  return Math.min(1, Math.max(0, total / count));
}

/** 64-bit difference hash (9×8 gray, left < right) as a bit array. */
function dhash(img) {
  const g = gray(img, 9, 9, 8);
  const bits = [];
  for (let y = 0; y < 8; y++) for (let x = 0; x < 8; x++) bits.push(g.v[y * 9 + x] < g.v[y * 9 + x + 1] ? 1 : 0);
  return bits;
}

/** Bounding boxes [x1, y1, x2, y2] of connected changed regions (horizontal runs + union-find). */
export function boxes(mask, width, height) {
  const parent = [];
  const bound = [];
  const find = (i) => {
    while (parent[i] !== i) i = parent[i] = parent[parent[i]];
    return i;
  };
  const join = (a, b) => {
    a = find(a);
    b = find(b);
    if (a === b) return a;
    parent[b] = a;
    const [x1, y1, x2, y2] = bound[a];
    const [u1, v1, u2, v2] = bound[b];
    bound[a] = [Math.min(x1, u1), Math.min(y1, v1), Math.max(x2, u2), Math.max(y2, v2)];
    return a;
  };
  let prev = [];
  for (let y = 0; y < height; y++) {
    const cur = [];
    let cursor = 0;
    for (let x = 0; x < width; x++) {
      if (!mask[y * width + x]) continue;
      const start = x;
      while (x + 1 < width && mask[y * width + x + 1]) x++;
      let label = parent.length;
      parent.push(label);
      bound.push([start, y, x, y]);
      while (cursor < prev.length && prev[cursor][1] < start) cursor++;
      for (let i = cursor; i < prev.length && prev[i][0] <= x; i++) label = join(label, prev[i][2]);
      cur.push([start, x, label]);
    }
    prev = cur;
  }
  return parent.map((_, i) => i).filter((i) => find(i) === i).map((i) => bound[i]);
}

/** Compare two PNG files; writes the diff picture when diffPath is given. Throws on size mismatch / bad files. */
export function compare(beforePath, afterPath, diffPath) {
  const b = readPng(beforePath);
  const a = readPng(afterPath);
  if (a.width !== b.width || a.height !== b.height) throw new Error(`sizes differ: before ${b.width}×${b.height}, after ${a.width}×${a.height}`);
  const n = a.width * a.height;
  const mask = new Uint8Array(n);
  let changed = 0;
  for (let i = 0; i < n; i++) {
    const o = i * 4;
    if (Math.max(Math.abs(a.data[o] - b.data[o]), Math.abs(a.data[o + 1] - b.data[o + 1]), Math.abs(a.data[o + 2] - b.data[o + 2])) > THRESHOLD) {
      mask[i] = 1;
      changed++;
    }
  }
  const s = ssim(gray(b), gray(a));
  const hb = dhash(b);
  const ha = dhash(a);
  const hamming = hb.reduce((k, bit, i) => k + (bit !== ha[i] ? 1 : 0), 0);
  const r = {
    size: [a.width, a.height],
    changed_pixels: changed,
    changed_frac: changed / n,
    boxes: boxes(mask, a.width, a.height),
    ssim: Math.round(s * 10000) / 10000,
    hamming,
    same: changed === 0 && hamming <= SAME_HAMMING && s >= SAME_SSIM,
  };
  if (diffPath) {
    const out = new Uint8Array(n * 4);
    for (let i = 0; i < n; i++) {
      const o = i * 4;
      if (mask[i]) {
        out[o] = Math.round(255 * 0.65 + a.data[o] * 0.35);
        out[o + 1] = Math.round(40 * 0.65 + a.data[o + 1] * 0.35);
        out[o + 2] = Math.round(40 * 0.65 + a.data[o + 2] * 0.35);
      } else for (let c = 0; c < 3; c++) out[o + c] = Math.round(a.data[o + c] * 0.4 + 255 * 0.6);
      out[o + 3] = 255;
    }
    fs.mkdirSync(path.dirname(diffPath), { recursive: true });
    fs.writeFileSync(diffPath, encodePng({ width: a.width, height: a.height, data: out }));
    r.diff = diffPath;
  }
  return r;
}

/** Pair *.png by name across two folders. → { name: result | { error } }. Throws when there is nothing to pair. */
export function compareDirs(beforeDir, afterDir, diffDir) {
  for (const d of [beforeDir, afterDir]) if (!fs.existsSync(d) || !fs.statSync(d).isDirectory()) throw new Error(`${d}: no such folder`);
  const list = (d) => fs.readdirSync(d).filter((f) => f.toLowerCase().endsWith('.png'));
  const names = [...new Set([...list(beforeDir), ...list(afterDir)])].sort();
  if (!names.length) {
    const jpg = [beforeDir, afterDir].some((d) => fs.readdirSync(d).some((f) => /\.jpe?g$/i.test(f)));
    throw new Error(jpg ? 'only JPEG in the folders — PNG needed' : 'no screenshot pairs');
  }
  const res = {};
  for (const name of names) {
    const key = name.replace(/\.png$/i, '');
    const bp = path.join(beforeDir, name);
    const ap = path.join(afterDir, name);
    if (!fs.existsSync(bp)) res[key] = { error: 'no "before" shot' };
    else if (!fs.existsSync(ap)) res[key] = { error: 'no "after" shot' };
    else {
      try {
        res[key] = compare(bp, ap, diffDir ? path.join(diffDir, name) : undefined);
      } catch (e) {
        res[key] = { error: String(e.message ?? e) };
      }
    }
  }
  return res;
}

if (import.meta.url === `file://${process.argv[1]}` || process.argv[1]?.endsWith('img-diff.mjs')) {
  const args = process.argv.slice(2);
  try {
    if (args[0] === '--same') {
      if (args.length !== 3) throw new Error('--same: two files needed');
      const r = compare(args[1], args[2]);
      console.log(JSON.stringify(r, null, 2));
      process.exit(r.same ? 0 : 1);
    }
    const jsonAt = args.indexOf('--json');
    const json = jsonAt >= 0 ? args[jsonAt + 1] : null;
    const dirs = args.filter((_, i) => i !== jsonAt && i !== jsonAt + 1);
    if (dirs.length !== 3) throw new Error('usage: img-diff.mjs before/ after/ diff/ [--json out.json]');
    const res = compareDirs(dirs[0], dirs[1], dirs[2]);
    const text = JSON.stringify(res, null, 2);
    if (json) fs.writeFileSync(json, text);
    console.log(text);
    process.exit(Object.values(res).some((r) => r.error) ? 2 : 0);
  } catch (e) {
    console.error(`img-diff: ${e.message ?? e}`);
    process.exit(2);
  }
}

// The token filter: a design (HTML) against the design repo's own theme. The page is rendered in Chrome and every
// visible element's computed colors, font, spacing and radius are compared with the theme's values.
//   errors   — a color off the palette, a font family the app doesn't have, text below the size floor
//   warnings — spacing / radius / font size off the scale (often a deliberate one-off, worth a look)
// Theme: workbench.config.json → handoff.theme (a folder or files), else src/shared/theme, src/theme, theme.
// Values are read from the source text (hex / rgb(a) literals, `fontSize: N`, the Spacing / BorderRadius objects) —
// a heuristic over the files, named in the report so it can be checked.
import fs from 'node:fs';
import path from 'node:path';
import { pathToFileURL } from 'node:url';
import { withPage } from './cdp.mjs';

const COLOR_TOLERANCE = 6; // RGB distance: anti-aliasing / rounding, not a different color
const SCALE_TOLERANCE = 0.5; // px

export function themeOf(root, cfg = {}) {
  const want = cfg.handoff?.theme ?? ['src/shared/theme', 'src/theme', 'theme'].find((d) => fs.existsSync(path.join(root, d)));
  if (!want) return null;
  const list = (Array.isArray(want) ? want : [want]).flatMap((p) => {
    const abs = path.join(root, p);
    if (!fs.existsSync(abs)) return [];
    return fs.statSync(abs).isDirectory() ? fs.readdirSync(abs).filter((f) => /\.(ts|js|json)$/.test(f)).map((f) => path.join(abs, f)) : [abs];
  });
  if (!list.length) return null;
  const colors = new Map();
  const sizes = new Set();
  const spacing = new Set([0]);
  const radius = new Set([0]);
  const families = new Set();
  const block = (text, name) => {
    const m = new RegExp(`export const ${name}\\s*=\\s*\\{([\\s\\S]*?)\\n\\}`).exec(text);
    return m ? m[1] : '';
  };
  for (const f of list) {
    const text = fs.readFileSync(f, 'utf8');
    for (const m of text.matchAll(/(\w+)\s*:\s*['"](#[0-9a-fA-F]{3,8}|rgba?\([^)]+\))['"]/g)) {
      const rgb = parseColor(m[2]);
      if (rgb) colors.set(`${rgb.join(',')}`, { name: m[1], value: m[2], rgb });
    }
    for (const m of text.matchAll(/fontSize\s*:\s*(\d+(?:\.\d+)?)/g)) sizes.add(Number(m[1]));
    for (const m of block(text, 'Spacing').matchAll(/:\s*(\d+(?:\.\d+)?)/g)) spacing.add(Number(m[1]));
    for (const m of block(text, 'BorderRadius').matchAll(/:\s*(\d+(?:\.\d+)?)/g)) radius.add(Number(m[1]));
    for (const m of block(text, 'FontFamily').matchAll(/['"]([A-Za-z][\w ]*?)_\d{3}/g)) families.add(m[1].toLowerCase());
  }
  return { files: list.map((f) => path.relative(root, f)), colors: [...colors.values()], sizes: [...sizes].sort((a, b) => a - b), spacing: [...spacing].sort((a, b) => a - b), radius: [...radius].sort((a, b) => a - b), families: [...families], floor: Number(cfg.handoff?.minFontSize ?? 13) };
}

export function parseColor(s) {
  s = String(s).trim().toLowerCase();
  let m = /^#([0-9a-f]{3,8})$/.exec(s);
  if (m) {
    let h = m[1];
    if (h.length <= 4) h = [...h].map((c) => c + c).join('');
    return [0, 2, 4].map((i) => parseInt(h.slice(i, i + 2), 16));
  }
  m = /^rgba?\(([^)]+)\)$/.exec(s);
  if (m) {
    const p = m[1].split(/[\s,/]+/).filter(Boolean).map(Number);
    if (p.length >= 4 && p[3] === 0) return null; // transparent
    return p.slice(0, 3);
  }
  return null;
}
const dist = (a, b) => Math.hypot(a[0] - b[0], a[1] - b[1], a[2] - b[2]);
const onScale = (v, scale) => scale.some((x) => Math.abs(x - v) <= SCALE_TOLERANCE);

/** What every visible element renders with (collected in the page). */
const COLLECT = `(() => {
  const out = [];
  for (const el of document.body.querySelectorAll('*')) {
    const r = el.getBoundingClientRect();
    if (r.width < 1 || r.height < 1) continue;
    const cs = getComputedStyle(el);
    if (cs.visibility === 'hidden' || cs.display === 'none' || Number(cs.opacity) === 0) continue;
    const own = [...el.childNodes].some((n) => n.nodeType === 3 && n.textContent.trim());
    const label = el.tagName.toLowerCase() + (el.className && typeof el.className === 'string' ? '.' + el.className.trim().split(/\\s+/)[0] : '') + (own ? ' «' + el.textContent.trim().slice(0, 24) + '»' : '');
    out.push({ label, text: own, color: cs.color, bg: cs.backgroundColor, border: cs.borderTopWidth !== '0px' ? cs.borderTopColor : null,
      size: parseFloat(cs.fontSize), family: cs.fontFamily, radius: parseFloat(cs.borderTopLeftRadius) || 0,
      space: ['paddingTop','paddingRight','paddingBottom','paddingLeft','marginTop','marginBottom','rowGap','columnGap'].map((k) => parseFloat(cs[k]) || 0) });
  }
  return out;
})()`;

/** Audit one HTML file → { score, errors, warnings, theme } (or { unknown } when there is no theme). */
export async function audit(file, theme, { width = 430, height = 932 } = {}) {
  if (!theme) return { unknown: 'no design-system theme found in the repo (workbench.config.json → handoff.theme)' };
  const els = await withPage(pathToFileURL(path.resolve(file)).href, { width, height, wait: 1500 }, ({ evaluate }) => evaluate(COLLECT));
  const errors = new Map();
  const warnings = new Map();
  const add = (m, key, where) => {
    const v = m.get(key) ?? { what: key, count: 0, where: [] };
    v.count++;
    if (v.where.length < 3 && !v.where.includes(where)) v.where.push(where);
    m.set(key, v);
  };
  const near = (rgb) => theme.colors.reduce((best, c) => (dist(c.rgb, rgb) < dist(best.rgb, rgb) ? c : best), theme.colors[0]);
  let clean = 0;
  for (const e of els) {
    let ok = true;
    for (const [kind, val] of [['text', e.text ? e.color : null], ['background', e.bg], ['border', e.border]]) {
      const rgb = val && parseColor(val);
      if (!rgb || !theme.colors.length) continue;
      const n = near(rgb);
      if (dist(n.rgb, rgb) > COLOR_TOLERANCE) {
        add(errors, `color off the palette: ${kind} rgb(${rgb.join(', ')}) — nearest ${n.name} ${n.value}`, e.label);
        ok = false;
      }
    }
    if (e.text) {
      const fam = e.family.split(',')[0].replace(/["']/g, '').trim().toLowerCase();
      if (theme.families.length && !theme.families.some((f) => fam.includes(f))) {
        add(errors, `font not in the system: ${fam} (the app uses: ${theme.families.join(', ')})`, e.label);
        ok = false;
      }
      if (e.size < theme.floor) {
        add(errors, `text smaller than ${theme.floor} px: ${e.size} px`, e.label);
        ok = false;
      } else if (theme.sizes.length && !onScale(e.size, theme.sizes)) {
        add(warnings, `font size off the scale: ${e.size} px`, e.label);
        ok = false;
      }
    }
    for (const v of e.space.filter((x) => x > 0)) {
      if (!onScale(v, theme.spacing)) {
        add(warnings, `spacing off the scale: ${v} px`, e.label);
        ok = false;
      }
    }
    if (e.radius > 0 && e.radius < 500 && !onScale(e.radius, theme.radius)) {
      add(warnings, `radius off the scale: ${e.radius} px`, e.label);
      ok = false;
    }
    if (ok) clean++;
  }
  const list = (m) => [...m.values()].sort((a, b) => b.count - a.count);
  return { score: els.length ? Math.round((clean / els.length) * 100) : 100, elements: els.length, errors: list(errors), warnings: list(warnings), theme: { files: theme.files, colors: theme.colors.length, floor: theme.floor } };
}

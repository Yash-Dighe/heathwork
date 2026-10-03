#!/usr/bin/env node
/* make-wordmark.mjs — regenerate the brand wordmark from brand.json (called by rebrand.mjs).
   Outputs (frontend/assets/brand/):
     wordmark.svg — single-colour paths, used as a CSS MASK so it re-tints with the theme
     logo.svg     — the same mark in the theme's honey/cream, for <img> uses (splash)
   Text is converted to outlines (Pixelify Sans Bold, SIL OFL) because an SVG used as a mask or
   <img> cannot load web fonts. The icon is a pixel hearth: a little cottage with a fire inside. */
import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { createRequire } from 'node:module';

const require = createRequire(import.meta.url);
const ROOT = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');
const brand = JSON.parse(fs.readFileSync(path.join(ROOT, 'brand.json'), 'utf8'));
let opentype;
try { opentype = require('opentype.js'); } catch (_) {
  console.warn('make-wordmark: opentype.js not installed (npm i -D opentype.js) — wordmark not regenerated');
  process.exit(0);
}
const font = opentype.loadSync(path.join(ROOT, 'scripts', 'assets-pixelify-700.woff'));

// 11 x 11 pixel icon: roof, walls, door, flame (F = flame colour, everything else = mark colour)
const ICON = [
  '.....#.....',
  '....###....',
  '...#####...',
  '..#######..',
  '.#########.',
  '..#.....#..',
  '..#..F..#..',
  '..#.FFF.#..',
  '..#.FyF.#..',
  '..#.FFF.#..',
  '..#######..',
];
const PX = 8, SIZE = 96, GAP = 22;
const text = brand.name;
const tpath = font.getPath(text, 0, 0, SIZE);
const bb = tpath.getBoundingBox();
const iconW = ICON[0].length * PX, iconH = ICON.length * PX;
const textH = bb.y2 - bb.y1;
const H = Math.max(iconH, textH);
const ty = (H - textH) / 2 - bb.y1, tx = iconW + GAP - bb.x1;
const shifted = font.getPath(text, tx, ty, SIZE).toPathData(2);
const W = Math.ceil(iconW + GAP + (bb.x2 - bb.x1));
const iy = (H - iconH) / 2;

function rects(match) {
  let out = '';
  ICON.forEach((row, y) => [...row].forEach((ch, x) => {
    if (match(ch)) out += `M${x * PX} ${(iy + y * PX).toFixed(1)}h${PX}v${PX}h-${PX}z`;
  }));
  return out;
}
const mark = rects(c => c === '#');
const flame = rects(c => c === 'F'), core = rects(c => c === 'y');

const mask = `<svg xmlns="http://www.w3.org/2000/svg" viewBox="0 0 ${W} ${Math.ceil(H)}"><title>${text}</title>` +
  `<path fill="currentColor" d="${mark}${flame}${core}${shifted}"/></svg>\n`;
const logo = `<svg xmlns="http://www.w3.org/2000/svg" viewBox="0 0 ${W} ${Math.ceil(H)}"><title>${text}</title>` +
  `<path fill="#e9b872" d="${mark}"/><path fill="#f0743e" d="${flame}"/><path fill="#ffd970" d="${core}"/>` +
  `<path fill="#fbe6c2" d="${shifted}"/></svg>\n`;
const out = path.join(ROOT, 'frontend', 'assets', 'brand');
fs.mkdirSync(out, { recursive: true });
fs.writeFileSync(path.join(out, 'wordmark.svg'), mask);
fs.writeFileSync(path.join(out, 'logo.svg'), logo);
// keep the masked header mark's aspect-ratio in step with the new viewBox (a masked <span> has no intrinsic size)
const cssPath = path.join(ROOT, 'frontend', 'css', 'style.css');
const css = fs.readFileSync(cssPath, 'utf8');
const css2 = css.replace(/(\.logo-img\s*\{[^}]*?aspect-ratio:\s*)[\d.]+\s*\/\s*[\d.]+/, `$1${W} / ${Math.ceil(H)}`);
if (css2 !== css) fs.writeFileSync(cssPath, css2);
console.log(`make-wordmark: ${text} -> frontend/assets/brand/{wordmark,logo}.svg (${W}x${Math.ceil(H)})`);

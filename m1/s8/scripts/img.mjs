import { PNG } from "pngjs";
import { readFileSync, writeFileSync } from "node:fs";
export const load = (p) => PNG.sync.read(readFileSync(p));
export const save = (png, p) => writeFileSync(p, PNG.sync.write(png));
export function crop(src, x, y, w, h, scale = 1) {
  const out = new PNG({ width: w * scale, height: h * scale });
  for (let j = 0; j < h * scale; j++)
    for (let i = 0; i < w * scale; i++) {
      const s = ((y + Math.floor(j / scale)) * src.width + x + Math.floor(i / scale)) * 4;
      const d = (j * w * scale + i) * 4;
      for (let c = 0; c < 4; c++) out.data[d + c] = src.data[s + c];
    }
  return out;
}
export function hcat(images, gap = 8) {
  const w = images.reduce((a, im) => a + im.width, 0) + gap * (images.length - 1);
  const h = Math.max(...images.map((im) => im.height));
  const out = new PNG({ width: w, height: h });
  out.data.fill(255);
  let x0 = 0;
  for (const im of images) {
    for (let j = 0; j < im.height; j++)
      for (let i = 0; i < im.width; i++) {
        const s = (j * im.width + i) * 4, d = (j * w + x0 + i) * 4;
        for (let c = 0; c < 4; c++) out.data[d + c] = im.data[s + c];
      }
    x0 += im.width + gap;
  }
  return out;
}
export function vcat(images, gap = 8) {
  const h = images.reduce((a, im) => a + im.height, 0) + gap * (images.length - 1);
  const w = Math.max(...images.map((im) => im.width));
  const out = new PNG({ width: w, height: h });
  out.data.fill(255);
  let y0 = 0;
  for (const im of images) {
    for (let j = 0; j < im.height; j++)
      for (let i = 0; i < im.width; i++) {
        const s = (j * im.width + i) * 4, d = ((y0 + j) * w + i) * 4;
        for (let c = 0; c < 4; c++) out.data[d + c] = im.data[s + c];
      }
    y0 += im.height + gap;
  }
  return out;
}

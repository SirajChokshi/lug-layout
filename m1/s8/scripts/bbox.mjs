import { load } from "./img.mjs";
export function sceneBox(paths, bg = [217, 230, 242], pad = 16) {
  let x0 = Infinity, y0 = Infinity, x1 = -1, y1 = -1, w = 0, h = 0;
  for (const p of paths) {
    const im = load(p); w = im.width; h = im.height;
    for (let y = 0; y < im.height; y++) for (let x = 0; x < im.width; x++) {
      const o = (y * im.width + x) * 4;
      if (Math.abs(im.data[o] - bg[0]) > 3 || Math.abs(im.data[o + 1] - bg[1]) > 3 || Math.abs(im.data[o + 2] - bg[2]) > 3) {
        if (x < x0) x0 = x; if (x > x1) x1 = x; if (y < y0) y0 = y; if (y > y1) y1 = y;
      }
    }
  }
  x0 = Math.max(0, x0 - pad); y0 = Math.max(0, y0 - pad); x1 = Math.min(w - 1, x1 + pad); y1 = Math.min(h - 1, y1 + pad);
  return { x: x0, y: y0, w: x1 - x0 + 1, h: y1 - y0 + 1 };
}

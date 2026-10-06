/** A rounded-rectangle bevel's normal field, encoded for feDisplacementMap.
 * No DOM screenshot or user content is copied: the browser samples its backdrop.
 */
export function createLensMap(width: number, height: number, cornerRadius: number) {
  const w = Math.max(1, Math.round(width));
  const h = Math.max(1, Math.round(height));
  const downsample = Math.min(1, 1024 / w, 320 / h);
  const mapWidth = Math.max(1, Math.round(w * downsample));
  const mapHeight = Math.max(1, Math.round(h * downsample));
  const radius = Math.min(Math.max(1, cornerRadius), w / 2, h / 2);
  const bevel = Math.min(18, radius * .8, h / 3);
  const strength = Math.min(14, bevel * .9);
  const scale = (strength + 2) * 2;
  const pixels = new Uint8ClampedArray(mapWidth * mapHeight * 4);
  for (let y = 0; y < mapHeight; y++) {
    for (let x = 0; x < mapWidth; x++) {
      const px = (x + .5) * w / mapWidth - w / 2;
      const py = (y + .5) * h / mapHeight - h / 2;
      const qx = Math.abs(px) - (w / 2 - radius);
      const qy = Math.abs(py) - (h / 2 - radius);
      const ox = Math.max(qx, 0), oy = Math.max(qy, 0);
      const length = Math.hypot(ox, oy);
      const depth = -(length + Math.min(Math.max(qx, qy), 0) - radius);
      let dx = 0, dy = 0;
      if (depth > 0) {
        const nx = (length ? ox / length : qx > qy ? 1 : 0) * Math.sign(px);
        const ny = (length ? oy / length : qy >= qx ? 1 : 0) * Math.sign(py);
        const bend = depth < bevel ? Math.sin(Math.PI * depth / bevel) * strength : 0;
        dx = -nx * bend + px * Math.min(.012, 2 / (w / 2));
        dy = -ny * bend + py * Math.min(.012, 2 / (h / 2));
      }
      const index = (y * mapWidth + x) * 4;
      pixels[index] = 128 + dx / scale * 255;
      pixels[index + 1] = 128 + dy / scale * 255;
      pixels[index + 2] = 128;
      pixels[index + 3] = 255;
    }
  }
  return { width: w, height: h, mapWidth, mapHeight, scale, pixels };
}

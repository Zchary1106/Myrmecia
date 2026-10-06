import { describe, expect, it } from 'vitest';
import { createLensMap } from '../src/lib/liquid-lens-map';

describe('Liquid lens normal map', () => {
  it('bends opposite bevels in opposite directions, rather than merely blurring', () => {
    const map = createLensMap(240, 80, 18);
    const channel = (x: number, y: number, c: number) => map.pixels[(y * map.mapWidth + x) * 4 + c];
    expect(channel(120, 6, 1)).toBeGreaterThan(170);
    expect(channel(120, 73, 1)).toBeLessThan(86);
    expect(channel(6, 40, 0)).toBeGreaterThan(170);
    expect(channel(233, 40, 0)).toBeLessThan(86);
    expect(Math.abs(channel(120, 6, 1) + channel(120, 73, 1) - 256)).toBeLessThanOrEqual(2);
  });
  it('keeps corners outside the rounded shape neutral and opaque', () => {
    const map = createLensMap(240, 80, 18);
    expect([...map.pixels.slice(0, 4)]).toEqual([128, 128, 128, 255]);
  });
  it('keeps the optical center nearly neutral', () => {
    const map = createLensMap(240, 80, 18);
    const i = (40 * map.mapWidth + 120) * 4;
    expect(Math.abs(map.pixels[i] - 128)).toBeLessThanOrEqual(1);
    expect(Math.abs(map.pixels[i + 1] - 128)).toBeLessThanOrEqual(1);
  });
  it('caps map resolution while retaining the host size used by SVG', () => {
    const map = createLensMap(3000, 1200, 24);
    expect(map.width).toBe(3000);
    expect(map.height).toBe(1200);
    expect(map.mapWidth).toBeLessThanOrEqual(1024);
    expect(map.mapHeight).toBeLessThanOrEqual(320);
    expect(map.pixels.length).toBe(map.mapWidth * map.mapHeight * 4);
  });
  it.each([[1, 1, 30], [64, 40, 26], [800, 180, 26]])('produces bounded finite channels for %s × %s at radius %s', (w, h, r) => {
    const map = createLensMap(w, h, r);
    expect(Number.isFinite(map.scale)).toBe(true);
    expect(map.scale).toBeGreaterThan(0);
    expect([...map.pixels].every(value => value >= 0 && value <= 255)).toBe(true);
  });
});

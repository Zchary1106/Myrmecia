import { useId, useLayoutEffect, useRef, useState } from 'react';
import { createLensMap } from '../../lib/liquid-lens-map';

type LensImage = { width: number; height: number; scale: number; href: string };

/** Chromium backdrop refraction enhancement; other engines keep readable frost.
 * SVG displacement filters the captured backdrop, never the foreground text.
 */
export function LiquidLens({ radius = 26 }: { radius?: number }) {
  const svg = useRef<SVGSVGElement>(null);
  const id = `liquid-lens-${useId().replace(/[^a-zA-Z0-9_-]/g, '')}`;
  const [image, setImage] = useState<LensImage | null>(null);
  const [enabled, setEnabled] = useState(false);

  useLayoutEffect(() => {
    const host = svg.current?.parentElement;
    if (!host || typeof window.matchMedia !== 'function') return;
    const contrast = window.matchMedia('(prefers-contrast: more)');
    const transparency = window.matchMedia('(prefers-reduced-transparency: reduce)');
    const forced = window.matchMedia('(forced-colors: active)');
    const motion = window.matchMedia('(prefers-reduced-motion: reduce)');
    const supported = /(?:Chrome|Chromium)\//.test(navigator.userAgent)
      && typeof CSS !== 'undefined' && CSS.supports('backdrop-filter', `url("#${id}")`)
      && typeof ResizeObserver !== 'undefined';
    let disposed = false, resizeFrame = 0, pointerFrame = 0, previousSize = '';
    const previousProperties = new Map(['--liquid-filter', '--lens-x', '--lens-y'].map(name => [name, host.style.getPropertyValue(name)]));
    host.classList.add('liquid-lens-host');
    const measure = () => {
      if (disposed) return;
      const allowed = supported && !contrast.matches && !transparency.matches && !forced.matches;
      setEnabled(allowed);
      if (!allowed) { host.dataset.liquidLens = 'frosted'; return; }
      const w = host.offsetWidth, h = host.offsetHeight;
      const key = `${w}:${h}:${radius}`;
      if (!w || !h || key === previousSize) return;
      try {
        const map = createLensMap(w, h, radius);
        const canvas = document.createElement('canvas');
        canvas.width = map.mapWidth; canvas.height = map.mapHeight;
        const context = canvas.getContext('2d');
        if (!context) { setEnabled(false); return; }
        const bitmap = context.createImageData(map.mapWidth, map.mapHeight);
        bitmap.data.set(map.pixels);
        context.putImageData(bitmap, 0, 0);
        setImage({ width: w, height: h, scale: map.scale, href: canvas.toDataURL() });
        previousSize = key;
      } catch {
        setEnabled(false);
        host.dataset.liquidLens = 'frosted';
      }
    };
    const resize = () => {
      cancelAnimationFrame(resizeFrame);
      resizeFrame = requestAnimationFrame(measure);
    };
    const observer = typeof ResizeObserver !== 'undefined' ? new ResizeObserver(resize) : null;
    observer?.observe(host);
    measure();
    const positionLight = (clientX: number, clientY: number) => {
      cancelAnimationFrame(pointerFrame);
      pointerFrame = requestAnimationFrame(() => {
        if (disposed || motion.matches || contrast.matches || transparency.matches || forced.matches) return;
        const box = host.getBoundingClientRect();
        host.style.setProperty('--lens-x', `${Math.max(0, Math.min(box.width, clientX - box.left))}px`);
        host.style.setProperty('--lens-y', `${Math.max(0, Math.min(box.height, clientY - box.top))}px`);
      });
    };
    const pointer = (event: PointerEvent) => positionLight(event.clientX, event.clientY);
    const focus = (event: FocusEvent) => {
      if (!(event.target instanceof HTMLElement)) return;
      const box = event.target.getBoundingClientRect();
      positionLight(box.x + box.width / 2, box.y + box.height / 2);
    };
    const reset = () => {
      cancelAnimationFrame(pointerFrame);
      host.style.removeProperty('--lens-x'); host.style.removeProperty('--lens-y');
    };
    const preferencesChanged = () => { reset(); measure(); };
    [contrast, transparency, forced].forEach(query => query.addEventListener('change', preferencesChanged));
    motion.addEventListener('change', reset);
    host.addEventListener('pointermove', pointer, { passive: true });
    host.addEventListener('pointerleave', reset);
    host.addEventListener('focusin', focus);
    return () => {
      disposed = true;
      observer?.disconnect();
      cancelAnimationFrame(resizeFrame); cancelAnimationFrame(pointerFrame);
      [contrast, transparency, forced].forEach(query => query.removeEventListener('change', preferencesChanged));
      motion.removeEventListener('change', reset);
      host.removeEventListener('pointermove', pointer);
      host.removeEventListener('pointerleave', reset);
      host.removeEventListener('focusin', focus);
      host.classList.remove('liquid-lens-host');
      delete host.dataset.liquidLens;
      for (const [name, value] of previousProperties) {
        if (value) host.style.setProperty(name, value); else host.style.removeProperty(name);
      }
    };
  }, [id, radius]);

  useLayoutEffect(() => {
    const host = svg.current?.parentElement;
    if (!host) return;
    host.dataset.liquidLens = enabled && image ? 'svg' : 'frosted';
    if (enabled && image) host.style.setProperty('--liquid-filter', `url("#${id}")`);
    else host.style.removeProperty('--liquid-filter');
  }, [enabled, image, id]);

  return <svg ref={svg} className="liquid-filter-defs" width="0" height="0" aria-hidden="true" focusable="false">
    <defs>
      {image && <filter id={id} x="0" y="0" width="100%" height="100%" filterUnits="objectBoundingBox" primitiveUnits="userSpaceOnUse" colorInterpolationFilters="sRGB">
        <feImage href={image.href} x="0" y="0" width={image.width} height={image.height} preserveAspectRatio="none" result="normals" />
        <feDisplacementMap in="SourceGraphic" in2="normals" scale={image.scale} xChannelSelector="R" yChannelSelector="G" />
      </filter>}
    </defs>
  </svg>;
}

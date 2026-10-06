import { useLayoutEffect, useRef, useState } from 'react';
import { LiquidLens } from '../common/LiquidLens';

export function LiquidNavIndicator({ selection, collapsed }: { selection: string; collapsed: boolean }) {
  const track = useRef<HTMLDivElement>(null);
  const [bounds, setBounds] = useState({ x: 0, y: 0, width: 0, height: 0 });
  useLayoutEffect(() => {
    const element = track.current, nav = element?.parentElement;
    if (!element || !nav) return;
    let resizeFrame = 0, moveFrame = 0, timeout: ReturnType<typeof setTimeout> | undefined;
    const measure = () => {
      const selected = nav.querySelector<HTMLElement>('button[aria-current="page"]');
      if (!selected) { setBounds(value => ({ ...value, width: 0 })); return; }
      const box = selected.getBoundingClientRect(), parent = nav.getBoundingClientRect();
      const next = { x: box.left - parent.left + nav.scrollLeft, y: box.top - parent.top + nav.scrollTop, width: selected.offsetWidth, height: selected.offsetHeight };
      setBounds(value => value.x === next.x && value.y === next.y && value.width === next.width && value.height === next.height ? value : next);
    };
    const resize = () => { cancelAnimationFrame(resizeFrame); resizeFrame = requestAnimationFrame(measure); };
    const observer = typeof ResizeObserver !== 'undefined' ? new ResizeObserver(resize) : null;
    observer?.observe(nav);
    measure();
    // Deform the material itself, while the track translates continuously.
    if (typeof window.matchMedia === 'function' && !window.matchMedia('(prefers-reduced-motion: reduce)').matches) {
      element.removeAttribute('data-moving');
      moveFrame = requestAnimationFrame(() => { element.dataset.moving = 'true'; });
      timeout = setTimeout(() => element.removeAttribute('data-moving'), 440);
    }
    return () => { observer?.disconnect(); cancelAnimationFrame(resizeFrame); cancelAnimationFrame(moveFrame); clearTimeout(timeout); };
  }, [selection, collapsed]);

  return <div ref={track} data-liquid-nav-indicator aria-hidden="true" className="liquid-nav-track"
    style={{ left: bounds.x, width: bounds.width, height: bounds.height, transform: `translateY(${bounds.y}px)`, visibility: bounds.width ? 'visible' : 'hidden' }}>
    <div className="liquid-nav-lens"><LiquidLens radius={14} /></div>
  </div>;
}

import { useEffect, useState } from 'react';

/**
 * Viewer height that never exceeds the screen: a 600px board view on a phone would push the toolbar and the page off
 * screen and make the page impossible to scroll past (the canvas captures touch). Strings are used as given.
 */
export function fitHeight(height: number | string): string | number {
  if (typeof height !== 'number') return height;
  return `min(${height}px, calc(100svh - 7rem))`;
}

/** True on touch-first devices, for "tap" instead of "click" and larger hit areas. */
export function useCoarsePointer(): boolean {
  const query = '(pointer: coarse)';
  const [coarse, setCoarse] = useState(() => typeof window !== 'undefined' && window.matchMedia?.(query).matches === true);
  useEffect(() => {
    const mq = window.matchMedia?.(query);
    if (!mq) return;
    const on = () => setCoarse(mq.matches);
    mq.addEventListener('change', on);
    return () => mq.removeEventListener('change', on);
  }, []);
  return coarse;
}

/** Element full screen, falling back to filling the window where the Fullscreen API is missing (iPhone Safari). */
export function useFullscreen(el: () => HTMLElement | null): { expanded: boolean; toggle: () => void } {
  const [expanded, setExpanded] = useState(false);
  useEffect(() => {
    if (!expanded) return;
    const onKey = (e: KeyboardEvent) => e.key === 'Escape' && setExpanded(false);
    document.addEventListener('keydown', onKey);
    const prev = document.body.style.overflow;
    document.body.style.overflow = 'hidden';
    return () => {
      document.removeEventListener('keydown', onKey);
      document.body.style.overflow = prev;
    };
  }, [expanded]);
  const toggle = () => {
    const node = el();
    if (!node) return;
    if (document.fullscreenElement) {
      void document.exitFullscreen();
      return;
    }
    if (expanded) {
      setExpanded(false);
      return;
    }
    if (typeof node.requestFullscreen === 'function' && document.fullscreenEnabled) void node.requestFullscreen().catch(() => setExpanded(true));
    else setExpanded(true);
  };
  return { expanded, toggle };
}

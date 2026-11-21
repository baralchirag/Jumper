import { useEffect, useState } from 'react';

export type ThemePref = 'system' | 'light' | 'dark';
const KEY = 'jumper-theme';

export function getThemePref(): ThemePref {
  try {
    return (localStorage.getItem(KEY) as ThemePref) || 'system';
  } catch {
    return 'system';
  }
}

export function applyTheme(pref: ThemePref): void {
  try {
    localStorage.setItem(KEY, pref);
  } catch {
    /* storage unavailable */
  }
  const dark = pref === 'dark' || (pref === 'system' && matchMedia('(prefers-color-scheme: dark)').matches);
  document.documentElement.dataset.theme = dark ? 'dark' : 'light';
  window.dispatchEvent(new CustomEvent('jumper-theme', { detail: pref }));
}

/** The stored theme preference, kept in sync across every component that shows it. */
export function useThemePref(): [ThemePref, (p: ThemePref) => void] {
  const [pref, setPref] = useState<ThemePref>(getThemePref);
  useEffect(() => {
    const on = () => setPref(getThemePref());
    window.addEventListener('jumper-theme', on);
    return () => window.removeEventListener('jumper-theme', on);
  }, []);
  return [pref, applyTheme];
}

export function watchSystemTheme(): () => void {
  const mq = matchMedia('(prefers-color-scheme: dark)');
  const onChange = () => getThemePref() === 'system' && applyTheme('system');
  mq.addEventListener('change', onChange);
  return () => mq.removeEventListener('change', onChange);
}

const resolved = (): 'light' | 'dark' => (document.documentElement.dataset.theme === 'dark' ? 'dark' : 'light');

/** The theme actually on screen (system preference resolved), for canvases that draw their own colours. */
export function useResolvedTheme(): 'light' | 'dark' {
  const [theme, setTheme] = useState(resolved);
  useEffect(() => {
    const mo = new MutationObserver(() => setTheme(resolved()));
    mo.observe(document.documentElement, { attributes: true, attributeFilter: ['data-theme'] });
    return () => mo.disconnect();
  }, []);
  return theme;
}

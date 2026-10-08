import { useEffect, useState } from 'react';
import type { Settings } from '../../types';
import { defaultTheme, type Theme } from '../../types/v2';
import { v2 } from '../../services/v2';
export const presets = [
  {
    id: 'ocean',
    name: '深海蓝',
    dark: '#0b1220',
    panel: '#111d2e',
    accent: '#3b82f6',
    light: '#f5f7fb',
  },
  {
    id: 'white',
    name: '极简白',
    dark: '#161b24',
    panel: '#202732',
    accent: '#2563eb',
    light: '#f8fafc',
  },
  {
    id: 'graphite',
    name: '石墨黑',
    dark: '#111214',
    panel: '#1c1e22',
    accent: '#8b92a5',
    light: '#f2f3f5',
  },
  {
    id: 'forest',
    name: '森林绿',
    dark: '#0b1915',
    panel: '#12281f',
    accent: '#22c55e',
    light: '#f1f8f4',
  },
  {
    id: 'twilight',
    name: '暮光紫',
    dark: '#181326',
    panel: '#251e38',
    accent: '#a78bfa',
    light: '#f7f4fc',
  },
] as const;
export function useTheme(settings: Settings | undefined, theme: Theme = defaultTheme) {
  const [systemDark, setSystemDark] = useState(
    () => matchMedia('(prefers-color-scheme: dark)').matches,
  );
  const [image, setImage] = useState('');
  const dark =
    !settings || settings.theme === 'dark' || (settings.theme === 'system' && systemDark);
  useEffect(() => {
    const media = matchMedia('(prefers-color-scheme: dark)');
    const change = () => setSystemDark(media.matches);
    media.addEventListener('change', change);
    return () => media.removeEventListener('change', change);
  }, []);
  useEffect(() => {
    let live = true;
    setImage('');
    if (theme.background_id && theme.background_style === 'image')
      void v2
        .background(theme.background_id)
        .then((value) => {
          if (live) setImage(value);
        })
        .catch(() => {});
    return () => {
      live = false;
    };
  }, [theme.background_id, theme.background_style]);
  useEffect(() => {
    const el = document.documentElement,
      p = presets.find((x) => x.id === theme.preset) ?? presets[0];
    el.dataset.theme = dark ? 'dark' : 'light';
    el.dataset.motion = settings?.animations === false ? 'off' : 'on';
    el.dataset.density = theme.density;
    const values = {
      '--bg': dark ? p.dark : p.light,
      '--sidebar': dark ? p.dark : '#ffffff',
      '--panel': dark ? p.panel : '#ffffff',
      '--input': dark ? p.dark : p.light,
      '--panel-hover': dark
        ? `color-mix(in srgb, ${p.panel} 85%, white)`
        : `color-mix(in srgb, ${p.light} 90%, ${settings?.accent ?? p.accent})`,
      '--text': dark ? '#f8fafc' : '#0f172a',
      '--muted': dark ? '#94a3b8' : '#64748b',
      '--line': dark ? '#ffffff12' : '#0f172a16',
      '--accent': settings?.accent ?? p.accent,
      '--radius': `${theme.radius}px`,
    };
    Object.entries(values).forEach(([key, value]) => el.style.setProperty(key, value));
  }, [dark, theme.preset, theme.radius, theme.density, settings?.accent, settings?.animations]);
  return {
    dark,
    background: {
      backgroundImage: image
        ? `url("${image}")`
        : theme.background_style === 'gradient'
          ? 'radial-gradient(ellipse at 70% 0%,var(--accent),transparent 65%)'
          : 'none',
      backgroundSize:
        theme.background_fit === 'contain'
          ? 'contain'
          : theme.background_fit === 'tile'
            ? 'auto'
            : 'cover',
      backgroundRepeat: theme.background_fit === 'tile' ? 'repeat' : 'no-repeat',
      backgroundPosition: 'center',
      opacity: theme.background_opacity,
      filter: `blur(${theme.background_blur}px)`,
    },
  };
}

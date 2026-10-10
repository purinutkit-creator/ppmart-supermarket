// Font loading for Google Fonts and uploaded fonts. Canvas rendering waits for fonts to be ready,
// so the printed bitmap uses the exact same font as the preview.
import { api } from './api';

interface FontRow { id: number; family: string; source: 'google' | 'upload'; format?: string; weight: string }
let fontList: FontRow[] | null = null;
const loaded = new Map<string, Promise<void>>();

export async function listFonts(force = false): Promise<FontRow[]> {
  if (!fontList || force) fontList = await api<FontRow[]>('/api/fonts', { token: null }).catch(() => fontList ?? []);
  return fontList!;
}

export function googleFontUrl(family: string, weights = '400;500;600;700;800') {
  return `https://fonts.googleapis.com/css2?family=${encodeURIComponent(family).replace(/%20/g, '+')}:wght@${weights}&display=swap`;
}

export function loadFont(family: string): Promise<void> {
  if (!family) return Promise.resolve();
  if (loaded.has(family)) return loaded.get(family)!;
  const p = (async () => {
    const list = await listFonts();
    const uploads = list.filter((f) => f.family === family && f.source === 'upload');
    if (uploads.length) {
      for (const f of uploads) {
        const ff = new FontFace(family, `url(/api/fonts/${f.id}/file)`, { weight: /^\d+$/.test(f.weight) ? f.weight : '100 900' });
        document.fonts.add(await ff.load());
      }
    } else if (!['sans-serif', 'serif', 'monospace'].includes(family)) {
      if (!document.querySelector(`link[data-font="${family}"]`)) {
        const l = document.createElement('link');
        l.rel = 'stylesheet';
        l.href = googleFontUrl(family);
        l.dataset.font = family;
        const done = new Promise<void>((res) => { l.onload = () => res(); l.onerror = () => res(); });
        document.head.appendChild(l);
        await done;
      }
    }
    // Force-load glyph subsets used on receipts (Thai, Latin, CJK, digits)
    await Promise.all(['400', '700'].map((w) => document.fonts.load(`${w} 24px "${family}"`, 'กขคฅ ABC abc 0123 ฿ 中文')));
  })().catch((e) => console.warn('font load failed', family, e));
  loaded.set(family, p);
  return p;
}

export async function ensureFonts(families: string[]) {
  await Promise.all([...new Set(families.filter(Boolean))].map(loadFont));
  await document.fonts.ready;
}

/** Apply per-area font selection (POS, Dashboard, Display, Member site, Report) as CSS variables. */
export function applyAreaFonts(fonts: Record<string, string>) {
  for (const [area, fam] of Object.entries(fonts || {})) {
    loadFont(fam);
    document.documentElement.style.setProperty(`--font-${area}`, `"${fam}", "Sarabun", system-ui, sans-serif`);
  }
}

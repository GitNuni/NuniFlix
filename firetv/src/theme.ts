// Each service is browsed in its own colours and layout; NuniFlix's own screens use the person's theme.
// Mirrors apple/Sources/Core/Theme.swift.

export type Weight = '400' | '600' | '700' | '800' | '900';

export interface ServiceTheme {
  background: string[];
  accent: string;
  onAccent: string;
  tile: 'wide' | 'poster';
  corner: number;
  rowWeight: Weight;
  serif: boolean;
  italic: boolean;
  uppercase: boolean;
  brand: string;
}

function t(p: Partial<ServiceTheme> & {background: string[]; accent: string}): ServiceTheme {
  return {
    onAccent: '#FFFFFF',
    tile: 'wide',
    corner: 8,
    rowWeight: '600',
    serif: false,
    italic: false,
    uppercase: false,
    brand: p.brand ?? p.accent,
    ...p,
  };
}

export const NUNIFLIX = t({background: ['#0B0B0F', '#000000'], accent: '#E50914', tile: 'poster', corner: 8});

export const APP_THEMES: {id: string; name: string}[] = [
  {id: 'nuniflix', name: 'NuniFlix'},
  {id: 'repertory', name: 'Repertory'},
  {id: 'premiere', name: 'Premiere'},
  {id: 'nunitech', name: 'Nunitech'},
  {id: 'blockbuster', name: 'Blockbuster'},
  {id: 'retro', name: 'Retro'},
  {id: 'atomic', name: 'Atomic Age'},
  {id: 'horror', name: 'Horror'},
];

export function appTheme(id?: string | null): ServiceTheme {
  switch (id) {
    case 'repertory':
      return t({background: ['#181714', '#100F0D'], accent: '#FF5A2B', onAccent: '#120D0B', tile: 'poster', corner: 3, rowWeight: '400', serif: true});
    case 'premiere':
      return t({background: ['#1C1C1E', '#000000'], accent: '#FF5A2B', tile: 'poster', corner: 18, rowWeight: '700'});
    case 'nunitech':
      return t({background: ['#1D2C5C', '#0B0C10'], accent: '#0A84FF', tile: 'poster', corner: 22, brand: '#FFFFFF'});
    case 'blockbuster':
      return t({background: ['#12306E', '#0A1F4D'], accent: '#FFCC00', onAccent: '#0A1F4D', tile: 'poster', corner: 3, rowWeight: '700', uppercase: true});
    case 'retro':
      return t({background: ['#2E1C12', '#1E120B'], accent: '#E8631C', onAccent: '#1E120B', tile: 'poster', corner: 16, rowWeight: '800', serif: true, italic: true, brand: '#F2A33A'});
    case 'atomic':
      return t({background: ['#1F3439', '#142326'], accent: '#E2574C', onAccent: '#FFFAF0', tile: 'poster', corner: 18, rowWeight: '700', brand: '#F4A259'});
    case 'horror':
      return t({background: ['#1A1410', '#0B0A09'], accent: '#8E1B1F', onAccent: '#F3EAD8', tile: 'poster', corner: 3, serif: true, uppercase: true, brand: '#B8963E'});
    default:
      return NUNIFLIX;
  }
}

/** Their look, not their logos-as-ours: the real logo comes from TMDB. */
export function serviceTheme(name: string): ServiceTheme {
  const n = name.toLowerCase();
  if (n.includes('netflix')) return t({background: ['#141414', '#141414'], accent: '#E50914', corner: 4, rowWeight: '700'});
  if (n.includes('disney')) return t({background: ['#1A1D29', '#0E0F14'], accent: '#0072D2', corner: 12});
  if (n === 'max' || n.includes('hbo')) return t({background: ['#0A1240', '#000000'], accent: '#002BE7', tile: 'poster', corner: 6, rowWeight: '700'});
  if (n.includes('prime') || n.includes('amazon')) return t({background: ['#0F171E', '#0F171E'], accent: '#1A98FF', corner: 8, rowWeight: '700'});
  if (n.includes('hulu')) return t({background: ['#16181D', '#0B0C0F'], accent: '#1CE783', onAccent: '#000000', corner: 10});
  if (n.includes('apple')) return t({background: ['#1C1C1E', '#000000'], accent: '#FFFFFF', onAccent: '#000000', corner: 14});
  if (n.includes('paramount')) return t({background: ['#0B1A3A', '#000814'], accent: '#0064FF', tile: 'poster', corner: 8});
  if (n.includes('peacock')) return t({background: ['#111111', '#000000'], accent: '#F5F5F5', onAccent: '#000000', corner: 6, rowWeight: '800'});
  if (n.includes('crunchyroll')) return t({background: ['#141519', '#000000'], accent: '#F47521', tile: 'poster', corner: 4, rowWeight: '800'});
  if (n.includes('starz') || n.includes('showtime') || n.includes('mgm'))
    return t({background: ['#101010', '#000000'], accent: '#D4AF37', onAccent: '#000000', tile: 'poster', corner: 6});
  return NUNIFLIX;
}

export const upper = (theme: ServiceTheme, s: string) => (theme.uppercase ? s.toUpperCase() : s);

/** Sizes for a 1920x1080 TV screen across the room (same as the Apple TV app). */
export const M = {
  wide: {width: 400, height: 225},
  poster: {width: 220, height: 330},
  heroHeight: 640,
  gutter: 80,
  spacing: 40,
  rowTitle: 34,
  serviceTile: {width: 340, height: 170},
};

export const tileSize = (theme: ServiceTheme) => (theme.tile === 'wide' ? M.wide : M.poster);

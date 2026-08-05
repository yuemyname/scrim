/** 타임코드 등 표기 유틸. 시간과 좌표는 영상 편집의 어휘 — 고정폭으로 다룬다. */
import { t } from './i18n';

export function timecode(us: number): string {
  const totalS = us / 1e6;
  const h = Math.floor(totalS / 3600);
  const m = Math.floor((totalS % 3600) / 60);
  const s = Math.floor(totalS % 60);
  const cs = Math.floor((totalS % 1) * 100);
  const pad = (n: number): string => String(n).padStart(2, '0');
  return `${pad(h)}:${pad(m)}:${pad(s)}.${pad(cs)}`;
}

export function shortTime(us: number): string {
  const totalS = Math.floor(us / 1e6);
  const m = Math.floor(totalS / 60);
  const s = totalS % 60;
  return `${String(m).padStart(2, '0')}:${String(s).padStart(2, '0')}`;
}

export function etaText(ms: number): string {
  if (ms <= 0) return '';
  const s = Math.round(ms / 1000);
  if (s < 60) return t('etaSec', { s });
  return t('etaMin', { m: Math.floor(s / 60), s: s % 60 });
}

/**
 * 파일 저장 (내보낸 mp4, 프로젝트 JSON).
 * iPad Safari는 showSaveFilePicker 미지원 → a[download] + Blob URL 폴백.
 */
import type { Project } from '../types';

interface SaveFilePickerWindow {
  showSaveFilePicker?: (opts: {
    suggestedName?: string;
    types?: { description: string; accept: Record<string, string[]> }[];
  }) => Promise<{ createWritable(): Promise<{ write(b: Blob): Promise<void>; close(): Promise<void> }> }>;
}

export async function saveBlob(blob: Blob, suggestedName: string, mime: string, ext: string): Promise<boolean> {
  const w = window as unknown as SaveFilePickerWindow;
  if (w.showSaveFilePicker) {
    try {
      const handle = await w.showSaveFilePicker({
        suggestedName,
        types: [{ description: suggestedName, accept: { [mime]: [ext] } }],
      });
      const writable = await handle.createWritable();
      await writable.write(blob);
      await writable.close();
      return true;
    } catch (e) {
      if (e instanceof DOMException && e.name === 'AbortError') return false;
      // 피커 실패 → 폴백으로 계속
    }
  }
  const url = URL.createObjectURL(blob);
  const a = document.createElement('a');
  a.href = url;
  a.download = suggestedName;
  document.body.appendChild(a);
  a.click();
  a.remove();
  setTimeout(() => URL.revokeObjectURL(url), 30_000);
  return true;
}

export function exportProjectJson(project: Project): Blob {
  return new Blob([JSON.stringify(project, null, 2)], { type: 'application/json' });
}

export interface ProjectLoadResult {
  ok: boolean;
  project?: Project;
  reason?: string;
}

/** 프로젝트 JSON 불러오기. 영상 파일은 포함되지 않으므로 fileName + durationUs로 매칭을 검증한다. */
export function parseProjectJson(text: string, expect: { fileName: string; durationUs: number }): ProjectLoadResult {
  let parsed: unknown;
  try {
    parsed = JSON.parse(text);
  } catch {
    return { ok: false, reason: '프로젝트 파일을 읽을 수 없습니다.' };
  }
  const p = parsed as Project;
  if (p?.version !== 1 || !p.source || !Array.isArray(p.tracks)) {
    return { ok: false, reason: '프로젝트 파일 형식이 아닙니다.' };
  }
  if (p.source.fileName !== expect.fileName || Math.abs(p.source.durationUs - expect.durationUs) > 50_000) {
    return {
      ok: false,
      reason: `다른 영상의 프로젝트입니다 (${p.source.fileName}). 같은 영상을 연 상태에서 불러오세요.`,
    };
  }
  return { ok: true, project: p };
}

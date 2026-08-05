/**
 * 파일 저장 (내보낸 mp4, 프로젝트 JSON).
 * iPad Safari는 showSaveFilePicker 미지원 → a[download] + Blob URL 폴백.
 */
import type { FrameIndex, Project } from '../types';

export async function saveBlob(blob: Blob, suggestedName: string, _mime: string, _ext: string): Promise<boolean> {
  // showSaveFilePicker는 브라우저별 동작 편차가 커서(iPad 미지원, 제스처 제약)
  // 모든 환경에서 동일하게 동작하는 a[download]로 통일한다.
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

/**
 * 저장 파일 형식: Project + 분석 색인(frames) + 원본 파일 크기.
 * frames를 함께 저장하면 랜딩에서 재분석 없이 즉시 이어서 작업할 수 있다.
 */
export interface SavedProject extends Project {
  frames?: FrameIndex;
  fileSizeBytes?: number;
}

export function exportProjectJson(project: Project, frames: FrameIndex | null, fileSizeBytes: number): Blob {
  const saved: SavedProject = { ...project, ...(frames ? { frames } : {}), fileSizeBytes };
  return new Blob([JSON.stringify(saved, null, 2)], { type: 'application/json' });
}

export interface ProjectParseResult {
  ok: boolean;
  saved?: SavedProject;
  reason?: string;
}

/** 형식 검증만 하는 파싱 (영상 매칭은 호출자가 판단) */
export function parseProjectFile(text: string): ProjectParseResult {
  let parsed: unknown;
  try {
    parsed = JSON.parse(text);
  } catch {
    return { ok: false, reason: '프로젝트 파일을 읽을 수 없습니다.' };
  }
  const p = parsed as SavedProject;
  if (p?.version !== 1 || !p.source || !Array.isArray(p.tracks)) {
    return { ok: false, reason: '프로젝트 파일 형식이 아닙니다.' };
  }
  return { ok: true, saved: p };
}

export interface ProjectLoadResult {
  ok: boolean;
  project?: SavedProject;
  reason?: string;
}

/** 리뷰 화면용: 열린 영상과의 매칭(fileName + durationUs)까지 검증한다. */
export function parseProjectJson(text: string, expect: { fileName: string; durationUs: number }): ProjectLoadResult {
  const parsed = parseProjectFile(text);
  if (!parsed.ok || !parsed.saved) return { ok: false, reason: parsed.reason };
  const p = parsed.saved;
  if (p.source.fileName !== expect.fileName || Math.abs(p.source.durationUs - expect.durationUs) > 50_000) {
    return {
      ok: false,
      reason: `다른 영상의 프로젝트입니다 (${p.source.fileName}). 같은 영상을 연 상태에서 불러오세요.`,
    };
  }
  return { ok: true, project: p };
}

/** 모달 유틸 + 개인정보 설명 모달 + 진행 모달 */
import { etaText } from './format';
import type { Progress } from '../types';

export function openModal(build: (modal: HTMLElement, close: () => void) => void): () => void {
  const backdrop = document.createElement('div');
  backdrop.className = 'modal-backdrop';
  const modal = document.createElement('div');
  modal.className = 'modal';
  backdrop.appendChild(modal);
  const close = (): void => backdrop.remove();
  backdrop.addEventListener('click', (e) => {
    if (e.target === backdrop) close();
  });
  build(modal, close);
  document.body.appendChild(backdrop);
  return close;
}

export function openPrivacyModal(): void {
  openModal((modal, close) => {
    modal.innerHTML = `
      <h3>이 영상은 브라우저 밖으로 나가지 않습니다</h3>
      <p>모든 처리(디코딩·얼굴 검출·모자이크·인코딩)는 이 기기의 브라우저 안에서만 실행됩니다. 서버 업로드가 없고, 계정도 없습니다.</p>
      <p>얼굴 검출 모델도 이 사이트에 함께 내장되어 있어 외부 CDN에 접근하지 않습니다. 첫 로드 이후에는 완전히 오프라인으로 동작합니다.</p>
      <p>직접 확인할 수 있습니다: 개발자도구(F12)의 네트워크 탭을 열어 두고 영상을 처리해 보세요. 네트워크 요청이 발생하지 않습니다. 페이지의 Content-Security-Policy가 외부 연결 자체를 차단합니다.</p>
    `;
    const actions = document.createElement('div');
    actions.className = 'actions';
    const ok = document.createElement('button');
    ok.className = 'primary';
    ok.textContent = '확인';
    ok.addEventListener('click', close);
    actions.appendChild(ok);
    modal.appendChild(actions);
  });
}

export interface ProgressModal {
  update(p: Progress): void;
  close(): void;
}

const PHASE_LABEL: Record<Progress['phase'], string> = {
  demux: '영상을 읽는 중',
  analyze: '얼굴을 찾는 중',
  render: '가림을 적용하는 중',
  mux: '파일을 만드는 중',
};

export function openProgressModal(title: string, onCancel: () => void): ProgressModal {
  let fill: HTMLElement | null = null;
  let label: HTMLElement | null = null;
  const close = openModal((modal) => {
    const h = document.createElement('h3');
    h.textContent = title;
    const track = document.createElement('div');
    track.className = 'progress-track';
    fill = document.createElement('div');
    fill.className = 'progress-fill';
    track.appendChild(fill);
    label = document.createElement('p');
    label.className = 'mono';
    label.textContent = '준비 중';
    const actions = document.createElement('div');
    actions.className = 'actions';
    const cancel = document.createElement('button');
    cancel.textContent = '취소';
    cancel.addEventListener('click', onCancel);
    actions.appendChild(cancel);
    modal.append(h, track, label, actions);
  });

  return {
    update(p: Progress): void {
      const pct = p.total > 0 ? Math.round((p.done / p.total) * 100) : 0;
      if (fill) fill.style.width = `${pct}%`;
      if (label) {
        const eta = etaText(p.etaMs);
        label.textContent = `${PHASE_LABEL[p.phase]} ${pct}%${eta ? ` · ${eta}` : ''}`;
      }
    },
    close,
  };
}

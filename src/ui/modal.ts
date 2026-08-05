/** 모달 유틸 + 개인정보 설명 모달 + 진행 모달 */
import { etaText } from './format';
import { t } from './i18n';
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
      <h3>${t('privacyLine')}</h3>
      <p>${t('privacyP1')}</p>
      <p>${t('privacyP2')}</p>
      <p>${t('privacyP3')}</p>
    `;
    const actions = document.createElement('div');
    actions.className = 'actions';
    const ok = document.createElement('button');
    ok.className = 'primary';
    ok.textContent = t('ok');
    ok.addEventListener('click', close);
    actions.appendChild(ok);
    modal.appendChild(actions);
  });
}

export interface ProgressModal {
  update(p: Progress): void;
  close(): void;
}

function phaseLabel(phase: Progress['phase']): string {
  switch (phase) {
    case 'demux':
      return t('phaseDemux');
    case 'analyze':
      return t('phaseAnalyze');
    case 'render':
      return t('phaseRender');
    case 'mux':
      return t('phaseMux');
  }
}

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
    label.textContent = t('preparing');
    const actions = document.createElement('div');
    actions.className = 'actions';
    const cancel = document.createElement('button');
    cancel.textContent = t('cancel');
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
        label.textContent = `${phaseLabel(p.phase)} ${pct}%${eta ? ` · ${eta}` : ''}`;
      }
    },
    close,
  };
}

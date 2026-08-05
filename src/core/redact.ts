/**
 * 레닥션 합성. 캔버스에는 이미 표시 방향으로 프레임이 그려져 있다고 가정하고,
 * 정규화 박스를 픽셀로 변환해 그 위에 모자이크/솔리드/블러를 얹는다.
 *
 * mosaic이 기본값이다. 가우시안 블러는 반경이 작으면 복원 공격이 가능하다 —
 * blur는 강도 하한을 강제한다 (MIN_BLUR_RADIUS + 박스 크기 비례 하한).
 */
import type { Box, RedactStyle, SourceMeta } from '../types';
import { MIN_BLUR_RADIUS } from '../types';

type Ctx2D = OffscreenCanvasRenderingContext2D | CanvasRenderingContext2D;

// 스크래치 캔버스는 재사용한다 (프레임마다 생성 금지 — 성능 예산)
let workCanvas: OffscreenCanvas | null = null;
let workCtx: OffscreenCanvasRenderingContext2D | null = null;
let cellCanvas: OffscreenCanvas | null = null;
let cellCtx: OffscreenCanvasRenderingContext2D | null = null;
let maskCanvas: OffscreenCanvas | null = null;
let maskCtx: OffscreenCanvasRenderingContext2D | null = null;

function getScratch(w: number, h: number): {
  work: OffscreenCanvasRenderingContext2D;
  mask: OffscreenCanvasRenderingContext2D;
} {
  if (!workCanvas || !workCtx) {
    workCanvas = new OffscreenCanvas(w, h);
    workCtx = workCanvas.getContext('2d')!;
    maskCanvas = new OffscreenCanvas(w, h);
    maskCtx = maskCanvas.getContext('2d')!;
  }
  if (workCanvas.width < w || workCanvas.height < h) {
    workCanvas.width = Math.max(workCanvas.width, w);
    workCanvas.height = Math.max(workCanvas.height, h);
    maskCanvas!.width = workCanvas.width;
    maskCanvas!.height = workCanvas.height;
  }
  workCtx.clearRect(0, 0, w, h);
  maskCtx!.clearRect(0, 0, w, h);
  return { work: workCtx, mask: maskCtx! };
}

export function redactFrame(
  ctx: Ctx2D,
  source: CanvasImageSource | null,
  boxes: { box: Box; style: RedactStyle }[],
  meta: SourceMeta,
): void {
  // source가 null이면 ctx의 캔버스 자신을 소스로 쓴다 (렌더 패스)
  const W = meta.width;
  const H = meta.height;

  for (const { box, style } of boxes) {
    const px = toPixels(scaleBox(box, style.scale), W, H);
    if (!px) continue; // 폭/높이가 0이 되면 스킵
    const { x, y, w, h } = px;
    const short = Math.min(w, h);
    const { work, mask } = getScratch(w, h);

    // 1) 소스 영역을 work 캔버스로 가져와 스타일 적용
    const src = source ?? (ctx.canvas as OffscreenCanvas);
    switch (style.kind) {
      case 'mosaic': {
        // 다운스케일 왕복: 축소(평균화) 후 smoothing 없이 확대
        const cell = Math.max(3, Math.round(short * style.strength));
        const sw = Math.max(1, Math.ceil(w / cell));
        const sh = Math.max(1, Math.ceil(h / cell));
        if (!cellCanvas || !cellCtx) {
          cellCanvas = new OffscreenCanvas(sw, sh);
          cellCtx = cellCanvas.getContext('2d')!;
        }
        if (cellCanvas.width < sw || cellCanvas.height < sh) {
          cellCanvas.width = Math.max(cellCanvas.width, sw);
          cellCanvas.height = Math.max(cellCanvas.height, sh);
        }
        cellCtx.imageSmoothingEnabled = true;
        cellCtx.clearRect(0, 0, sw, sh);
        cellCtx.drawImage(src, x, y, w, h, 0, 0, sw, sh);
        work.imageSmoothingEnabled = false;
        work.drawImage(cellCanvas, 0, 0, sw, sh, 0, 0, w, h);
        work.imageSmoothingEnabled = true;
        break;
      }
      case 'blur': {
        // 복원 공격 방지: 반경 하한 강제
        const radius = Math.max(MIN_BLUR_RADIUS, short * 0.08, style.strength);
        work.filter = `blur(${radius}px)`;
        // 블러 가장자리 번짐을 줄이기 위해 살짝 넓게 그린다
        work.drawImage(src, x - radius, y - radius, w + radius * 2, h + radius * 2, -radius, -radius, w + radius * 2, h + radius * 2);
        work.filter = 'none';
        break;
      }
      case 'solid': {
        work.fillStyle = '#000000';
        work.fillRect(0, 0, w, h);
        break;
      }
    }

    // 2) 모양 + 페더 알파 마스크를 destination-in으로 적용
    const featherPx = Math.max(0, Math.min(1, style.feather)) * (short / 2);
    mask.save();
    if (style.shape === 'ellipse') {
      if (featherPx > 0.5) {
        const g = mask.createRadialGradient(w / 2, h / 2, 0, w / 2, h / 2, 1);
        // 반경 1 기준 그라디언트를 타원으로 스케일
        mask.translate(w / 2, h / 2);
        mask.scale(w / 2, h / 2);
        const inner = Math.max(0, 1 - (featherPx / (short / 2)));
        g.addColorStop(0, 'rgba(0,0,0,1)');
        g.addColorStop(inner, 'rgba(0,0,0,1)');
        g.addColorStop(1, 'rgba(0,0,0,0)');
        mask.fillStyle = g;
        mask.beginPath();
        mask.arc(0, 0, 1, 0, Math.PI * 2);
        mask.fill();
      } else {
        mask.fillStyle = '#000';
        mask.beginPath();
        mask.ellipse(w / 2, h / 2, w / 2, h / 2, 0, 0, Math.PI * 2);
        mask.fill();
      }
    } else {
      mask.fillStyle = '#000';
      if (featherPx > 0.5) {
        mask.filter = `blur(${featherPx}px)`;
        mask.fillRect(featherPx, featherPx, w - featherPx * 2, h - featherPx * 2);
        mask.filter = 'none';
      } else {
        mask.fillRect(0, 0, w, h);
      }
    }
    mask.restore();

    work.globalCompositeOperation = 'destination-in';
    work.drawImage(maskCanvas!, 0, 0, w, h, 0, 0, w, h);
    work.globalCompositeOperation = 'source-over';

    // 3) 본 캔버스에 합성
    ctx.drawImage(workCanvas!, 0, 0, w, h, x, y, w, h);
  }
}

/** 박스를 style.scale만큼 확대. 중심 고정. */
export function scaleBox(box: Box, scale: number): Box {
  const cx = box.x + box.w / 2;
  const cy = box.y + box.h / 2;
  const w = box.w * scale;
  const h = box.h * scale;
  return { x: cx - w / 2, y: cy - h / 2, w, h };
}

/** 정규화 → 픽셀 변환 + 프레임 경계 clamp. 소멸하면 null. */
function toPixels(box: Box, W: number, H: number): { x: number; y: number; w: number; h: number } | null {
  const x1 = Math.max(0, Math.min(W, box.x * W));
  const y1 = Math.max(0, Math.min(H, box.y * H));
  const x2 = Math.max(0, Math.min(W, (box.x + box.w) * W));
  const y2 = Math.max(0, Math.min(H, (box.y + box.h) * H));
  const w = Math.round(x2 - x1);
  const h = Math.round(y2 - y1);
  if (w < 1 || h < 1) return null;
  return { x: Math.round(x1), y: Math.round(y1), w, h };
}

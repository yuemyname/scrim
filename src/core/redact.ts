/**
 * 레닥션 합성. 캔버스에는 이미 표시 방향으로 프레임이 그려져 있다고 가정하고,
 * 정규화 박스를 픽셀로 변환해 그 위에 모자이크/블러/스티커를 얹는다.
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

function ensureCell(w: number, h: number): OffscreenCanvasRenderingContext2D {
  if (!cellCanvas || !cellCtx) {
    cellCanvas = new OffscreenCanvas(w, h);
    cellCtx = cellCanvas.getContext('2d')!;
  }
  if (cellCanvas.width < w || cellCanvas.height < h) {
    cellCanvas.width = Math.max(cellCanvas.width, w);
    cellCanvas.height = Math.max(cellCanvas.height, h);
  }
  return cellCtx;
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
    // 주의: ctx.filter는 iPad Safari가 지원하지 않는다 — 블러/페더 모두 filter 없이 구현한다.
    const src = source ?? (ctx.canvas as OffscreenCanvas);
    switch (style.kind) {
      case 'blur': {
        // 복원 공격 방지: 반경 하한 강제.
        // 다운스케일 왕복 2회(스무딩 켠 채)로 근사 가우시안 — filter 미지원 브라우저 공통 동작.
        const radius = Math.max(MIN_BLUR_RADIUS, short * 0.08, style.strength);
        const s = Math.max(3, radius / 2);
        const bw = Math.max(1, Math.round(w / s));
        const bh = Math.max(1, Math.round(h / s));
        const cctx = ensureCell(bw, bh);
        cctx.imageSmoothingEnabled = true;
        work.imageSmoothingEnabled = true;
        cctx.clearRect(0, 0, bw, bh);
        cctx.drawImage(src, x, y, w, h, 0, 0, bw, bh);
        work.drawImage(cellCanvas!, 0, 0, bw, bh, 0, 0, w, h);
        cctx.clearRect(0, 0, bw, bh);
        cctx.drawImage(workCanvas!, 0, 0, w, h, 0, 0, bw, bh);
        work.clearRect(0, 0, w, h);
        work.drawImage(cellCanvas!, 0, 0, bw, bh, 0, 0, w, h);
        break;
      }
      case 'sticker': {
        // 이모지만으로는 얼굴이 다 가려지지 않을 수 있다 — 모자이크 바탕을 깔고
        // 이모지/문구는 마스크 적용 후에 얹는다 (아래 별도 처리)
        const cell = Math.max(3, Math.round(short * 0.12));
        const sw = Math.max(1, Math.ceil(w / cell));
        const sh = Math.max(1, Math.ceil(h / cell));
        const cctx = ensureCell(sw, sh);
        cctx.imageSmoothingEnabled = true;
        cctx.clearRect(0, 0, sw, sh);
        cctx.drawImage(src, x, y, w, h, 0, 0, sw, sh);
        work.imageSmoothingEnabled = false;
        work.drawImage(cellCanvas!, 0, 0, sw, sh, 0, 0, w, h);
        work.imageSmoothingEnabled = true;
        break;
      }
      default: {
        // 모자이크 — 기본값. 알 수 없는 kind(구버전 'solid' 등)도 안전하게 모자이크 처리.
        // 다운스케일 왕복: 축소(평균화) 후 smoothing 없이 확대
        const cell = Math.max(3, Math.round(short * style.strength));
        const sw = Math.max(1, Math.ceil(w / cell));
        const sh = Math.max(1, Math.ceil(h / cell));
        const cctx = ensureCell(sw, sh);
        cctx.imageSmoothingEnabled = true;
        cctx.clearRect(0, 0, sw, sh);
        cctx.drawImage(src, x, y, w, h, 0, 0, sw, sh);
        work.imageSmoothingEnabled = false;
        work.drawImage(cellCanvas!, 0, 0, sw, sh, 0, 0, w, h);
        work.imageSmoothingEnabled = true;
        break;
      }
    }

    // 2) 모양 + 페더 알파 마스크를 destination-in으로 적용
    const featherPx = Math.max(0, Math.min(1, style.feather)) * (short / 2);
    mask.save();
    mask.fillStyle = '#000';
    if (style.shape === 'ellipse') {
      if (featherPx > 0.5) {
        // 그라디언트는 변환된 좌표계 기준 — 중심 (0,0), 반경 1
        mask.translate(w / 2, h / 2);
        mask.scale(w / 2, h / 2);
        const inner = Math.min(0.999, Math.max(0, 1 - featherPx / (short / 2)));
        const g = mask.createRadialGradient(0, 0, 0, 0, 0, 1);
        g.addColorStop(0, 'rgba(0,0,0,1)');
        g.addColorStop(inner, 'rgba(0,0,0,1)');
        g.addColorStop(1, 'rgba(0,0,0,0)');
        mask.fillStyle = g;
        mask.beginPath();
        mask.arc(0, 0, 1, 0, Math.PI * 2);
        mask.fill();
      } else {
        mask.beginPath();
        mask.ellipse(w / 2, h / 2, w / 2, h / 2, 0, 0, Math.PI * 2);
        mask.fill();
      }
    } else {
      if (featherPx > 0.5) {
        // filter 없는 소프트 엣지: 인셋 사각형을 축소 캔버스에 그린 뒤 스무딩 업스케일
        const s = Math.max(2, featherPx);
        const mw = Math.max(2, Math.round(w / s));
        const mh = Math.max(2, Math.round(h / s));
        const cctx = ensureCell(mw, mh);
        cctx.clearRect(0, 0, mw, mh);
        cctx.fillStyle = '#000';
        cctx.fillRect(1, 1, mw - 2, mh - 2);
        mask.imageSmoothingEnabled = true;
        mask.drawImage(cellCanvas!, 0, 0, mw, mh, 0, 0, w, h);
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

    // 4) 스티커: 박스보다 크게(1.4×) 본 캔버스에 직접 그린다 — 글리프가 얼굴을
    //    통째로 덮어 "이모지로 바뀐" 느낌을 준다. 글리프 가장자리의 투명 영역은
    //    아래에 깔린 모자이크 바탕이 막아주므로 비식별화 보장은 유지된다.
    if (style.kind === 'sticker') {
      const text = (style.sticker ?? '🙂').trim() || '🙂';
      ctx.save();
      ctx.textAlign = 'center';
      ctx.textBaseline = 'middle';
      let fontPx = short * 1.4;
      ctx.font = `${fontPx}px sans-serif`;
      const measured = ctx.measureText(text).width;
      const maxW = w * 1.35; // 문구는 박스 폭의 1.35배까지 허용 (살짝 넘치는 게 의도)
      if (measured > maxW) {
        fontPx = (fontPx * maxW) / Math.max(1, measured);
        ctx.font = `${fontPx}px sans-serif`;
      }
      // 문구(비이모지)일 때 가독성을 위한 흰 글자 + 어두운 윤곽
      ctx.strokeStyle = 'rgba(0,0,0,0.7)';
      ctx.lineWidth = Math.max(1, fontPx * 0.06);
      ctx.fillStyle = '#FFFFFF';
      ctx.strokeText(text, x + w / 2, y + h / 2);
      ctx.fillText(text, x + w / 2, y + h / 2);
      ctx.restore();
    }
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

/**
 * 회전 처리 공용 헬퍼.
 * VideoFrame에는 컨테이너 회전 메타데이터가 없으므로 직접 transform을 적용해
 * "표시 방향" 캔버스에 그린다. 출력 mp4는 rotation 0으로 baked 된다.
 */
type Ctx2D = OffscreenCanvasRenderingContext2D | CanvasRenderingContext2D;

export function drawFrameOriented(
  ctx: Ctx2D,
  frame: CanvasImageSource,
  rotation: number,
  dw: number,
  dh: number,
): void {
  ctx.save();
  switch (rotation) {
    case 90:
      ctx.translate(dw, 0);
      ctx.rotate(Math.PI / 2);
      ctx.drawImage(frame, 0, 0, dh, dw);
      break;
    case 180:
      ctx.translate(dw, dh);
      ctx.rotate(Math.PI);
      ctx.drawImage(frame, 0, 0, dw, dh);
      break;
    case 270:
      ctx.translate(0, dh);
      ctx.rotate(-Math.PI / 2);
      ctx.drawImage(frame, 0, 0, dh, dw);
      break;
    default:
      ctx.drawImage(frame, 0, 0, dw, dh);
  }
  ctx.restore();
}

let videoFrameDrawMode: 'direct' | 'bitmap' = 'direct';

/**
 * VideoFrame을 캔버스에 그린다. 일부 Safari 버전은 drawImage(VideoFrame)를
 * 지원하지 않아 TypeError를 던진다 → ImageBitmap 경유 폴백 (한 번 실패하면 이후 계속 폴백 사용).
 */
export async function drawVideoFrame(
  ctx: Ctx2D,
  frame: VideoFrame,
  rotation: number,
  dw: number,
  dh: number,
): Promise<void> {
  if (videoFrameDrawMode === 'direct') {
    try {
      drawFrameOriented(ctx, frame as unknown as CanvasImageSource, rotation, dw, dh);
      return;
    } catch {
      videoFrameDrawMode = 'bitmap';
    }
  }
  const bmp = await createImageBitmap(frame);
  try {
    drawFrameOriented(ctx, bmp, rotation, dw, dh);
  } finally {
    bmp.close();
  }
}

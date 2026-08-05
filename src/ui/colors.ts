/**
 * 트랙 식별 색상. 같은 프레임에 여러 박스가 있을 때 구분하기 위한 보더/목록 색.
 * 첫 트랙(A1)은 기본 노란색. 수동 트랙은 팔레트 후반부터 시작해 자동 트랙과 겹침을 줄인다.
 */
const PALETTE = ['#FFD400', '#4FC3F7', '#FF7DAD', '#7CE38B', '#C792EA', '#FFA94D'];

export function trackColor(id: string): string {
  const m = /^([AM])(\d+)$/.exec(id);
  if (!m) return PALETTE[0]!;
  const n = Number(m[2]) - 1;
  const offset = m[1] === 'M' ? 3 : 0;
  return PALETTE[(n + offset) % PALETTE.length]!;
}

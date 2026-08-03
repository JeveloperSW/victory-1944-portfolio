import type { Graphics } from 'pixi.js';

/**
 * 아이소메트릭 도형 프리미티브.
 * 외부 이미지 에셋 없이 형태를 코드로 그린다(D-037).
 * 광원은 화면 왼쪽 위 하나로 고정한다 — 윗면이 가장 밝고, 남서면, 남동면 순으로 어두워진다.
 * 이 규칙 하나가 모든 도형을 같은 공간에 있는 입체로 읽히게 한다.
 */

export const LIGHT_TOP = 1.2;
export const LIGHT_LEFT = 0.95;
export const LIGHT_RIGHT = 0.66;

/** 색을 밝기 배수로 조정한다. 각 채널을 독립적으로 곱하고 255에서 자른다. */
export function shade(color: number, factor: number): number {
  const r = Math.min(255, Math.round(((color >> 16) & 0xff) * factor));
  const g = Math.min(255, Math.round(((color >> 8) & 0xff) * factor));
  const b = Math.min(255, Math.round((color & 0xff) * factor));
  return (r << 16) | (g << 8) | b;
}

/**
 * 셀 안의 상대 좌표를 화면 좌표로 옮긴다.
 * (a, b)는 0..1이며 (0,0)=북, (1,0)=동, (1,1)=남, (0,1)=서 꼭짓점에 대응한다.
 */
export function cellPoint(
  cx: number,
  cy: number,
  hw: number,
  hh: number,
  a: number,
  b: number,
): [number, number] {
  return [cx + (a - b) * hw, cy + (a + b - 1) * hh];
}

/** 바닥 마름모. 지반 패드와 도로에 쓴다. */
export function diamond(
  g: Graphics,
  cx: number,
  cy: number,
  hw: number,
  hh: number,
  color: number,
  alpha = 1,
): void {
  g.poly([cx, cy - hh, cx + hw, cy, cx, cy + hh, cx - hw, cy]).fill({ color, alpha });
}

/**
 * 직육면체. (cx, cy)는 바닥 마름모의 중심이고 h는 화면 위쪽으로의 높이다.
 * 보이는 세 면만 그린다 — 뒤쪽 두 면은 어차피 가려진다.
 */
export function box(
  g: Graphics,
  cx: number,
  cy: number,
  hw: number,
  hh: number,
  h: number,
  color: number,
): void {
  g.poly([cx + hw, cy, cx, cy + hh, cx, cy + hh - h, cx + hw, cy - h])
    .fill(shade(color, LIGHT_RIGHT));
  g.poly([cx - hw, cy, cx, cy + hh, cx, cy + hh - h, cx - hw, cy - h])
    .fill(shade(color, LIGHT_LEFT));
  g.poly([cx, cy - h - hh, cx + hw, cy - h, cx, cy - h + hh, cx - hw, cy - h])
    .fill(shade(color, LIGHT_TOP));
}

/**
 * 박공 지붕. 용마루는 북동 모서리와 나란히 놓는다.
 * 두 지붕면 모두 마주보는 변이 평행하므로 평면으로 성립한다.
 */
export function gable(
  g: Graphics,
  cx: number,
  cy: number,
  hw: number,
  hh: number,
  h: number,
  ridge: number,
  color: number,
): void {
  const north: [number, number] = [cx, cy - h - hh];
  const east: [number, number] = [cx + hw, cy - h];
  const south: [number, number] = [cx, cy - h + hh];
  const west: [number, number] = [cx - hw, cy - h];
  const ridgeA: [number, number] = [cx - hw / 2, cy - h - hh / 2 - ridge];
  const ridgeB: [number, number] = [cx + hw / 2, cy - h + hh / 2 - ridge];
  g.poly([...north, ...east, ...ridgeB, ...ridgeA]).fill(shade(color, LIGHT_TOP));
  g.poly([...west, ...south, ...ridgeB, ...ridgeA]).fill(shade(color, LIGHT_LEFT * 0.86));
  g.poly([...ridgeA, ...ridgeB]).stroke({ width: 1, color: shade(color, 1.35), alpha: 0.7 });
}

/**
 * 반원통 지붕(퀀셋 막사). 용마루는 남서→북동으로 눕힌다.
 *
 * 박공(`gable`)과 실루엣이 확실히 갈리는 지붕이 하나 필요했다(D-049) —
 * 예전에는 창고·물류센터·병영·격납고가 전부 박공이라 작은 크기에서 같은 도형으로 보였다.
 * 곡면은 가로 띠를 여러 겹 쌓아 근사한다. 띠마다 밝기를 바꿔 둥글게 읽히게 한다.
 */
export function barrel(
  g: Graphics,
  cx: number,
  cy: number,
  hw: number,
  hh: number,
  h: number,
  rise: number,
  color: number,
): void {
  const steps = 7;
  for (let i = steps; i >= 1; i -= 1) {
    const t = i / steps;
    // 반원 단면: 폭은 sin, 높이는 cos으로 줄어든다.
    const w = hw * Math.sin(Math.acos(1 - t));
    const lift = rise * (1 - t);
    const shadeFactor = LIGHT_TOP - (LIGHT_TOP - LIGHT_LEFT) * (1 - t) * 1.4;
    g.poly([
      cx, cy - h - hh - lift,
      cx + w, cy - h - lift + (hh - w * (hh / hw)) * 0,
      cx, cy - h + hh - lift,
      cx - w, cy - h - lift,
    ]).fill(shade(color, Math.max(0.45, shadeFactor)));
  }
  // 남서쪽 마구리. 반원 실루엣을 정면에서 한 번 더 보여준다.
  g.poly([cx - hw, cy - h, cx, cy - h + hh, cx, cy - h + hh - rise, cx - hw, cy - h - rise * 0.55])
    .fill(shade(color, LIGHT_LEFT * 0.8));
}

/**
 * 문형 크레인(갠트리). 두 다리와 상부 보로 부지 위를 가로지른다.
 * 건물 위로 솟는 뼈대라 지붕만으로는 구분되지 않는 공장류의 실루엣을 확실히 끊는다(D-049).
 */
export function gantry(
  g: Graphics,
  ax: number,
  ay: number,
  bx: number,
  by: number,
  h: number,
  color: number,
): void {
  g.rect(ax - 2, ay - h, 4, h).fill(shade(color, LIGHT_LEFT));
  g.rect(bx - 2, by - h, 4, h).fill(shade(color, LIGHT_RIGHT));
  // 상부 보. 얇으면 다리 두 개가 따로 선 막대로 보인다 — 두껍게 그어 문(門)으로 읽히게 한다.
  g.poly([ax, ay - h, bx, by - h, bx, by - h + 5, ax, ay - h + 5])
    .fill(shade(color, LIGHT_TOP));
  g.poly([ax, ay - h, bx, by - h])
    .stroke({ width: 1, color: shade(color, 1.4), alpha: 0.8 });
  // 보에 매달린 호이스트
  const mx = (ax + bx) / 2;
  const my = (ay + by) / 2;
  g.rect(mx - 2.5, my - h + 4, 5, 5).fill(shade(color, 0.6));
}

/** 원통. 저장 탱크와 굴뚝에 쓴다. 아이소메트릭 근사이며 정확한 투영은 아니다. */
export function cylinder(
  g: Graphics,
  cx: number,
  cy: number,
  rx: number,
  ry: number,
  h: number,
  color: number,
): void {
  g.rect(cx - rx, cy - h, rx * 2, h).fill(shade(color, LIGHT_RIGHT));
  g.rect(cx - rx, cy - h, rx * 1.05, h).fill(shade(color, LIGHT_LEFT));
  g.ellipse(cx, cy, rx, ry).fill(shade(color, LIGHT_RIGHT * 0.9));
  g.ellipse(cx, cy - h, rx, ry).fill(shade(color, LIGHT_TOP));
}

/**
 * 바닥에 깔리는 타원 그림자. 물체를 지면에 붙여 보이게 한다.
 * 두 겹으로 깐다(D-048) — 넓고 옅은 그림자 위에 좁고 진한 것을 얹으면
 * 접지면이 분명해지면서도 가장자리가 딱딱하지 않다.
 */
export function shadow(g: Graphics, cx: number, cy: number, rx: number, ry: number): void {
  g.ellipse(cx, cy, rx * 1.25, ry * 1.25).fill({ color: 0x000000, alpha: 0.16 });
  g.ellipse(cx, cy, rx, ry).fill({ color: 0x000000, alpha: 0.3 });
}

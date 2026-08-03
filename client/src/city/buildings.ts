import type { Graphics } from 'pixi.js';
import type { BuildingId } from '../api/contract.js';
import { barrel, box, cellPoint, cylinder, diamond, gable, gantry, shade, shadow } from './iso.js';

/**
 * 건물별 형태(D-037). 각 건물은 실루엣만으로 구분되어야 하며,
 * 레벨이 오르면 눈에 보이게 자란다 — 숫자를 읽지 않아도 성장이 보이는 것이 목적이다.
 */

/**
 * 도시 팔레트(D-048).
 *
 * 이전 값들은 명도가 좁은 구간(0x40~0x7d)에 몰려 있어, 어두운 부지 위에서 건물이
 * **하나의 회색 덩어리로 뭉쳐 보였다.** 실루엣으로 구분되게 하려면 색이 아니라 명도가 갈려야 한다.
 *
 * 그래서 셋을 바꿨다.
 * 1. 부지·지면을 더 어둡게 내려 건물이 올라앉을 바탕을 만든다.
 * 2. 건물 재질의 명도 폭을 넓힌다(콘크리트는 밝게, 지붕·금속은 더 어둡게).
 * 3. 따뜻한 계열(벽돌·녹·목재·캔버스)의 채도를 올려 회색 일변도를 깬다.
 */
export const C = {
  // 지면 — 건물보다 확실히 어둡다.
  padTop: 0x27331f,
  padSide: 0x151d13,
  gravel: 0x4a4738,
  gravelLine: 0x5d5944,
  soil: 0x42341f,
  crop: 0x66742c,
  cropRipe: 0xa89a3d,
  // 밝은 재질 — 실루엣의 위쪽을 담당한다.
  concrete: 0x8b8f81,
  concreteWarm: 0x9a917c,
  canvas: 0xa8996f,
  // 중간 재질
  brick: 0x8d4f3c,
  rust: 0x975d35,
  wood: 0x7d5f38,
  scaffold: 0xa07c42,
  // 어두운 재질 — 지붕과 금속으로 실루엣 위쪽을 끊는다.
  metal: 0x4c5660,
  roof: 0x33392f,
  roofTile: 0x6d3f31,
  // 발광
  window: 0xf0c860,
  ember: 0xff8a3c,
  accent: 0xf0c860,
  accentDeep: 0xa8853a,
} as const;

export interface PlotGeometry {
  readonly cx: number;
  readonly cy: number;
  readonly hw: number;
  readonly hh: number;
}

export type EmitterKind = 'smoke' | 'flame' | 'flag' | 'crane';

export interface Emitter {
  readonly x: number;
  readonly y: number;
  readonly kind: EmitterKind;
  readonly scale: number;
}

/** `height`는 부지 바닥에서 실루엣 꼭대기까지의 화면 높이다. 라벨을 그 위에 놓는 데 쓴다. */
export interface Built {
  readonly emitters: readonly Emitter[];
  readonly height: number;
}

function at(geo: PlotGeometry, a: number, b: number): [number, number] {
  return cellPoint(geo.cx, geo.cy, geo.hw, geo.hh, a, b);
}

/**
 * 부지 지면의 성격(D-051).
 *
 * 예전에는 14개 부지가 전부 같은 초록이었다. 농장·병영·비행장만 자기 지면을 **덮어 그렸는데**,
 * 그러면 패드 한 장을 그리고 바로 위에 또 한 장을 그리는 낭비였고 나머지 11개는 구분이 없었다.
 * 지면을 패드가 직접 알게 해서, 건물이 서기 전부터 그 부지가 무엇을 하는 곳인지 읽히게 한다.
 */
export type GroundKind =
  | 'grass' // 잔디 — 주거·행정
  | 'soil' // 다져진 흙 — 농경·연병장
  | 'gravel' // 자갈 야적장 — 물류·통신
  | 'concrete' // 콘크리트 포장 — 공장·활주로
  | 'scorched' // 그을린 슬래그 — 제철
  | 'oiled'; // 기름 얼룩 — 정유

/** 건물별 지면. 형태(D-049)와 함께 부지의 성격을 만든다. */
export const PLOT_GROUND: Readonly<Record<BuildingId, GroundKind>> = {
  hq: 'concrete',
  farm: 'soil',
  steel_mill: 'scorched',
  refinery: 'oiled',
  supply_depot: 'gravel',
  housing: 'grass',
  warehouse: 'concrete',
  barracks: 'soil',
  arsenal: 'concrete',
  airfield: 'concrete',
  research_lab: 'grass',
  radar: 'gravel',
  defense_hq: 'soil',
  alliance_comms: 'gravel',
};

const GROUND_BASE: Readonly<Record<GroundKind, number>> = {
  grass: C.padTop,
  soil: C.soil,
  gravel: 0x4a4738,
  concrete: 0x54584e,
  scorched: 0x33302b,
  oiled: 0x45474a,
};

/** 지면 질감. 작은 크기에서 뭉개지지 않게 요소를 적게, 대비를 낮게 유지한다. */
function groundTexture(g: Graphics, geo: PlotGeometry, kind: GroundKind): void {
  const { cx, cy, hw, hh } = geo;
  const base = GROUND_BASE[kind];
  switch (kind) {
    case 'soil':
      // 이랑 세 줄.
      for (let i = 1; i <= 3; i += 1) {
        const t = i / 4;
        g.poly([...cellPoint(cx, cy, hw, hh, t, 0.08), ...cellPoint(cx, cy, hw, hh, t, 0.92)])
          .stroke({ width: 1, color: shade(base, 1.25), alpha: 0.45 });
      }
      break;
    case 'concrete':
      // 슬래브 이음선 두 줄(가로·세로 한 줄씩).
      g.poly([...cellPoint(cx, cy, hw, hh, 0.5, 0.06), ...cellPoint(cx, cy, hw, hh, 0.5, 0.94)])
        .stroke({ width: 1, color: shade(base, 1.3), alpha: 0.5 });
      g.poly([...cellPoint(cx, cy, hw, hh, 0.06, 0.5), ...cellPoint(cx, cy, hw, hh, 0.94, 0.5)])
        .stroke({ width: 1, color: shade(base, 1.3), alpha: 0.5 });
      break;
    case 'gravel':
      // 잔자갈 얼룩.
      for (const [a, b] of [[0.28, 0.3], [0.62, 0.24], [0.36, 0.7], [0.74, 0.66], [0.5, 0.48]] as [number, number][]) {
        const [px, py] = cellPoint(cx, cy, hw, hh, a, b);
        g.ellipse(px, py, hw * 0.09, hh * 0.09).fill({ color: shade(base, 1.22), alpha: 0.5 });
      }
      break;
    case 'scorched':
      // 슬래그 더미와 잔불.
      for (const [a, b] of [[0.3, 0.72], [0.68, 0.3]] as [number, number][]) {
        const [px, py] = cellPoint(cx, cy, hw, hh, a, b);
        g.ellipse(px, py, hw * 0.14, hh * 0.14).fill({ color: shade(base, 0.7), alpha: 0.8 });
        g.ellipse(px, py, hw * 0.05, hh * 0.05).fill({ color: C.ember, alpha: 0.28 });
      }
      break;
    case 'oiled':
      // 기름 얼룩.
      for (const [a, b] of [[0.34, 0.62], [0.66, 0.36]] as [number, number][]) {
        const [px, py] = cellPoint(cx, cy, hw, hh, a, b);
        g.ellipse(px, py, hw * 0.2, hh * 0.18).fill({ color: 0x21242a, alpha: 0.55 });
      }
      break;
    case 'grass':
    default:
      // 풀숲 몇 점.
      for (const [a, b] of [[0.24, 0.36], [0.7, 0.28], [0.4, 0.76]] as [number, number][]) {
        const [px, py] = cellPoint(cx, cy, hw, hh, a, b);
        g.ellipse(px, py, hw * 0.07, hh * 0.07).fill({ color: shade(base, 1.4), alpha: 0.45 });
      }
      break;
  }
}

/** 건물이 올라앉는 지반 패드. 얇게 돋워 도시가 지면 위에 있다는 인상을 준다. */
export function drawPad(
  g: Graphics,
  geo: PlotGeometry,
  active: boolean,
  selected = false,
  kind: GroundKind = 'grass',
): void {
  const { cx, cy, hw, hh } = geo;
  const lift = 5;
  const base = GROUND_BASE[kind];
  g.poly([cx + hw, cy, cx, cy + hh, cx, cy + hh + lift, cx + hw, cy + lift])
    .fill(shade(base, 0.42));
  g.poly([cx - hw, cy, cx, cy + hh, cx, cy + hh + lift, cx - hw, cy + lift])
    .fill(shade(base, 0.55));
  // 건설 중인 부지는 조금 밝게 해서 눈에 띄게 한다.
  diamond(g, cx, cy, hw, hh, active ? shade(base, 1.12) : base);
  groundTexture(g, geo, kind);
  g.poly([cx, cy - hh, cx + hw, cy, cx, cy + hh, cx - hw, cy], true)
    .stroke(selected
      ? { width: 2, color: C.accent, alpha: 0.95 }
      : { width: 1, color: shade(base, 1.35), alpha: 0.35 });
}

function hq(g: Graphics, geo: PlotGeometry, level: number): Built {
  const { hw, hh } = geo;
  const baseH = 13 + level * 2;
  const towerH = baseH + 12 + level * 2;
  // 뒤쪽(관제탑)을 먼저, 앞쪽(본관)을 나중에 — 화가의 순서를 지켜야 앞이 뒤를 가린다.
  const [tx, ty] = at(geo, 0.34, 0.34);
  shadow(g, tx, ty + 1, hw * 0.34, hh * 0.34);
  box(g, tx, ty, hw * 0.26, hh * 0.26, towerH, C.concreteWarm);
  // 꼭대기 관측층을 조금 넓게 내밀어 실루엣을 끊는다(굴뚝으로 읽히지 않게).
  box(g, tx, ty - towerH, hw * 0.33, hh * 0.33, 5, shade(C.concrete, 0.75));
  const floors = Math.min(5, 1 + Math.floor(level / 2));
  for (let i = 0; i < floors; i += 1) {
    g.rect(tx - hw * 0.22, ty - towerH + 9 + i * 6, hw * 0.19, 2)
      .fill({ color: C.window, alpha: 0.8 });
  }
  const [bx, by] = at(geo, 0.62, 0.66);
  shadow(g, bx, by + 2, hw * 0.66, hh * 0.66);
  box(g, bx, by, hw * 0.46, hh * 0.46, baseH, C.concrete);
  g.rect(bx - hw * 0.1, by + hh * 0.2 - baseH * 0.55, hw * 0.2, baseH * 0.45)
    .fill(shade(C.concrete, 0.5));
  const poleTop = ty - towerH - 5 - 18;
  g.rect(tx - 0.8, poleTop, 1.6, 18).fill(shade(C.metal, 1.3));
  return {
    emitters: [{ x: tx, y: poleTop, kind: 'flag', scale: 1 }],
    height: towerH + 5 + 18,
  };
}

function farm(g: Graphics, geo: PlotGeometry, level: number): Built {
  const { hw, hh } = geo;
  // 지면(흙)은 패드가 깐다(D-051). 여기서는 그 위의 경작 이랑만 그린다.
  const rows = 3 + Math.min(level, 6);
  for (let i = 0; i < rows; i += 1) {
    const a0 = 0.06 + (i / rows) * 0.62;
    const a1 = a0 + 0.4 / rows;
    g.poly([
      ...at(geo, a0, 0.1), ...at(geo, a1, 0.1),
      ...at(geo, a1, 0.92), ...at(geo, a0, 0.92),
    ]).fill(i % 2 === 0 ? C.crop : C.cropRipe);
  }
  const [barnX, barnY] = at(geo, 0.84, 0.5);
  // 헛간도 조금씩 커진다. 예전에는 고정 크기라 경작지만 촘촘해지고 건물은 그대로였다(D-050).
  const barnH = 7 + level * 0.5;
  shadow(g, barnX, barnY + 1, hw * 0.3, hh * 0.3);
  box(g, barnX, barnY, hw * 0.24, hh * 0.24, barnH, C.wood);
  gable(g, barnX, barnY, hw * 0.24, hh * 0.24, barnH, 8, C.roofTile);
  let top = barnH + 8;
  // 사일로. 3레벨에 한 기, 6레벨에 두 기 — 개수로 성장이 읽힌다.
  const silos = level >= 6 ? 2 : level >= 3 ? 1 : 0;
  for (let i = 0; i < silos; i += 1) {
    const [siloX, siloY] = at(geo, 0.88 - i * 0.14, 0.88);
    const siloH = 12 + level;
    shadow(g, siloX, siloY + 1, hw * 0.12, hh * 0.12);
    cylinder(g, siloX, siloY, hw * 0.1, hh * 0.1, siloH, C.concrete);
    // 원뿔 지붕
    g.poly([siloX, siloY - siloH - 5, siloX + hw * 0.1, siloY - siloH,
      siloX - hw * 0.1, siloY - siloH]).fill(shade(C.roof, 1.15));
    top = Math.max(top, siloH + 8);
  }
  return { emitters: [], height: top };
}

function steelMill(g: Graphics, geo: PlotGeometry, level: number): Built {
  const { hw, hh } = geo;
  // 굴뚝이 뒤쪽에 서므로 본관보다 먼저 그린다.
  const stacks = Math.min(4, 2 + Math.floor(level / 3));
  const emitters: Emitter[] = [];
  let top = 0;
  for (let i = 0; i < stacks; i += 1) {
    const a = 0.22 + (i / Math.max(1, stacks - 1)) * 0.46;
    const [sx, sy] = at(geo, a, 0.2);
    const height = 20 + level * 2.4 + i * 3;
    cylinder(g, sx, sy, hw * 0.055, hh * 0.055, height, C.rust);
    g.rect(sx - hw * 0.06, sy - height - 2, hw * 0.12, 2.5).fill(shade(C.rust, 1.3));
    emitters.push({ x: sx, y: sy - height - 4, kind: 'smoke', scale: 0.8 + i * 0.12 });
    top = Math.max(top, height + 4);
  }
  const [hxx, hyy] = at(geo, 0.58, 0.68);
  const hallH = 10 + level * 2;
  shadow(g, hxx, hyy + 2, hw * 0.62, hh * 0.62);
  box(g, hxx, hyy, hw * 0.5, hh * 0.5, hallH, C.brick);
  // 용광로 문에서 새는 불빛
  g.rect(hxx - hw * 0.24, hyy + hh * 0.18 - 7, hw * 0.15, 5)
    .fill({ color: C.ember, alpha: 0.9 });
  return { emitters, height: Math.max(top, hallH) };
}

function refinery(g: Graphics, geo: PlotGeometry, level: number): Built {
  const { hw, hh } = geo;
  // 배관을 먼저 깔아 탱크가 그 위에 앉게 한다.
  const [p0x, p0y] = at(geo, 0.28, 0.34);
  const [p1x, p1y] = at(geo, 0.76, 0.82);
  g.moveTo(p0x, p0y).lineTo(p1x, p1y).stroke({ width: 2.5, color: shade(C.metal, 0.7) });
  const tanks = Math.min(4, 1 + Math.floor((level + 1) / 2));
  const spots: [number, number][] = [[0.28, 0.34], [0.7, 0.38], [0.34, 0.78], [0.76, 0.82]];
  const tankH = 12 + level * 1.6;
  for (let i = 0; i < tanks; i += 1) {
    const [a, b] = spots[i] ?? spots[0]!;
    const [tx, ty] = at(geo, a, b);
    const r = hw * 0.16;
    shadow(g, tx, ty + 1, r * 1.15, hh * 0.16);
    cylinder(g, tx, ty, r, hh * 0.15, tankH, C.metal);
    g.rect(tx - r, ty - tankH * 0.55, r * 2, 1.4)
      .fill({ color: shade(C.metal, 1.5), alpha: 0.5 });
  }
  const [fx, fy] = at(geo, 0.9, 0.16);
  const flareH = 24 + level * 1.5;
  cylinder(g, fx, fy, hw * 0.04, hh * 0.04, flareH, C.rust);
  return {
    emitters: [{ x: fx, y: fy - flareH - 2, kind: 'flame', scale: 1 }],
    height: Math.max(flareH + 10, tankH + 6),
  };
}

/**
 * 물류센터: **급수탑**이 실루엣을 정한다(D-049).
 * 예전에는 박공 창고 한 채라 창고·병영과 구분되지 않았다.
 * 다리 위에 올라앉은 물탱크는 이 도시에서 유일한 형태라 멀리서도 갈린다.
 */
function supplyDepot(g: Graphics, geo: PlotGeometry, level: number): Built {
  const { hw, hh } = geo;
  // 낮고 긴 창고 한 채(반원 지붕)를 뒤에 깐다.
  const [sx, sy] = at(geo, 0.34, 0.5);
  const shedH = 7 + level * 0.9;
  shadow(g, sx, sy + 2, hw * 0.42, hh * 0.42);
  box(g, sx, sy, hw * 0.34, hh * 0.24, shedH, C.metal);
  barrel(g, sx, sy, hw * 0.34, hh * 0.24, shedH, 6, shade(C.metal, 1.15));

  // 급수탑 — 이 부지의 주인공.
  const [wx, wy] = at(geo, 0.78, 0.72);
  const legH = 14 + level * 1.6;
  const tankR = hw * 0.15;
  shadow(g, wx, wy + 1, tankR * 1.3, hh * 0.16);
  for (const [dx, dy] of [[-1, -1], [1, -1], [-1, 1], [1, 1]] as const) {
    g.rect(wx + dx * tankR * 0.62 - 0.9, wy + dy * hh * 0.05 - legH, 1.8, legH)
      .fill(shade(C.metal, dx < 0 ? 1.1 : 0.75));
  }
  // 탱크는 금속으로 둔다. 옆 부지(병영)가 캔버스 톤이라 같은 색이면 둘이 붙어 보인다(D-049).
  cylinder(g, wx, wy - legH, tankR, hh * 0.13, 9 + level * 0.5, shade(C.metal, 1.35));
  // 물탱크 꼭대기 원뿔 지붕
  g.poly([wx, wy - legH - 9 - level * 0.5 - 6, wx + tankR, wy - legH - 9 - level * 0.5,
    wx - tankR, wy - legH - 9 - level * 0.5]).fill(shade(C.roof, 1.2));

  const crates = Math.min(6, level);
  for (let i = 0; i < crates; i += 1) {
    const [bx, by] = at(geo, 0.12 + (i % 3) * 0.1, 0.9 - Math.floor(i / 3) * 0.1);
    box(g, bx, by, hw * 0.06, hh * 0.06, 5, C.wood);
  }
  return { emitters: [], height: legH + 9 + level * 0.5 + 6 };
}

function housing(g: Graphics, geo: PlotGeometry, level: number): Built {
  const { hw, hh } = geo;
  const houses = Math.min(6, Math.max(1, level));
  // 뒤에서 앞으로 그려야 앞집이 뒷집을 가린다.
  const spots: [number, number][] = [
    [0.3, 0.26], [0.68, 0.3], [0.3, 0.62], [0.68, 0.64], [0.5, 0.9], [0.88, 0.9],
  ];
  const height = 7 + Math.min(level, 6);
  const order = spots.slice(0, houses).sort((p, q) => (p[0] + p[1]) - (q[0] + q[1]));
  for (const [a, b] of order) {
    const [hx, hy] = at(geo, a, b);
    shadow(g, hx, hy + 1, hw * 0.2, hh * 0.2);
    box(g, hx, hy, hw * 0.15, hh * 0.15, height, C.concreteWarm);
    gable(g, hx, hy, hw * 0.15, hh * 0.15, height, 6, C.roofTile);
    g.rect(hx - hw * 0.08, hy + hh * 0.04 - height * 0.6, 2.6, 2.6)
      .fill({ color: C.window, alpha: 0.85 });
  }
  return { emitters: [], height: height + 6 + 4 };
}

/**
 * 창고: **길고 낮은 한 동에 지붕 채광 모니터**를 얹는다(D-049).
 * 물류센터(급수탑)·병영(퀀셋 줄)과 다른 축으로 눕혀 위에서 봤을 때 방향으로도 갈리게 한다.
 * 실루엣 요점은 "옆으로 긴 상자 + 지붕 위 작은 능선"이다.
 */
function warehouse(g: Graphics, geo: PlotGeometry, level: number): Built {
  const { hw, hh } = geo;
  const [wx, wy] = at(geo, 0.5, 0.52);
  const height = 8 + level * 1.1;
  // 증축 별동. 4레벨마다 한 채씩 뒤쪽에 붙어 부지가 넓어져 보인다(D-050).
  const annexes = Math.min(2, Math.floor(level / 4));
  for (let i = 0; i < annexes; i += 1) {
    const [nx, ny] = at(geo, 0.5, 0.14 - i * 0.12);
    shadow(g, nx, ny + 1, hw * 0.5, hh * 0.24);
    box(g, nx, ny, hw * 0.44, hh * 0.16, height * 0.7, shade(C.wood, 0.85));
    gable(g, nx, ny, hw * 0.44, hh * 0.16, height * 0.7, 4, C.roof);
  }
  shadow(g, wx, wy + 2, hw * 0.72, hh * 0.5);
  // 북서–남동으로 긴 동. 폭을 좁히고 길이를 늘려 다른 부지와 방향이 어긋나게 한다.
  box(g, wx, wy, hw * 0.62, hh * 0.3, height, C.wood);
  gable(g, wx, wy, hw * 0.62, hh * 0.3, height, 5, C.roof);
  // 지붕 채광 모니터 — 창고임을 알리는 작은 능선. 레벨이 오르면 길어진다.
  const monitor = 0.22 + Math.min(0.2, level * 0.022);
  box(g, wx, wy - height - 3, hw * monitor, hh * 0.14, 4, shade(C.wood, 1.2));
  g.rect(wx - hw * (monitor - 0.02), wy - height - 8, hw * (monitor * 2 - 0.04), 1.6)
    .fill({ color: C.window, alpha: 0.55 });

  // 남서 벽면의 큰 미닫이 문 두 짝.
  for (const offset of [-0.16, 0.06]) {
    const [dx, dy] = at(geo, 0.5 + offset, 0.98);
    g.rect(dx - hw * 0.08, dy - height * 0.75, hw * 0.16, height * 0.58)
      .fill(shade(C.wood, 0.42));
  }
  // 문 앞 야적 화물
  const crates = Math.min(4, Math.max(0, level - 1));
  for (let i = 0; i < crates; i += 1) {
    const [bx, by] = at(geo, 0.14 + i * 0.09, 0.16);
    box(g, bx, by, hw * 0.06, hh * 0.06, 6, C.rust);
  }
  return { emitters: [], height: height + 8 };
}

/**
 * 병영: **퀀셋 막사 줄과 연병장**(D-049).
 * 반원 지붕 여러 채가 나란한 모습은 이 도시에서 병영에만 있다.
 * 앞쪽 연병장을 비워 두고 깃대를 세워 "줄지어 선 막사 + 빈 마당"이라는 읽기를 만든다.
 */
function barracks(g: Graphics, geo: PlotGeometry, level: number): Built {
  const { hw, hh } = geo;
  // 지면(다져진 흙)은 패드가 깐다(D-051).
  // 새 도시는 전부 1레벨이다. 1레벨에서도 두 채가 서야 '줄'로 읽힌다(D-049).
  const blocks = Math.min(4, 2 + Math.floor(level / 3));
  const height = 5 + Math.min(level, 6);
  for (let i = 0; i < blocks; i += 1) {
    const b = 0.24 + (i / Math.max(1, blocks - 1)) * 0.54;
    const [bx, by] = at(geo, 0.66, b);
    shadow(g, bx, by + 1, hw * 0.3, hh * 0.12);
    box(g, bx, by, hw * 0.28, hh * 0.09, height, C.canvas);
    barrel(g, bx, by, hw * 0.28, hh * 0.09, height, 7, shade(C.canvas, 0.92));
  }
  // 연병장 깃대와 사열대
  const [fx, fy] = at(geo, 0.16, 0.5);
  const mast = 22;
  g.rect(fx - 0.9, fy - mast, 1.8, mast).fill(shade(C.metal, 1.2));
  box(g, fx, fy, hw * 0.09, hh * 0.09, 3, shade(C.concrete, 0.8));
  return {
    emitters: [{ x: fx, y: fy - mast, kind: 'flag', scale: 0.8 }],
    height: Math.max(height + 7, mast + 4),
  };
}

/**
 * 군수공장: 톱니 지붕 공장 동 **위를 가로지르는 문형 크레인**(D-049).
 * 톱니는 이 크기에서 거의 안 보였다. 지붕 위로 솟는 뼈대 하나가 제철소(굴뚝)와
 * 확실히 갈리는 실루엣을 만든다.
 */
function arsenal(g: Graphics, geo: PlotGeometry, level: number): Built {
  const { hw, hh } = geo;
  const [ax, ay] = at(geo, 0.55, 0.62);
  const height = 11 + level * 1.8;
  shadow(g, ax, ay + 2, hw * 0.66, hh * 0.66);
  box(g, ax, ay, hw * 0.5, hh * 0.5, height, C.metal);
  // 톱니 지붕 — 이제는 질감 역할만 한다.
  const teeth = Math.min(4, 2 + Math.floor(level / 3));
  for (let i = 0; i < teeth; i += 1) {
    const a = 0.22 + (i / teeth) * 0.6;
    const [tx, ty] = at(geo, a, 0.42);
    g.poly([
      tx - hw * 0.08, ty - height,
      tx + hw * 0.08, ty - height,
      tx + hw * 0.08, ty - height - 6,
    ]).fill(shade(C.roof, 1.3));
  }
  // 문형 크레인이 부지를 가로지른다.
  const [gax, gay] = at(geo, 0.1, 0.2);
  const [gbx, gby] = at(geo, 0.1, 0.95);
  gantry(g, gax, gay, gbx, gby, height + 12 + level, C.scaffold);
  // 야적된 포신
  for (let i = 0; i < Math.min(3, level); i += 1) {
    const [px, py] = at(geo, 0.3 + i * 0.16, 0.08);
    g.rect(px - hw * 0.1, py - 3, hw * 0.2, 2).fill(shade(C.rust, 1.15));
  }
  return { emitters: [], height: height + 12 + level };
}

/**
 * 비행장: 활주로·관제탑·격납고·기체(D-049).
 *
 * 예전에는 격납고 높이만 자라서 1레벨과 10레벨이 거의 같아 보였다(D-050).
 * 성장은 **개수와 넓이**로 보인다 — 관제탑이 층을 올리고, 격납고가 늘고, 기체가 늘어난다.
 */
function airfield(g: Graphics, geo: PlotGeometry, level: number): Built {
  const { hw, hh } = geo;
  // 지면(콘크리트)은 패드가 깐다(D-051). 활주로만 그 위에 얹는다.
  // 활주로. 레벨이 오르면 유도로 표시가 촘촘해진다.
  g.poly([
    ...at(geo, 0.08, 0.42), ...at(geo, 0.92, 0.42),
    ...at(geo, 0.92, 0.58), ...at(geo, 0.08, 0.58),
  ]).fill(shade(C.concrete, 0.75));
  const marks = 3 + Math.min(4, Math.floor(level / 2));
  for (let i = 0; i < marks; i += 1) {
    const [mx, my] = at(geo, 0.12 + (i / marks) * 0.76, 0.5);
    g.rect(mx - 3, my - 0.6, 6, 1.2).fill({ color: C.window, alpha: 0.55 });
  }

  // 관제탑 — 레벨에 따라 층이 오른다. 비행장의 세로 기준점이다.
  const [tx, ty] = at(geo, 0.12, 0.14);
  const towerH = 12 + level * 2.2;
  shadow(g, tx, ty + 1, hw * 0.14, hh * 0.14);
  box(g, tx, ty, hw * 0.1, hh * 0.1, towerH, C.concreteWarm);
  box(g, tx, ty - towerH, hw * 0.15, hh * 0.15, 5, shade(C.metal, 1.1));
  g.rect(tx - hw * 0.12, ty - towerH - 4, hw * 0.24, 2)
    .fill({ color: C.window, alpha: 0.85 });

  // 격납고. 4레벨마다 한 동씩 는다.
  const hangars = Math.min(3, 1 + Math.floor(level / 4));
  const hangar = 8 + level * 0.7;
  for (let i = 0; i < hangars; i += 1) {
    const [hx, hy] = at(geo, 0.3 + i * 0.3, 0.88);
    shadow(g, hx, hy + 1, hw * 0.28, hh * 0.28);
    box(g, hx, hy, hw * 0.22, hh * 0.2, hangar, C.metal);
    barrel(g, hx, hy, hw * 0.22, hh * 0.2, hangar, 7, shade(C.metal, 1.2));
  }

  // 계류된 기체. 레벨에 따라 늘어 활주로 옆이 채워진다.
  const planes = Math.min(5, Math.max(1, Math.floor((level + 1) / 2)));
  for (let i = 0; i < planes; i += 1) {
    const [px, py] = at(geo, 0.5 + (i % 2) * 0.3, 0.12 + Math.floor(i / 2) * 0.14);
    g.poly([px - 7, py - 4, px + 7, py - 4, px, py - 1]).fill(shade(C.metal, 1.3));
    g.rect(px - 1.2, py - 8, 2.4, 7).fill(shade(C.metal, 1.1));
  }
  return { emitters: [], height: Math.max(towerH + 9, hangar + 7) };
}

/**
 * 연구소: **관측 돔**이 실루엣을 정한다(D-049).
 * 예전 돔은 납작한 타원이라 지붕 장식으로만 보였다. 반구로 키우고 창을 넣어
 * 이 도시에서 유일한 곡면 지붕으로 만든다.
 */
function researchLab(g: Graphics, geo: PlotGeometry, level: number): Built {
  const { hw, hh } = geo;
  const [rx, ry] = at(geo, 0.42, 0.6);
  const height = 9 + level * 1.4;
  shadow(g, rx, ry + 2, hw * 0.56, hh * 0.56);
  box(g, rx, ry, hw * 0.4, hh * 0.4, height, C.concrete);
  // 창을 두 줄 넣어 연구동임을 알린다.
  for (let i = 0; i < 2; i += 1) {
    g.rect(rx - hw * 0.3, ry + hh * 0.1 - height + 4 + i * 5, hw * 0.24, 1.8)
      .fill({ color: C.window, alpha: 0.7 });
  }
  // 반구 돔. 띠를 쌓아 곡면을 만든다.
  const domeR = hw * 0.26 + level * 0.5;
  const domeH = domeR * 0.72;
  for (let i = 6; i >= 1; i -= 1) {
    const t = i / 6;
    const w = domeR * Math.sin(Math.acos(1 - t));
    g.ellipse(rx, ry - height - domeH * (1 - t), w, w * (hh / hw) * 0.9)
      .fill(shade(C.concreteWarm, 0.85 + (1 - t) * 0.5));
  }
  // 돔 관측 틈
  g.rect(rx - 1.2, ry - height - domeH, 2.4, domeH * 0.9)
    .fill({ color: shade(C.metal, 0.5), alpha: 0.9 });
  return { emitters: [], height: height + domeH + 4 };
}

/** 레이더: 접시 안테나가 실루엣을 정한다. 레벨에 따라 접시가 커진다. */
function radar(g: Graphics, geo: PlotGeometry, level: number): Built {
  const { hw, hh } = geo;
  const [bx, by] = at(geo, 0.55, 0.7);
  shadow(g, bx, by + 1, hw * 0.34, hh * 0.34);
  box(g, bx, by, hw * 0.24, hh * 0.24, 8, C.concrete);
  // 탑과 접시
  const [tx, ty] = at(geo, 0.45, 0.45);
  const mast = 16 + level * 2;
  g.rect(tx - 1.5, ty - mast, 3, mast).fill(shade(C.metal, 1.1));
  const dish = 6 + level * 0.9;
  g.ellipse(tx + dish * 0.3, ty - mast, dish * 0.55, dish)
    .fill(shade(C.metal, 1.3));
  g.ellipse(tx + dish * 0.45, ty - mast, dish * 0.3, dish * 0.7)
    .fill(shade(C.metal, 0.7));
  return { emitters: [], height: mast + dish + 4 };
}

/**
 * 방어사령부: 두꺼운 벙커와 총안. 효과가 없으므로 불빛을 넣지 않는다.
 *
 * 벙커는 높아지면 안 되는 건물이라 높이로 성장을 보일 수 없다(D-050).
 * 대신 **대공포와 보조 토치카가 는다** — 낮게 퍼지는 성장이다.
 */
function defenseHq(g: Graphics, geo: PlotGeometry, level: number): Built {
  const { hw, hh } = geo;
  // 토루를 먼저 깔아 벙커가 흙에 파묻힌 것처럼 보이게 한다.
  const [bx, by] = at(geo, 0.5, 0.6);
  diamond(g, bx, by + 3, hw * 0.66, hh * 0.66, shade(C.soil, 0.9), 0.55);

  // 보조 토치카. 4레벨마다 한 기씩 는다.
  const pillboxes = Math.min(3, Math.floor(level / 3));
  for (let i = 0; i < pillboxes; i += 1) {
    const [px, py] = at(geo, 0.12 + i * 0.12, 0.14 + i * 0.36);
    box(g, px, py, hw * 0.11, hh * 0.11, 5, shade(C.concrete, 0.7));
    g.rect(px - hw * 0.08, py - 3.5, hw * 0.16, 1.6).fill(shade(C.concrete, 0.3));
  }

  const height = 7 + level * 0.9;
  shadow(g, bx, by + 2, hw * 0.62, hh * 0.62);
  box(g, bx, by, hw * 0.46, hh * 0.46, height, shade(C.concrete, 0.85));
  // 낮고 넓은 상부 슬래브. 레벨에 따라 조금씩 넓어진다.
  const slab = 0.5 + Math.min(0.12, level * 0.014);
  box(g, bx, by - height, hw * slab, hh * slab, 4, shade(C.concrete, 0.7));
  // 총안
  for (let i = 0; i < 3; i += 1) {
    g.rect(bx - hw * 0.3 + i * hw * 0.22, by + hh * 0.16 - height * 0.5, hw * 0.12, 2)
      .fill(shade(C.concrete, 0.35));
  }

  // 상부 대공포. 3레벨부터 서고 레벨이 오르면 포신이 길어진다.
  let top = height + 4;
  if (level >= 3) {
    const gunY = by - height - 4;
    g.ellipse(bx, gunY, hw * 0.12, hh * 0.12).fill(shade(C.metal, 0.9));
    const barrel1 = 6 + level * 0.8;
    g.moveTo(bx, gunY - 2).lineTo(bx + barrel1 * 0.8, gunY - barrel1)
      .stroke({ width: 2, color: shade(C.metal, 1.3) });
    top = height + 4 + barrel1;
  }
  return { emitters: [], height: top };
}

/** 연맹 통신소: 안테나 마스트와 지선. 효과가 없으므로 신호 표시를 넣지 않는다. */
function allianceComms(g: Graphics, geo: PlotGeometry, level: number): Built {
  const { hw, hh } = geo;
  const [bx, by] = at(geo, 0.62, 0.72);
  shadow(g, bx, by + 1, hw * 0.28, hh * 0.28);
  box(g, bx, by, hw * 0.2, hh * 0.2, 7, C.concreteWarm);
  const [mx, my] = at(geo, 0.4, 0.42);
  const mast = 22 + level * 2.5;
  // 격자 마스트
  g.rect(mx - 2, my - mast, 4, mast).fill(shade(C.metal, 0.95));
  for (let i = 1; i <= 4; i += 1) {
    const y = my - (mast / 5) * i;
    g.moveTo(mx - 2, y).lineTo(mx + 2, y - 3)
      .stroke({ width: 0.8, color: shade(C.metal, 1.3), alpha: 0.8 });
  }
  // 지선
  for (const dx of [-1, 1]) {
    g.moveTo(mx, my - mast).lineTo(mx + dx * hw * 0.3, my)
      .stroke({ width: 0.7, color: shade(C.metal, 0.8), alpha: 0.6 });
  }
  return { emitters: [], height: mast + 4 };
}

const DRAW: Readonly<Record<BuildingId, (g: Graphics, geo: PlotGeometry, level: number) => Built>> = {
  hq,
  farm,
  steel_mill: steelMill,
  refinery,
  supply_depot: supplyDepot,
  housing,
  warehouse,
  barracks,
  arsenal,
  airfield,
  research_lab: researchLab,
  radar,
  defense_hq: defenseHq,
  alliance_comms: allianceComms,
};

/** 빈 부지. 레벨 0이거나 아직 스냅샷이 없을 때 그린다. */
function vacant(g: Graphics, geo: PlotGeometry): void {
  const { cx, cy, hw, hh } = geo;
  diamond(g, cx, cy, hw * 0.9, hh * 0.9, shade(C.soil, 0.8));
  for (let i = 0; i < 3; i += 1) {
    const [px, py] = at(geo, 0.3 + i * 0.2, 0.4 + (i % 2) * 0.25);
    g.circle(px, py - 2, 2.2).fill({ color: C.crop, alpha: 0.55 });
  }
}

export function drawBuilding(
  g: Graphics,
  id: BuildingId,
  geo: PlotGeometry,
  level: number,
): Built {
  if (level <= 0) {
    vacant(g, geo);
    return { emitters: [], height: 6 };
  }
  return DRAW[id](g, geo, Math.min(level, 10));
}

/**
 * 건설 중 표현. 완성 형태를 가리지 않고 비계와 크레인을 덧씌운다.
 * 크레인 지브는 fx 층에서 움직인다.
 */
export function drawConstruction(g: Graphics, geo: PlotGeometry): Built {
  const { hw } = geo;
  const corners: [number, number][] = [[0.12, 0.12], [0.88, 0.12], [0.12, 0.88], [0.88, 0.88]];
  for (const [a, b] of corners) {
    const [px, py] = at(geo, a, b);
    g.rect(px - 1, py - 26, 2, 26).fill(C.scaffold);
  }
  for (let i = 1; i <= 2; i += 1) {
    const y = -8 * i;
    const pts = corners.map(([a, b]) => {
      const [px, py] = at(geo, a, b);
      return [px, py + y] as [number, number];
    });
    g.moveTo(pts[0]![0], pts[0]![1]).lineTo(pts[1]![0], pts[1]![1])
      .lineTo(pts[3]![0], pts[3]![1]).lineTo(pts[2]![0], pts[2]![1]).closePath()
      .stroke({ width: 1.2, color: C.scaffold, alpha: 0.85 });
  }
  const [mx, my] = at(geo, 0.9, 0.1);
  const mastH = 40;
  g.rect(mx - 1.5, my - mastH, 3, mastH).fill(shade(C.accent, 0.75));
  return {
    emitters: [{ x: mx, y: my - mastH, kind: 'crane', scale: hw * 0.5 }],
    height: mastH + 6,
  };
}

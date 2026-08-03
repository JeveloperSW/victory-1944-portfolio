import { Application, Container, Graphics, Rectangle, Text, TextStyle } from 'pixi.js';
import { BUILDING_LABELS, type BuildingId, type OperationsSnapshot } from '../api/contract.js';
import {
  C,
  PLOT_GROUND,
  drawBuilding,
  drawConstruction,
  drawPad,
  type Emitter,
  type PlotGeometry,
} from './buildings.js';
import { shade } from './iso.js';
import { DISTRICTS, districtOf, type District, type DistrictId } from './districts.js';

/**
 * 아이소메트릭 도시 화면(D-025 렌더링 경로, 아트 방향은 D-037).
 * 서버 스냅샷의 건물 레벨과 진행 중 건설만 그린다 — 자체 계산은 없다.
 * 외부 이미지 에셋을 쓰지 않고 형태를 코드로 그린다.
 */

/**
 * 격자와 배치는 이제 **구역**이 정한다(D-052).
 * 예전에는 4×4 한 판에 14개를 몰아 넣어 공터 두 칸이 남았다.
 * 구역별로 건물 수에 딱 맞는 격자를 쓰므로 빈 칸이 생기지 않는다.
 */

interface Flash {
  x: number;
  y: number;
  age: number;
}

/**
 * 탭 판정용 사각 영역. 건물이 위로 솟으므로 바닥 칸만으로는 탑 꼭대기를 누를 수 없다.
 * 실루엣 높이까지 포함하고, 겹치면 앞(깊이가 큰) 부지가 이긴다.
 */
interface HitArea {
  readonly id: BuildingId;
  readonly depth: number;
  readonly left: number;
  readonly right: number;
  readonly top: number;
  readonly bottom: number;
}

export class CityScene {
  private readonly app = new Application();
  private readonly root = new Container();
  private readonly ground = new Graphics();
  private readonly city = new Graphics();
  private readonly fx = new Graphics();
  /** 레벨 배지(D-053). 건물 위·이름표 아래에 그린다. */
  private readonly badges = new Graphics();
  private readonly labels = new Container();
  private readonly labelText = new Map<BuildingId, Text>();

  private destroyed = false;
  private latest: OperationsSnapshot | null = null;
  private nowHour = 0;
  private time = 0;
  private emitters: Emitter[] = [];
  private flashes: Flash[] = [];
  private hitAreas: HitArea[] = [];
  private selected: BuildingId | null = null;
  private district: District = DISTRICTS[0]!;
  private readonly seenLevels = new Map<BuildingId, number>();

  /**
   * 부지를 탭했을 때 호출된다. 빈 곳을 눌러 선택이 풀리면 `null`로 호출한다 —
   * 알리지 않으면 화면이 이전 선택을 그대로 들고 있어 장면과 어긋난다.
   * 명령 실행은 호출자(화면)가 맡는다.
   */
  onSelect: ((id: BuildingId | null) => void) | null = null;

  /**
   * 장면을 PNG data URL로 뽑는다(D-047). **개발 빌드에서만 연결된다.**
   * 아트를 눈으로 확인하지 않고 고치면 결국 추측이 되므로, 화면을 파일로 꺼낼 창구가 필요하다.
   * `extract`는 렌더 텍스처에 다시 그리므로 `preserveDrawingBuffer` 없이도 동작한다.
   */
  async capture(): Promise<string> {
    // frame을 주지 않으면 스테이지 경계(화면 밖으로 뻗은 지면까지)를 잡아 실제 화면과 달라진다.
    return await this.app.renderer.extract.base64({
      target: this.app.stage,
      frame: new Rectangle(0, 0, this.app.screen.width, this.app.screen.height),
    });
  }

  async mount(host: HTMLElement): Promise<void> {
    await this.app.init({
      // 배경은 CSS의 --surface-sunken과 같아야 한다. 다르면 캔버스만 다른 앱처럼 보인다.
      background: 0x101712,
      antialias: true,
      resolution: Math.min(2, window.devicePixelRatio || 1),
      autoDensity: true,
      resizeTo: host,
    });
    if (this.destroyed) {
      this.app.destroy(true);
      return;
    }
    host.appendChild(this.app.canvas);
    this.app.stage.addChild(this.root);
    this.root.addChild(this.ground, this.city, this.fx, this.badges, this.labels);

    const style = new TextStyle({
      fill: 0xd8e4d2,
      fontSize: 10,
      fontWeight: '600',
      dropShadow: { color: 0x000000, blur: 3, distance: 1, alpha: 0.9, angle: Math.PI / 2 },
    });
    for (const plot of DISTRICTS.flatMap((district) => district.plots)) {
      const text = new Text({ text: BUILDING_LABELS[plot.id], style });
      text.anchor.set(0.5, 0);
      this.labels.addChild(text);
      this.labelText.set(plot.id, text);
    }

    this.app.renderer.on('resize', () => this.layout());
    this.app.ticker.add((ticker) => this.tick(ticker.deltaMS / 1000));
    this.app.canvas.addEventListener('click', (event) => this.handleClick(event));
    this.app.canvas.style.cursor = 'pointer';
    this.layout();
  }

  /** 화면 좌표를 장면 좌표로 옮겨 부지를 고른다. 빈 곳을 누르면 선택을 해제한다. */
  private handleClick(event: MouseEvent): void {
    if (this.destroyed) return;
    const rect = this.app.canvas.getBoundingClientRect();
    if (rect.width === 0 || rect.height === 0) return;
    const x = (event.clientX - rect.left) * (this.app.screen.width / rect.width);
    const y = (event.clientY - rect.top) * (this.app.screen.height / rect.height);
    let picked: BuildingId | null = null;
    let bestDepth = -1;
    for (const area of this.hitAreas) {
      if (x < area.left || x > area.right || y < area.top || y > area.bottom) continue;
      if (area.depth < bestDepth) continue;
      picked = area.id;
      bestDepth = area.depth;
    }
    this.selected = picked;
    this.layout();
    this.onSelect?.(picked);
  }

  /**
   * 보여줄 구역을 바꾼다(D-052).
   * 다른 구역의 부지를 고른 상태였다면 선택을 푼다 — 화면에 없는 것이 선택돼 있으면 안 된다.
   */
  setDistrict(id: DistrictId): void {
    const next = districtOf(id);
    if (next.id === this.district.id) return;
    this.district = next;
    if (this.selected !== null && !next.plots.some((plot) => plot.id === this.selected)) {
      this.selected = null;
      this.onSelect?.(null);
    }
    this.layout();
  }

  /** 화면이 선택 상태를 되돌릴 때 쓴다(탭 이동, 명령 완료 등). */
  setSelected(id: BuildingId | null): void {
    if (this.selected === id) return;
    this.selected = id;
    this.layout();
  }

  /** 서버 스냅샷과 권위 시각으로 화면을 갱신한다. */
  update(snapshot: OperationsSnapshot, nowHour: number): void {
    this.latest = snapshot;
    this.nowHour = nowHour;
    this.layout();
  }

  /**
   * 격자 좌표를 화면 좌표로 옮긴다.
   *
   * 화면 중앙에 맞추려면 격자의 **중점**을 빼야 한다(D-052).
   * `gx-gy`는 −(rows−1)..(cols−1), `gx+gy`는 0..(cols+rows−2) 범위라 정사각이 아닌 격자에서는
   * 중점이 0이 아니다. 예전처럼 원점만 화면 중앙에 두면 3×2 판이 오른쪽으로 밀린다.
   */
  private cellCenter(gx: number, gy: number, tileW: number, tileH: number): [number, number] {
    const { cols, rows } = this.district;
    // app.screen은 CSS 픽셀 기준 화면 사각형이다. renderer.width는 해상도 배율이 이미 반영되어
    // 있어 다시 나누면 절반이 된다(캡처 검증에서 도시가 1/4로 몰려 나온 원인).
    const originX = this.app.screen.width / 2 - ((cols - rows) / 2) * (tileW / 2);
    // 격자의 세로 중심을 화면 0.54 지점에 놓는다(D-047).
    const originY = this.app.screen.height * 0.54 - ((cols + rows - 2) / 2) * (tileH / 2);
    return [originX + (gx - gy) * (tileW / 2), originY + (gx + gy) * (tileH / 2)];
  }

  private layout(): void {
    if (this.destroyed || this.labelText.size === 0) return;
    const width = this.app.screen.width;
    const height = this.app.screen.height;
    /**
     * 판의 가로 폭은 `(cols + rows) × tileW / 2`다(등각 투영).
     * 예전에는 `cols`로만 나눠서 판이 화면 폭을 다 쓰지 못했다.
     * 세로도 함께 보고 둘 중 작은 쪽을 택해 판이 캔버스를 넘지 않게 한다.
     */
    const { cols, rows } = this.district;
    const byWidth = ((width - 24) * 2) / (cols + rows);
    const byHeight = ((height - 56) * 4) / (cols + rows);
    const tileW = Math.max(56, Math.min(140, byWidth, byHeight));
    const tileH = tileW * 0.5;

    this.ground.clear();
    this.city.clear();
    this.badges.clear();
    this.emitters = [];
    this.hitAreas = [];

    this.drawSky(width, height);
    this.drawPlatform(tileW, tileH);

    const pending = new Map<BuildingId, { targetLevel: number; completesAtHour: number }>();
    for (const job of this.latest?.jobs ?? []) {
      if (job.status !== 'pending') continue;
      pending.set(job.buildingId, {
        targetLevel: job.targetLevel,
        completesAtHour: job.completesAtHour,
      });
    }

    /**
     * 라벨은 14개 전부 만들어 두고 재사용한다. 지금 구역에 없는 것은 **반드시 숨긴다**(D-052) —
     * 숨기지 않으면 다른 구역의 이름표가 이전 위치에 남아 화면 구석에 겹쳐 쌓인다.
     */
    // 이 도시가 갖지 않는 건물은 부지도 그리지 않는다(규칙 버전이 낮으면 7종만 온다).
    const present = new Set(Object.keys(this.latest?.buildings ?? {}));
    const shown = new Set(
      this.district.plots
        .filter((plot) => this.latest === null || present.has(plot.id))
        .map((plot) => plot.id),
    );
    for (const [id, text] of this.labelText) text.visible = shown.has(id);

    // 뒤에서 앞으로 그린다(깊이 = gx + gy). 앞 건물이 뒤 건물을 자연스럽게 가린다.
    const ordered = [...this.district.plots]
      .filter((plot) => this.latest === null || present.has(plot.id))
      .sort((a, b) => (a.gx + a.gy) - (b.gx + b.gy));
    for (const plot of ordered) {
      const [cx, cy] = this.cellCenter(plot.gx, plot.gy, tileW, tileH);
      // 패드와 건물의 크기를 나눈다(D-048).
      // 패드는 작게(0.78) 잡아 사이에 자갈길이 보이게 하고, 건물은 크게(0.94) 잡아
      // 부지를 채우게 한다. 예전에는 같은 값이라 **길을 내면 건물이 같이 작아졌다.**
      // 건물이 패드 밖으로 조금 나가는 건 이 화풍에서 자연스럽고, 앞뒤 순서가 겹침을 정리한다.
      const geo: PlotGeometry = {
        cx, cy, hw: (tileW / 2) * 0.78, hh: (tileH / 2) * 0.78,
      };
      const buildingGeo: PlotGeometry = {
        cx, cy, hw: (tileW / 2) * 0.94, hh: (tileH / 2) * 0.94,
      };
      const job = pending.get(plot.id);
      const level = this.latest?.buildings[plot.id] ?? 0;
      this.noteLevel(plot.id, level, cx, cy);

      // 지면 성격은 건물이 정한다(D-051).
      drawPad(this.city, geo, job !== undefined, this.selected === plot.id, PLOT_GROUND[plot.id]);
      const built = drawBuilding(this.city, plot.id, buildingGeo, level);
      this.emitters.push(...built.emitters);
      let apex = built.height;
      if (job !== undefined) {
        const scaffold = drawConstruction(this.city, buildingGeo);
        this.emitters.push(...scaffold.emitters);
        apex = Math.max(apex, scaffold.height);
      }

      this.hitAreas.push({
        id: plot.id,
        depth: plot.gx + plot.gy,
        left: cx - buildingGeo.hw,
        right: cx + buildingGeo.hw,
        top: cy - apex,
        bottom: cy + geo.hh + 5,
      });

      const text = this.labelText.get(plot.id);
      if (text !== undefined) {
        // 부지가 여러 개라 이름을 항상 띄우면 라벨끼리 겹쳐 읽을 수 없다(D-043).
        // 평소에는 레벨 배지만, 고른 부지와 건설 중인 부지만 이름을 함께 보인다.
        const selected = this.selected === plot.id;
        const remaining = job === undefined ? 0 : Math.max(0, job.completesAtHour - this.nowHour);
        if (job !== undefined) {
          text.text = `${BUILDING_LABELS[plot.id]} ${level}→${job.targetLevel} · ${remaining}h`;
          text.style.fill = C.accent;
        } else if (selected) {
          text.text = `${BUILDING_LABELS[plot.id]} ${level}`;
          text.style.fill = C.accent;
        } else {
          /**
           * 레벨은 **배지**로 단다(D-053). 원작이 건물마다 방패 배지를 다는 이유가 있다 —
           * 맨 숫자는 배경에 묻히고, 밝게 하면 건물보다 먼저 읽힌다. 배지는 어느 쪽도 아니다.
           * 배지 도형은 아래 `drawLevelBadge`가 그리고, 여기서는 글자만 얹는다.
           */
          text.text = String(level);
          text.style.fill = 0xf2e3b8;
          this.drawLevelBadge(cx, cy - apex - 13, String(level));
        }
        // 라벨은 실루엣 위에 둔다. 부지 아래에 두면 앞줄 건물이 덮어버린다.
        text.position.set(cx, cy - apex - 13);
      }
    }
  }

  /**
   * 레벨 배지(D-053). 원작의 방패 배지를 지금 톤으로 옮긴 것이다.
   *
   * 원작은 초록 방패에 흰 숫자였다. 우리 화면은 바탕이 이미 올리브라 초록 배지가 묻히므로
   * **어두운 칩에 놋쇠 테두리**로 바꿨다. 모양이 아니라 대비가 배지를 읽히게 한다.
   */
  private drawLevelBadge(cx: number, cy: number, label: string): void {
    const w = 9 + label.length * 5;
    const h = 15;
    const x = cx - w / 2;
    const y = cy - 1;
    this.badges.roundRect(x + 1, y + 1.5, w, h, 4).fill({ color: 0x000000, alpha: 0.35 });
    this.badges.roundRect(x, y, w, h, 4).fill(0x1b2417);
    this.badges.roundRect(x, y, w, h, 4)
      .stroke({ width: 1, color: C.accentDeep ?? 0xa8853a, alpha: 0.95 });
  }

  /**
   * 배경판과 그 위의 옅은 빛(D-047).
   *
   * 배경을 렌더러 clear 색에만 맡기면 장면을 이미지로 뽑았을 때 투명으로 나와,
   * 확인용 캡처가 실제 화면과 달라진다. 배경을 장면 안에 그려 둘을 일치시킨다.
   */
  private drawSky(width: number, height: number): void {
    this.ground.rect(0, 0, width, height).fill(0x101712);
    for (let i = 3; i >= 1; i -= 1) {
      this.ground
        .ellipse(width / 2, height * 0.14, width * 0.42 * i, height * 0.22 * i)
        .fill({ color: 0x1d3324, alpha: 0.18 });
    }
  }

  /**
   * 도시 전체가 올라앉은 지반. 옆면을 두껍게 빼서 떠 있는 섬처럼 읽히게 한다.
   *
   * 상판은 자갈 포장이다(D-048). 예전에는 부지와 같은 초록이라 부지 사이 틈이
   * **그냥 빈 곳**으로 보였다. 자갈로 깔면 같은 틈이 부지를 잇는 **길**로 읽힌다 —
   * 도형을 더 그리지 않고 색만으로 구조를 만든다.
   */
  private drawPlatform(tileW: number, tileH: number): void {
    /**
     * 판은 격자의 네 모서리를 잇는 **평행사변형**이다(D-052).
     * 구역이 3×2·4×2로 정사각이 아니라 마름모 공식(`diamond`)을 쓸 수 없다 —
     * 쓰면 판이 격자와 어긋나 부지가 판 밖으로 삐져나온다.
     */
    const { cols, rows } = this.district;
    const north = this.cellCenter(-0.5, -0.5, tileW, tileH);
    const east = this.cellCenter(cols - 0.5, -0.5, tileW, tileH);
    const south = this.cellCenter(cols - 0.5, rows - 0.5, tileW, tileH);
    const west = this.cellCenter(-0.5, rows - 0.5, tileW, tileH);
    const lift = 14;
    // 앞쪽 두 변의 두께(흙 단면).
    this.ground.poly([...south, ...east, east[0], east[1] + lift, south[0], south[1] + lift])
      .fill(shade(0x2a2118, 0.7));
    this.ground.poly([...west, ...south, south[0], south[1] + lift, west[0], west[1] + lift])
      .fill(0x2a2118);
    this.ground.poly([...north, ...east, ...south, ...west]).fill(C.gravel);

    // 격자선을 따라 밝은 줄을 그어 길의 방향을 만든다.
    for (let i = 1; i < cols; i += 1) {
      const [ax, ay] = this.cellCenter(i - 0.5, -0.5, tileW, tileH);
      const [bx, by] = this.cellCenter(i - 0.5, rows - 0.5, tileW, tileH);
      this.ground.poly([ax, ay, bx, by])
        .stroke({ width: 1, color: C.gravelLine, alpha: 0.5 });
    }
    for (let i = 1; i < rows; i += 1) {
      const [px, py] = this.cellCenter(-0.5, i - 0.5, tileW, tileH);
      const [qx, qy] = this.cellCenter(cols - 0.5, i - 0.5, tileW, tileH);
      this.ground.poly([px, py, qx, qy])
        .stroke({ width: 1, color: C.gravelLine, alpha: 0.5 });
    }

    this.ground.poly([...north, ...east, ...south, ...west], true)
      .stroke({ width: 1, color: shade(C.gravel, 1.35), alpha: 0.5 });

    this.drawPerimeter([west, south], [south, east]);
  }

  /**
   * 외곽 방책(D-048). 판의 네 변을 따라 말뚝을 세우고 가로대를 건다.
   * 이게 없으면 건물 모음이 허공에서 끝나 **경계가 어디까지인지 읽히지 않는다.**
   * 앞쪽 두 변만 말뚝을 세운다 — 뒤쪽은 건물에 가려 보이지 않는데 그리면 실루엣만 지저분해진다.
   */
  private drawPerimeter(...edges: readonly [[number, number], [number, number]][]): void {
    const posts = 9;
    for (const [[ax, ay], [bx, by]] of edges) {
      for (let i = 0; i <= posts; i += 1) {
        const t = i / posts;
        const x = ax + (bx - ax) * t;
        const y = ay + (by - ay) * t;
        this.ground.rect(x - 1, y - 11, 2, 11).fill(shade(C.wood, 1.15));
      }
      // 가로대 두 줄. 말뚝 위쪽을 이어 울타리로 읽히게 한다.
      // 어두운 나무색으로는 자갈 위에서 보이지 않아 밝은 목재 톤을 쓴다.
      for (const lift of [9, 5]) {
        this.ground.poly([ax, ay - lift, bx, by - lift])
          .stroke({ width: 1.4, color: C.scaffold, alpha: 0.9 });
      }
    }
  }

  /**
   * 레벨이 오른 건물에 완료 파문을 남긴다.
   * 스냅샷이 없는 동안의 레벨 0은 기준으로 삼지 않는다 — 첫 스냅샷에서 전 건물이 터진다.
   */
  private noteLevel(id: BuildingId, level: number, cx: number, cy: number): void {
    if (this.latest === null) return;
    const previous = this.seenLevels.get(id);
    this.seenLevels.set(id, level);
    if (previous !== undefined && level > previous) {
      this.flashes.push({ x: cx, y: cy, age: 0 });
    }
  }

  private tick(deltaSeconds: number): void {
    if (this.destroyed) return;
    this.time += deltaSeconds;
    for (const flash of this.flashes) flash.age += deltaSeconds;
    this.flashes = this.flashes.filter((flash) => flash.age < 1.1);
    this.drawFx();
  }

  private drawFx(): void {
    this.fx.clear();
    for (const emitter of this.emitters) {
      if (emitter.kind === 'smoke') this.drawSmoke(emitter);
      else if (emitter.kind === 'flame') this.drawFlame(emitter);
      else if (emitter.kind === 'flag') this.drawFlag(emitter);
      else this.drawCrane(emitter);
    }
    for (const flash of this.flashes) {
      const t = flash.age / 1.1;
      const radius = 10 + t * 30;
      this.fx.ellipse(flash.x, flash.y, radius, radius * 0.5)
        .stroke({ width: 1.2, color: C.accent, alpha: (1 - t) * 0.45 });
    }
  }

  private drawSmoke(emitter: Emitter): void {
    const puffs = 5;
    for (let i = 0; i < puffs; i += 1) {
      const t = ((this.time * 0.22 * emitter.scale) + i / puffs) % 1;
      const x = emitter.x + Math.sin(t * 3.2 + i * 1.7) * 7 * t;
      const y = emitter.y - t * 42 * emitter.scale;
      this.fx.circle(x, y, 2.2 + t * 8 * emitter.scale)
        .fill({ color: 0x9aa79a, alpha: 0.32 * (1 - t) });
    }
  }

  private drawFlame(emitter: Emitter): void {
    const flicker = 0.7 + 0.3 * Math.sin(this.time * 9.3);
    this.fx.ellipse(emitter.x, emitter.y - 5 * flicker, 3.4, 7 * flicker)
      .fill({ color: C.ember, alpha: 0.85 });
    this.fx.ellipse(emitter.x, emitter.y - 3.5 * flicker, 1.8, 4 * flicker)
      .fill({ color: 0xffe6a0, alpha: 0.9 });
    for (let i = 0; i < 3; i += 1) {
      const t = ((this.time * 0.5) + i / 3) % 1;
      this.fx.circle(emitter.x + Math.sin(t * 5 + i) * 4, emitter.y - 8 - t * 26, 1.4 * (1 - t))
        .fill({ color: C.ember, alpha: 0.5 * (1 - t) });
    }
  }

  private drawFlag(emitter: Emitter): void {
    const sway = Math.sin(this.time * 2.4) * 2.6;
    this.fx.poly([
      emitter.x, emitter.y,
      emitter.x + 13, emitter.y + 3 + sway,
      emitter.x, emitter.y + 7,
    ]).fill({ color: C.accent, alpha: 0.9 });
  }

  private drawCrane(emitter: Emitter): void {
    const angle = Math.sin(this.time * 0.45) * 0.55;
    const tipX = emitter.x + Math.cos(angle) * emitter.scale;
    const tipY = emitter.y + Math.sin(angle) * emitter.scale * 0.4;
    this.fx.moveTo(emitter.x, emitter.y).lineTo(tipX, tipY)
      .stroke({ width: 2, color: shade(C.accent, 0.85) });
    const drop = 12 + Math.sin(this.time * 1.7) * 7;
    this.fx.moveTo(tipX, tipY).lineTo(tipX, tipY + drop)
      .stroke({ width: 1, color: C.accent, alpha: 0.7 });
    this.fx.rect(tipX - 2.5, tipY + drop, 5, 4).fill(shade(C.accent, 0.9));
  }

  destroy(): void {
    this.destroyed = true;
    this.labelText.clear();
    this.emitters = [];
    this.flashes = [];
    // Pixi 8은 init 전 destroy를 허용하지 않으므로 렌더러 생성 여부로 방어한다.
    try {
      this.app.destroy(true, { children: true });
    } catch {
      // 아직 init되지 않은 경우는 무시한다.
    }
  }
}

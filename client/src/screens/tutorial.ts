import type { OperationsSnapshot } from '../api/contract.js';

/**
 * 첫 루프 튜토리얼(D-040).
 *
 * 두 종류의 단계가 있다.
 * - `read`: 무엇을 하는 게임인지 설명한다. 화면을 덮고 "다음"으로 넘긴다.
 * - `act`: 실제로 해야 하는 조작이다. **화면을 덮지 않는다** — 덮으면 조작을 할 수 없다.
 *   서버 상태가 조건을 만족하면 스스로 다음으로 넘어간다(버튼으로 넘기지 않는다).
 *
 * 진행 상황은 기기에 저장한다. 서버에 보내지 않는다.
 */

/**
 * 진행 저장 키(v2).
 * v1은 "읽은 단계 개수"였는데, 단계를 중간에 끼워 넣으면 번호가 어긋나 엉뚱한 단계로 이어졌다.
 * v2는 **읽은 단계의 id 목록**을 저장하므로 순서가 바뀌어도 안전하다.
 */
const STORAGE_KEY = 'victory1944.tutorial.v2';
const LEGACY_KEY = 'victory1944.tutorial.v1';

export type TutorialTab = 'city' | 'operations' | 'reports';

interface TutorialStep {
  readonly id: string;
  readonly kind: 'read' | 'act';
  readonly title: string;
  readonly body: string;
  /** `act` 단계에서 이동시킬 탭. */
  readonly tab?: TutorialTab;
  /** `act` 단계의 완료 조건. 서버 상태만 본다. */
  readonly done?: (snapshot: OperationsSnapshot) => boolean;
}

const STEPS: readonly TutorialStep[] = [
  {
    id: 'intro',
    kind: 'read',
    title: '1944년, 전선의 도시 하나를 맡았습니다',
    body: '도시를 키워 자원을 모으고, 병력을 편성해 적 거점을 칩니다.'
      + ' 전투는 숫자만으로 결정되지 않습니다 — 무엇을 데려가느냐가 결과를 바꿉니다.',
  },
  {
    id: 'build',
    kind: 'act',
    title: '먼저 도시를 키웁니다',
    body: '작전 탭의 도시 건설에서 농장을 증설하십시오. 건설은 서버가 시간에 맞춰 끝냅니다.',
    tab: 'operations',
    done: (snapshot) => (snapshot.buildings.farm ?? 1) >= 2
      || snapshot.jobs.some((job) => job.status === 'pending'),
  },
  {
    id: 'mobilize',
    kind: 'act',
    title: '부대를 편성해 동원합니다',
    body: '작전 탭의 부대 편성에서 병종별 수량을 정하고 "편성대로 동원"을 누르십시오.'
      + ' 처음이라면 "추천 편성 채우기"가 지금 쓸 수 있는 병종으로 채워 줍니다.',
    tab: 'operations',
    done: (snapshot) => Object.values(snapshot.army.ready).some((count) => count > 0),
  },
  {
    id: 'unlocks',
    kind: 'read',
    title: '병종은 건물이 열어 줍니다',
    body: '전차는 군수공장, 항공기는 비행장, 대전차 수단은 병영과 군수공장이 열어 줍니다.'
      + ' 편성 화면에서 잠긴 병종은 필요한 건물과 레벨이 적혀 있습니다.'
      + ' 연구소를 지으면 작전 탭에 연구가 열려 병종 공격력과 정찰 정확도를 영구히 올립니다.'
      + ' 즉 어떤 적을 상대할 수 있는지는 도시를 어떻게 키웠는지가 정합니다.',
  },
  {
    id: 'why-recon',
    kind: 'read',
    title: '정찰이 이 게임의 핵심입니다',
    body: '적이 무엇으로 지키는지 모르면 편성을 고를 수 없습니다.'
      + ' 정찰은 적 규모를 범위로 알려주고, 정찰차량이 많을수록 그 범위가 좁아집니다.'
      + ' 목표 목록은 적 규모를 알려주지 않습니다 — 정찰만이 그 수단입니다.',
  },
  {
    id: 'recon',
    kind: 'act',
    title: '목표를 정찰하십시오',
    body: '작전 탭에서 목표를 고르고 정찰합니다. 보고서에는 만료 시간이 있습니다.',
    tab: 'operations',
    done: (snapshot) => snapshot.latestRecon !== null,
  },
  {
    id: 'attack',
    kind: 'act',
    title: '공격하십시오',
    body: '정찰 보고서가 유효한 동안에만 공격할 수 있습니다. 가용 병력이 전부 배치됩니다.',
    tab: 'operations',
    done: (snapshot) => snapshot.battleReports.length > 0,
  },
  {
    id: 'report',
    kind: 'read',
    title: '보고서가 다음 편성을 알려줍니다',
    body: '보고서 탭에서 라운드별 전개를 볼 수 있습니다.'
      + ' 상성 배수(×1.5 같은 표시)가 큰 조합이 피해를 많이 냈다는 뜻입니다.'
      + ' 다음 출격에는 그 병종을 늘리고, 작전 탭의 교리도 거기에 맞춰 바꾸십시오.',
  },
  {
    id: 'ladder',
    kind: 'read',
    title: '격파하면 다음 목표가 열립니다',
    body: '목표는 단계마다 다른 문제를 냅니다. 전차가 주력인 곳, 항공 전력이 있는 곳이 따로 있습니다.'
      + ' 같은 부대로 계속 밀 수 없으니 보고서를 보고 편성을 바꾸십시오.',
  },
];

export interface TutorialHandlers {
  readonly onTab: (tab: TutorialTab) => void;
}

export class Tutorial {
  private readonly host: HTMLElement;
  private readonly handlers: TutorialHandlers;
  /** 이미 읽은 단계 id. 행동 단계는 서버 상태로 판정하므로 여기에 담지 않는다. */
  private acknowledged: Set<string>;
  private finished: boolean;
  private latest: OperationsSnapshot | null = null;

  constructor(host: HTMLElement, handlers: TutorialHandlers) {
    this.host = host;
    this.handlers = handlers;
    const stored = localStorage.getItem(STORAGE_KEY);
    const legacy = localStorage.getItem(LEGACY_KEY);
    // v1에서 완료했다면 완료로 인정한다. 진행 중이었다면 단계가 바뀌었으므로 처음부터 본다.
    this.finished = stored === 'done' || legacy === 'done';
    this.acknowledged = new Set<string>();
    if (stored !== null && stored !== 'done') {
      try {
        const parsed: unknown = JSON.parse(stored);
        if (Array.isArray(parsed)) {
          for (const id of parsed) if (typeof id === 'string') this.acknowledged.add(id);
        }
      } catch {
        // 형식이 깨졌으면 처음부터 본다.
      }
    }
  }

  static isFinished(): boolean {
    return localStorage.getItem(STORAGE_KEY) === 'done'
      || localStorage.getItem(LEGACY_KEY) === 'done';
  }

  /** 설정에서 다시 보기. 진행 상황을 지우고 처음부터 시작한다. */
  restart(): void {
    localStorage.removeItem(STORAGE_KEY);
    localStorage.removeItem(LEGACY_KEY);
    this.finished = false;
    this.acknowledged = new Set<string>();
    this.render();
  }

  update(snapshot: OperationsSnapshot | null): void {
    this.latest = snapshot;
    this.render();
  }

  private currentIndex(): number {
    if (this.finished || this.latest === null) return -1;
    for (let index = 0; index < STEPS.length; index += 1) {
      const step = STEPS[index]!;
      if (step.kind === 'read') {
        if (!this.acknowledged.has(step.id)) return index;
        continue;
      }
      if (!step.done!(this.latest)) return index;
    }
    return -1;
  }

  private finish(): void {
    this.finished = true;
    localStorage.setItem(STORAGE_KEY, 'done');
    this.render();
  }

  private render(): void {
    this.host.replaceChildren();
    const index = this.currentIndex();
    if (index < 0) {
      this.host.hidden = true;
      return;
    }
    this.host.hidden = false;
    const step = STEPS[index]!;

    // 행동 단계는 배경을 덮지 않는다. 덮으면 시키는 조작을 할 수 없다.
    this.host.className = step.kind === 'read' ? 'tutorial-backdrop' : 'tutorial-backdrop pass';

    const card = document.createElement('div');
    card.className = 'tutorial-card';

    const marker = document.createElement('span');
    marker.className = 'tutorial-step';
    marker.textContent = `안내 ${index + 1}/${STEPS.length}`;

    const title = document.createElement('h3');
    title.className = 'tutorial-title';
    title.textContent = step.title;

    const body = document.createElement('p');
    body.className = 'tutorial-body';
    body.textContent = step.body;

    const actions = document.createElement('div');
    actions.className = 'tutorial-actions';

    if (step.kind === 'read') {
      const next = document.createElement('button');
      next.type = 'button';
      next.className = 'primary';
      next.textContent = index === STEPS.length - 1 ? '시작합니다' : '다음';
      next.addEventListener('click', () => {
        this.acknowledged.add(step.id);
        const allRead = STEPS.every(
          (candidate) => candidate.kind !== 'read' || this.acknowledged.has(candidate.id),
        );
        if (allRead && index === STEPS.length - 1) this.finish();
        else {
          localStorage.setItem(STORAGE_KEY, JSON.stringify([...this.acknowledged]));
          this.render();
        }
      });
      actions.append(next);
    } else if (step.tab !== undefined) {
      const go = document.createElement('button');
      go.type = 'button';
      go.className = 'primary';
      go.textContent = '작전 탭으로';
      go.addEventListener('click', () => this.handlers.onTab(step.tab!));
      actions.append(go);
    }

    const skip = document.createElement('button');
    skip.type = 'button';
    skip.className = 'ghost';
    skip.textContent = '건너뛰기';
    skip.addEventListener('click', () => this.finish());
    actions.append(skip);

    card.append(marker, title, body, actions);
    this.host.append(card);
  }
}

import type { BuildingId } from '../api/contract.js';

/**
 * 도시 구역(D-052).
 *
 * 원작처럼 **자원을 짓는 땅과 전략 건물을 짓는 땅을 나눈다.** 14개를 한 판에 몰아 넣으니
 * 4×4 격자에 공터 두 칸이 남았고, 무엇이 무엇인지 훑어 읽기 어려웠다.
 *
 * 이 구분은 **화면 구성이지 규칙이 아니다.** 서버는 구역을 모르며 건물 비용·게이트·해금은
 * 그대로다. 나중에 구역이 규칙에 영향을 주게 되면(예: 구역별 건설 슬롯)
 * 그때는 서버가 판정해야 하고 이 파일이 아니라 규칙 버전이 정해야 한다.
 *
 * 나누는 기준은 **자원 경제에 닿는가**다.
 * - 자원 지구: 생산(농장·제철소·정유소·물류센터)과 그 저장·인력(창고·주거지)
 * - 전략 지구: 군사·연구·통신
 *
 * 격자는 건물 수에 딱 맞춘다(3×2, 4×2). 그래야 공터가 생기지 않는다.
 * 배치 규칙은 D-043과 같다: **키 큰 건물을 뒷줄에 둔다.** 앞줄이 나중에 그려져 뒤를 덮으므로,
 * 굴뚝·마스트처럼 위로 솟는 것은 뒤에 두어야 가릴 것이 없다.
 */

export interface DistrictPlot {
  readonly id: BuildingId;
  readonly gx: number;
  readonly gy: number;
}

export interface District {
  readonly id: 'resource' | 'strategy';
  readonly nameKo: string;
  readonly hintKo: string;
  readonly cols: number;
  readonly rows: number;
  readonly plots: readonly DistrictPlot[];
}

export const DISTRICTS: readonly District[] = [
  {
    id: 'resource',
    nameKo: '자원 지구',
    hintKo: '생산과 저장을 맡는 구역입니다. 시간당 생산량이 여기서 나옵니다.',
    cols: 3,
    rows: 2,
    plots: [
      // 뒷줄: 굴뚝·플레어·급수탑처럼 위로 솟는 것들.
      { id: 'steel_mill', gx: 0, gy: 0 },
      { id: 'refinery', gx: 1, gy: 0 },
      { id: 'supply_depot', gx: 2, gy: 0 },
      // 앞줄: 낮은 것들.
      { id: 'farm', gx: 0, gy: 1 },
      { id: 'housing', gx: 1, gy: 1 },
      { id: 'warehouse', gx: 2, gy: 1 },
    ],
  },
  {
    id: 'strategy',
    nameKo: '전략 지구',
    hintKo: '군사·연구·통신 구역입니다. 병종 해금과 연구가 여기서 열립니다.',
    cols: 4,
    rows: 2,
    plots: [
      // 뒷줄: 사령부 탑, 레이더 접시, 통신 마스트, 연구 돔.
      { id: 'radar', gx: 0, gy: 0 },
      { id: 'hq', gx: 1, gy: 0 },
      { id: 'alliance_comms', gx: 2, gy: 0 },
      { id: 'research_lab', gx: 3, gy: 0 },
      // 앞줄: 막사·공장·활주로·벙커.
      { id: 'defense_hq', gx: 0, gy: 1 },
      { id: 'barracks', gx: 1, gy: 1 },
      { id: 'arsenal', gx: 2, gy: 1 },
      { id: 'airfield', gx: 3, gy: 1 },
    ],
  },
];

export type DistrictId = District['id'];

export function districtOf(id: DistrictId): District {
  return DISTRICTS.find((entry) => entry.id === id) ?? DISTRICTS[0]!;
}

/** 어떤 건물이 어느 구역에 있는지. 건물 목록을 구역별로 나눌 때 쓴다. */
export function districtIdOfBuilding(buildingId: BuildingId): DistrictId {
  for (const district of DISTRICTS) {
    if (district.plots.some((plot) => plot.id === buildingId)) return district.id;
  }
  return 'strategy';
}

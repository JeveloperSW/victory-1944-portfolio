import type { DoctrineDef, DoctrineId, Ruleset, UnitDef } from '../types.js';

/**
 * 규칙 v0.1.0 — 검증용 초안 밸런스.
 * 수치의 목적은 최종 밸런스가 아니라 GAME_DESIGN.md 11.2의 상성 관계를 재현하는 것이다.
 * 상성: 중전차>중형전차·보병, 대전차 화기>기갑, 포병>밀집 지상, 전투기>폭격기,
 * 폭격기>포병·시설, 대공포>항공, 정찰은 전투력 대신 선제권·정보.
 */

const UNIT_LIST: UnitDef[] = [
  {
    id: 'rifle', defaultRow: 'front', nameKo: '소총병', domain: 'ground', tags: ['infantry'],
    cost: 10, hp: 30, attack: 6, airAttack: 0, reach: 1, reconValue: 0, counters: {},
  },
  {
    id: 'at_infantry', defaultRow: 'front', nameKo: '대전차보병', domain: 'ground', tags: ['infantry', 'at'],
    cost: 15, hp: 28, attack: 5, airAttack: 0, reach: 1, reconValue: 0,
    counters: { armor_medium: 3.0, armor_heavy: 2.6 },
  },
  {
    id: 'scout', defaultRow: 'mid', nameKo: '정찰차량', domain: 'ground', tags: ['recon'],
    cost: 20, hp: 25, attack: 4, airAttack: 0, reach: 1, reconValue: 10, counters: {},
  },
  {
    id: 'medium_tank', defaultRow: 'front', nameKo: '중형전차', domain: 'ground', tags: ['armor_medium'],
    cost: 45, hp: 90, attack: 18, airAttack: 0, reach: 1, reconValue: 0,
    counters: { infantry: 1.3 },
  },
  {
    id: 'heavy_tank', defaultRow: 'front', nameKo: '중전차', domain: 'ground', tags: ['armor_heavy'],
    cost: 80, hp: 160, attack: 26, airAttack: 0, reach: 1, reconValue: 0,
    counters: { armor_medium: 1.5, infantry: 1.4 },
  },
  {
    id: 'howitzer', defaultRow: 'back', nameKo: '야포', domain: 'ground', tags: ['artillery'],
    cost: 50, hp: 35, attack: 20, airAttack: 0, reach: 3, reconValue: 0,
    counters: { infantry: 1.5 }, area: true,
  },
  {
    id: 'at_gun', defaultRow: 'mid', nameKo: '대전차포', domain: 'ground', tags: ['at'],
    cost: 40, hp: 40, attack: 12, airAttack: 0, reach: 2, reconValue: 0,
    counters: { armor_medium: 3.0, armor_heavy: 3.0 },
  },
  {
    id: 'aa_gun', defaultRow: 'mid', nameKo: '대공포', domain: 'ground', tags: ['aa'],
    cost: 35, hp: 40, attack: 5, airAttack: 22, reach: 1, reconValue: 0,
    counters: { air_bomber: 1.6, air_fighter: 1.2 },
  },
  {
    id: 'fighter', defaultRow: 'back', nameKo: '전투기', domain: 'air', tags: ['air_fighter'],
    cost: 60, hp: 70, attack: 6, airAttack: 16, reach: 3, reconValue: 4,
    counters: { air_bomber: 2.5 },
  },
  {
    id: 'bomber', defaultRow: 'back', nameKo: '폭격기', domain: 'air', tags: ['air_bomber'],
    cost: 90, hp: 100, attack: 30, airAttack: 0, reach: 3, reconValue: 0,
    counters: { artillery: 1.8, at: 1.3 },
  },
  {
    id: 'engineer', defaultRow: 'front', nameKo: '공병', domain: 'ground', tags: ['support'],
    cost: 25, hp: 30, attack: 3, airAttack: 0, reach: 1, reconValue: 0, counters: {},
  },
  {
    id: 'supply_truck', defaultRow: 'mid', nameKo: '수송대', domain: 'ground', tags: ['support'],
    cost: 20, hp: 25, attack: 0, airAttack: 0, reach: 1, reconValue: 0,
    counters: {}, supplyValue: 0.01,
  },
];

const DOCTRINES: Record<DoctrineId, DoctrineDef> = {
  none: { id: 'none', nameKo: '기본 교리' },
  armor_breakthrough: {
    id: 'armor_breakthrough', nameKo: '기갑 돌파 교리',
    attackMult: { armor_medium: 1.15, armor_heavy: 1.15 },
    incomingFromTag: { at: 1.1 },
  },
  artillery_support: {
    id: 'artillery_support', nameKo: '포병 지원 교리',
    attackMult: { artillery: 1.2 },
  },
  air_superiority: {
    id: 'air_superiority', nameKo: '공중 우세 교리',
    attackMult: { air_fighter: 1.15, air_bomber: 1.05 },
  },
  defense: {
    id: 'defense', nameKo: '방어전 교리',
    attackMultAll: 0.95, incomingMultAll: 0.9,
  },
  logistics: {
    id: 'logistics', nameKo: '물류·생산 교리',
    supplyBonus: 0.1,
  },
  recon_mobility: {
    id: 'recon_mobility', nameKo: '정찰·기동 교리',
    reconBonus: 20, attackMult: { recon: 1.5 },
  },
};

export const RULESET_V0_1_0: Ruleset = {
  version: '0.1.0',
  units: Object.fromEntries(UNIT_LIST.map((u) => [u.id, u])),
  doctrines: DOCTRINES,
  balance: {
    maxRounds: 30,
    varianceMin: 0.95,
    varianceSpan: 0.1,
    woundedRatio: 0.6,
    supplyFloor: 0.7,
    infoAdvantageGap: 25,
    initiativeBonus: 0.1,
    intelWeight: 0.5,
    reconAccuracyWeight: 50,
    commandWeight: 0.002,
    tacticsWeight: 0.002,
    logisticsWeight: 0.001,
    denseRowUnits: 40,
    denseBonus: 1.25,
    supplyUnitCap: 0.1,
    maxStackCount: 100000,
    maxStacks: 24,
  },
};

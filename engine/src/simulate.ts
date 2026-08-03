import type {
  ArmySnapshot,
  AttackEvent,
  BattleInput,
  BattleOutcome,
  BattleResult,
  BalanceConfig,
  CounterReport,
  DoctrineDef,
  OutcomeReason,
  Row,
  Ruleset,
  Side,
  SideReport,
  StackReport,
  UnitDef,
  UnitTag,
} from './types.js';
import { mulberry32, type Rng } from './rng.js';
import { fnv1a64, stableStringify } from './hash.js';
import { validateInput } from './validate.js';

const ROW_ORDER: Row[] = ['front', 'mid', 'back'];

interface StackState {
  def: UnitDef;
  row: Row;
  initial: number;
  pool: number;
  reserveRound: number;
  damageDealt: number;
  damageTaken: number;
}

interface SideState {
  side: Side;
  army: ArmySnapshot;
  stacks: StackState[];
  initialPool: number;
  effSupply: number;
  attackMult: number;
  incomingAll: number;
  doctrine: DoctrineDef;
  reconScore: number;
  infoAdvantage: boolean;
  hasInitiative: boolean;
  tacticsBoost: number;
  totalCost: number;
}

function aliveCount(stack: StackState): number {
  if (stack.pool <= 0) return 0;
  return Math.min(stack.initial, Math.ceil(stack.pool / stack.def.hp));
}

function isFielded(stack: StackState, round: number): boolean {
  return stack.pool > 0 && round >= stack.reserveRound;
}

function totalPool(side: SideState): number {
  let sum = 0;
  for (const stack of side.stacks) sum += Math.max(0, stack.pool);
  return sum;
}

/**
 * 교리와 추가 보정(연구 등)을 곱한 공격 배수.
 * `extra`가 없으면 교리만 적용되므로 보정 도입 전 입력과 결과가 완전히 같다.
 */
function doctrineAttackMult(
  doctrine: DoctrineDef,
  def: UnitDef,
  extra?: Partial<Record<UnitTag, number>>,
): number {
  let mult = doctrine.attackMultAll ?? 1;
  if (doctrine.attackMult) {
    for (const tag of def.tags) {
      const m = doctrine.attackMult[tag];
      if (m !== undefined) mult *= m;
    }
  }
  if (extra) {
    for (const tag of def.tags) {
      const m = extra[tag];
      if (m !== undefined) mult *= m;
    }
  }
  return mult;
}

function incomingMult(defender: SideState, attackerDef: UnitDef): number {
  let mult = defender.incomingAll;
  const table = defender.doctrine.incomingFromTag;
  if (table) {
    for (const tag of attackerDef.tags) {
      const m = table[tag];
      if (m !== undefined) mult *= m;
    }
  }
  return mult;
}

/** 공격자 병종의 상성 배수: 목표 태그와 일치하는 배수 중 최댓값(기본 1). */
function counterMultFor(def: UnitDef, target: UnitDef): number {
  let best = 1;
  for (const tag of target.tags) {
    const m = def.counters[tag];
    if (m !== undefined && m > best) best = m;
  }
  return best;
}

function boostedCounter(base: number, side: SideState): number {
  if (base <= 1) return base;
  return 1 + (base - 1) * side.tacticsBoost;
}

function weightedPick(candidates: StackState[], rng: Rng): StackState {
  let total = 0;
  for (const c of candidates) total += aliveCount(c);
  let roll = rng() * total;
  for (const c of candidates) {
    roll -= aliveCount(c);
    if (roll <= 0) return c;
  }
  return candidates[candidates.length - 1]!;
}

/** 정보 우위 시: 상성 배수 최대 → 병력 수 최대 → 입력 순서로 결정론적 선택. */
function informedPick(candidates: StackState[], firing: UnitDef): StackState {
  let best = candidates[0]!;
  let bestMult = counterMultFor(firing, best.def);
  let bestAlive = aliveCount(best);
  for (const c of candidates.slice(1)) {
    const mult = counterMultFor(firing, c.def);
    const alive = aliveCount(c);
    if (mult > bestMult || (mult === bestMult && alive > bestAlive)) {
      best = c;
      bestMult = mult;
      bestAlive = alive;
    }
  }
  return best;
}

function pickTarget(candidates: StackState[], firing: UnitDef, info: boolean, rng: Rng): StackState {
  if (candidates.length === 1) return candidates[0]!;
  return info ? informedPick(candidates, firing) : weightedPick(candidates, rng);
}

/** 사거리 안의 적 지상 열 목록(가까운 열부터). */
function reachableRows(enemy: SideState, round: number, reach: number): Row[] {
  const nonEmpty = ROW_ORDER.filter((row) =>
    enemy.stacks.some((s) => s.row === row && s.def.domain === 'ground' && isFielded(s, round)),
  );
  return nonEmpty.slice(0, Math.max(1, reach));
}

function groundCandidates(enemy: SideState, round: number, rows: Row[]): StackState[] {
  return enemy.stacks.filter(
    (s) => s.def.domain === 'ground' && isFielded(s, round) && rows.includes(s.row),
  );
}

function airCandidates(enemy: SideState, round: number, tag: 'air_fighter' | 'air_bomber'): StackState[] {
  return enemy.stacks.filter(
    (s) => s.def.domain === 'air' && isFielded(s, round) && s.def.tags.includes(tag),
  );
}

interface FireContext {
  balance: BalanceConfig;
  rng: Rng;
  events: AttackEvent[];
  round: number;
}

function applyHit(
  me: SideState,
  enemy: SideState,
  stack: StackState,
  target: StackState,
  baseDamage: number,
  rawCounter: number,
  ctx: FireContext,
): void {
  const counter = boostedCounter(rawCounter, me);
  const damage = baseDamage * counter * incomingMult(enemy, stack.def);
  target.pool -= damage;
  // 부동소수점 잔여치로 전멸한 스택이 1기 생존으로 부활하는 것을 방지한다.
  if (target.pool > 0 && target.pool < 1e-6) target.pool = 0;
  target.damageTaken += damage;
  stack.damageDealt += damage;
  ctx.events.push({
    round: ctx.round,
    side: me.side,
    unitId: stack.def.id,
    targetUnitId: target.def.id,
    damage: Math.round(damage * 100) / 100,
    counterMult: Math.round(counter * 1000) / 1000,
  });
}

/** 최대 스택 수(24)보다 커야 대규모 섬멸에서 이월이 조기 중단되지 않는다. */
const SPILL_GUARD = 32;

/**
 * 직사 사격: 목표를 전멸시키고 화력이 남으면 다음 사거리 내 목표로 이월한다.
 * 얇은 최전열 스택으로 한 라운드 화력 전체를 흡수하는 악용을 막는다.
 * budget은 상성·피격 보정 적용 전의 기본 피해량이다.
 */
function directFire(
  me: SideState,
  enemy: SideState,
  stack: StackState,
  budget: number,
  candidatesOf: () => StackState[],
  ctx: FireContext,
): void {
  let remaining = budget;
  const inMult = incomingMult(enemy, stack.def);
  for (let guard = 0; guard < SPILL_GUARD && remaining > 0.01; guard += 1) {
    const candidates = candidatesOf();
    if (candidates.length === 0) return;
    const target = pickTarget(candidates, stack.def, me.infoAdvantage, ctx.rng);
    const counter = boostedCounter(counterMultFor(stack.def, target.def), me);
    const effective = remaining * counter * inMult;
    const pool = Math.max(0, target.pool);
    if (effective < pool || counter * inMult <= 0) {
      applyHit(me, enemy, stack, target, remaining, counterMultFor(stack.def, target.def), ctx);
      return;
    }
    const consumed = pool / (counter * inMult);
    applyHit(me, enemy, stack, target, consumed, counterMultFor(stack.def, target.def), ctx);
    remaining -= consumed;
  }
}

/**
 * 한 스택의 라운드 사격. 전투는 동시 해결이므로 사격 강도는 라운드 시작 시점 병력(aliveAtStart)을 쓴다
 * — 이번 라운드에 격파당해도 반격은 이뤄진다. 선제권은 사격 순서가 아니라 피해 보너스로 반영한다.
 */
function fireStack(me: SideState, enemy: SideState, stack: StackState, aliveAtStart: number, ctx: FireContext): void {
  const alive = aliveAtStart;
  if (alive <= 0) return;
  const def = stack.def;
  const variance = ctx.balance.varianceMin + ctx.rng() * ctx.balance.varianceSpan;
  const initiativeMult = me.hasInitiative ? 1 + ctx.balance.initiativeBonus : 1;
  const baseMult = me.attackMult
    * doctrineAttackMult(me.doctrine, def, me.army.attackMultByTag)
    * variance * initiativeMult;

  const groundTargets = () => groundCandidates(enemy, ctx.round, reachableRows(enemy, ctx.round, def.reach));

  // 1) 공중 유닛
  if (def.domain === 'air') {
    if (def.airAttack > 0) {
      // 전투기: 적 전투기 우선(호위 개념), 없으면 폭격기, 그마저 없으면 지상 기총소사
      const airTargets = () => {
        const fighters = airCandidates(enemy, ctx.round, 'air_fighter');
        return fighters.length > 0 ? fighters : airCandidates(enemy, ctx.round, 'air_bomber');
      };
      if (airTargets().length > 0) {
        directFire(me, enemy, stack, def.airAttack * alive * baseMult, airTargets, ctx);
        return;
      }
    }
    if (def.attack > 0 && groundTargets().length > 0) {
      directFire(me, enemy, stack, def.attack * alive * baseMult, groundTargets, ctx);
    }
    return;
  }

  // 2) 대공 사격: 공중 공격이 가능한 지상 유닛은 적기가 있으면 대공 우선(폭격기 우선 요격)
  if (def.airAttack > 0) {
    const aaTargets = () => {
      const bombers = airCandidates(enemy, ctx.round, 'air_bomber');
      return bombers.length > 0 ? bombers : airCandidates(enemy, ctx.round, 'air_fighter');
    };
    if (aaTargets().length > 0) {
      directFire(me, enemy, stack, def.airAttack * alive * baseMult, aaTargets, ctx);
      return;
    }
  }

  // 3) 지상 사격
  if (def.attack <= 0) return;
  const rows = reachableRows(enemy, ctx.round, def.reach);
  const candidates = groundCandidates(enemy, ctx.round, rows);
  if (candidates.length === 0) return;

  if (def.area) {
    // 포병: 열 단위 광역 사격. 정보 우위면 상성 목표가 있는 열, 아니면 병력이 가장 많은 열.
    let targetRow: Row;
    if (me.infoAdvantage) {
      targetRow = informedPick(candidates, def).row;
    } else {
      let bestRow = rows[0]!;
      let bestUnits = -1;
      for (const row of rows) {
        let units = 0;
        for (const c of candidates) if (c.row === row) units += aliveCount(c);
        if (units > bestUnits) {
          bestRow = row;
          bestUnits = units;
        }
      }
      targetRow = bestRow;
    }
    const rowStacks = candidates.filter((c) => c.row === targetRow);
    let rowAlive = 0;
    for (const c of rowStacks) rowAlive += aliveCount(c);
    if (rowAlive <= 0) return;
    const dense = rowAlive >= ctx.balance.denseRowUnits ? ctx.balance.denseBonus : 1;
    const base = def.attack * alive * baseMult * dense;
    for (const target of rowStacks) {
      const share = base * (aliveCount(target) / rowAlive);
      if (share <= 0) continue;
      applyHit(me, enemy, stack, target, share, counterMultFor(def, target.def), ctx);
    }
    return;
  }

  directFire(me, enemy, stack, def.attack * alive * baseMult, groundTargets, ctx);
}

function buildSide(side: Side, army: ArmySnapshot, rules: Ruleset): SideState {
  const { balance } = rules;
  const doctrine = rules.doctrines[army.doctrine]!;
  const officer = army.officer;

  const stacks: StackState[] = army.stacks.map((order) => {
    const def = rules.units[order.unitId]!;
    return {
      def,
      row: order.row,
      initial: order.count,
      pool: order.count * def.hp,
      reserveRound: order.reserveRound ?? 1,
      damageDealt: 0,
      damageTaken: 0,
    };
  });

  let supplyFromUnits = 0;
  let totalCost = 0;
  for (const stack of stacks) {
    totalCost += stack.def.cost * stack.initial;
    if (stack.def.supplyValue) supplyFromUnits += stack.def.supplyValue * stack.initial;
  }
  supplyFromUnits = Math.min(balance.supplyUnitCap, supplyFromUnits);

  const effSupply = Math.min(
    1,
    army.supply + supplyFromUnits + (doctrine.supplyBonus ?? 0) + (officer ? officer.logistics * balance.logisticsWeight : 0),
  );
  const supplyMult = balance.supplyFloor + (1 - balance.supplyFloor) * effSupply;
  const commandMult = 1 + (officer ? officer.command * balance.commandWeight : 0);

  let reconScore = (doctrine.reconBonus ?? 0) + army.reconAccuracy * balance.reconAccuracyWeight;
  if (officer) reconScore += officer.intel * balance.intelWeight;
  for (const stack of stacks) {
    if (stack.reserveRound === 1) reconScore += stack.def.reconValue * stack.initial;
  }

  let initialPool = 0;
  for (const stack of stacks) initialPool += stack.pool;

  return {
    side,
    army,
    stacks,
    initialPool,
    effSupply,
    attackMult: commandMult * supplyMult,
    incomingAll: doctrine.incomingMultAll ?? 1,
    doctrine,
    reconScore,
    infoAdvantage: false,
    hasInitiative: false,
    tacticsBoost: 1 + (officer ? officer.tactics * balance.tacticsWeight : 0),
    totalCost,
  };
}

function buildStackReports(side: SideState, woundedRatio: number): StackReport[] {
  return side.stacks.map((stack) => {
    const survivors = aliveCount(stack);
    const losses = stack.initial - survivors;
    const wounded = Math.round(losses * woundedRatio);
    return {
      unitId: stack.def.id,
      nameKo: stack.def.nameKo,
      row: stack.row,
      initial: stack.initial,
      survivors,
      dead: losses - wounded,
      wounded,
      damageDealt: Math.round(stack.damageDealt * 10) / 10,
      damageTaken: Math.round(stack.damageTaken * 10) / 10,
    };
  });
}

function buildSideReport(side: SideState, woundedRatio: number): SideReport {
  const remaining = totalPool(side);
  return {
    stacks: buildStackReports(side, woundedRatio),
    reconScore: Math.round(side.reconScore * 10) / 10,
    infoAdvantage: side.infoAdvantage,
    effectiveSupply: Math.round(side.effSupply * 1000) / 1000,
    attackMultiplier: Math.round(side.attackMult * 1000) / 1000,
    remainingRatio: side.initialPool > 0 ? Math.round((remaining / side.initialPool) * 1000) / 1000 : 0,
    totalCost: side.totalCost,
  };
}

function buildCounterReports(events: AttackEvent[]): CounterReport[] {
  const map = new Map<string, CounterReport>();
  for (const event of events) {
    if (event.counterMult <= 1.001) continue;
    const key = `${event.side}|${event.unitId}|${event.targetUnitId}`;
    const existing = map.get(key);
    if (existing) {
      existing.totalDamage += event.damage;
      if (event.counterMult > existing.multiplier) existing.multiplier = event.counterMult;
    } else {
      map.set(key, {
        side: event.side,
        unitId: event.unitId,
        targetUnitId: event.targetUnitId,
        multiplier: event.counterMult,
        totalDamage: event.damage,
      });
    }
  }
  const list = [...map.values()];
  for (const item of list) item.totalDamage = Math.round(item.totalDamage * 10) / 10;
  // localeCompare는 실행 환경 로케일에 따라 달라질 수 있으므로 코드 유닛 비교를 쓴다(결정론).
  list.sort((a, b) => b.totalDamage - a.totalDamage || (a.unitId < b.unitId ? -1 : a.unitId > b.unitId ? 1 : 0));
  return list;
}

/**
 * 결정론적 전투 시뮬레이션.
 * 외부 시간·DB·네트워크에 의존하지 않으며, 같은 입력(규칙 버전·시드 포함)은 항상 같은 결과와 해시를 만든다.
 */
export function simulateBattle(input: BattleInput): BattleResult {
  const rules = validateInput(input);
  const { balance } = rules;
  const rng = mulberry32(input.seed);

  const attacker = buildSide('attacker', input.attacker, rules);
  const defender = buildSide('defender', input.defender, rules);

  const gap = attacker.reconScore - defender.reconScore;
  const initiative: Side | null = gap > 0 ? 'attacker' : gap < 0 ? 'defender' : null;
  attacker.infoAdvantage = gap >= balance.infoAdvantageGap;
  defender.infoAdvantage = -gap >= balance.infoAdvantageGap;
  attacker.hasInitiative = initiative === 'attacker';
  defender.hasInitiative = initiative === 'defender';

  const order: SideState[] = initiative === 'defender' ? [defender, attacker] : [attacker, defender];
  const events: AttackEvent[] = [];

  let outcome: BattleOutcome = 'draw';
  let reason: OutcomeReason = 'timeout';
  let rounds = 0;

  for (let round = 1; round <= balance.maxRounds; round += 1) {
    rounds = round;
    const ctx: FireContext = { balance, rng, events, round };

    // 동시 해결: 양측 모두 라운드 시작 시점 병력으로 사격한다.
    const aliveAtStart = new Map<StackState, number>();
    for (const side of order) {
      for (const stack of side.stacks) {
        aliveAtStart.set(stack, isFielded(stack, round) ? aliveCount(stack) : 0);
      }
    }

    for (const me of order) {
      const enemy = me === attacker ? defender : attacker;
      for (const stack of me.stacks) {
        fireStack(me, enemy, stack, aliveAtStart.get(stack) ?? 0, ctx);
      }
    }

    const attackerPool = totalPool(attacker);
    const defenderPool = totalPool(defender);
    if (attackerPool <= 0 && defenderPool <= 0) {
      outcome = 'draw';
      reason = 'annihilation';
      break;
    }
    if (defenderPool <= 0) {
      outcome = 'attacker_win';
      reason = 'annihilation';
      break;
    }
    if (attackerPool <= 0) {
      outcome = 'defender_win';
      reason = 'annihilation';
      break;
    }

    const attackerRatio = attackerPool / attacker.initialPool;
    const defenderRatio = defenderPool / defender.initialPool;
    const attackerRetreats = attackerRatio < input.attacker.retreatThreshold;
    const defenderRetreats = defenderRatio < input.defender.retreatThreshold;
    if (attackerRetreats && defenderRetreats) {
      outcome = 'draw';
      reason = 'mutual_retreat';
      break;
    }
    if (attackerRetreats) {
      outcome = 'defender_win';
      reason = 'retreat';
      break;
    }
    if (defenderRetreats) {
      outcome = 'attacker_win';
      reason = 'retreat';
      break;
    }
  }

  const attackerReport = buildSideReport(attacker, balance.woundedRatio);
  const defenderReport = buildSideReport(defender, balance.woundedRatio);
  const counters = buildCounterReports(events);

  const resultWithoutHash: Omit<BattleResult, 'hash'> = {
    ruleVersion: rules.version,
    seed: input.seed,
    outcome,
    reason,
    rounds,
    initiative,
    attacker: attackerReport,
    defender: defenderReport,
    counters,
    events,
  };
  const hash = fnv1a64(stableStringify(resultWithoutHash));

  return { ...resultWithoutHash, hash };
}

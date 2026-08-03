import { describe, expect, it } from 'vitest';
import { EngineError, simulateBattle } from '../src/index.js';
import type { BattleInput } from '../src/types.js';
import { army, battle } from './helpers.js';

function expectCode(input: unknown, code: string): void {
  try {
    simulateBattle(input as BattleInput);
    expect.unreachable(`${code} 오류가 발생해야 한다`);
  } catch (error) {
    expect(error).toBeInstanceOf(EngineError);
    expect((error as EngineError).code).toBe(code);
  }
}

const VALID = () =>
  battle(
    army([{ unitId: 'rifle', count: 10, row: 'front' }]),
    army([{ unitId: 'rifle', count: 10, row: 'front' }]),
  );

describe('입력 검증 (전투 게이트: 허용되지 않은 입력은 거부한다)', () => {
  it('정상 입력은 통과한다', () => {
    expect(() => simulateBattle(VALID())).not.toThrow();
  });

  it('null 또는 형식이 깨진 top-level·부대·스택을 EngineError로 거부한다', () => {
    const valid = VALID();
    const malformed: unknown[] = [
      null,
      [],
      { ...valid, ruleVersion: null },
      { ...valid, attacker: null },
      { ...valid, defender: null },
      { ...valid, attacker: { ...valid.attacker, stacks: null } },
      { ...valid, attacker: { ...valid.attacker, stacks: [null] } },
    ];
    for (const input of malformed) expectCode(input, 'INVALID_INPUT');
    expectCode(
      { ...valid, attacker: { ...valid.attacker, officer: null } },
      'INVALID_OFFICER',
    );
  });

  it('지원하지 않는 규칙 버전을 거부한다', () => {
    expectCode({ ...VALID(), ruleVersion: '9.9.9' }, 'UNSUPPORTED_RULE_VERSION');
  });

  it('프로토타입 체인 이름을 규칙 버전으로 인정하지 않는다', () => {
    for (const ruleVersion of ['toString', 'constructor', '__proto__']) {
      expectCode({ ...VALID(), ruleVersion }, 'UNSUPPORTED_RULE_VERSION');
    }
  });

  it('정수가 아니거나 범위 밖인 시드를 거부한다', () => {
    expectCode({ ...VALID(), seed: 1.5 }, 'INVALID_SEED');
    expectCode({ ...VALID(), seed: -1 }, 'INVALID_SEED');
    expectCode({ ...VALID(), seed: 2 ** 32 }, 'INVALID_SEED');
  });

  it('빈 부대를 거부한다', () => {
    expectCode({ ...VALID(), attacker: army([]) }, 'EMPTY_ARMY');
  });

  it('알 수 없는 병종을 거부한다', () => {
    expectCode(
      { ...VALID(), attacker: army([{ unitId: 'battleship', count: 1, row: 'front' }]) },
      'INVALID_UNIT',
    );
  });

  it('프로토타입 체인 이름을 병종으로 인정하지 않는다', () => {
    for (const unitId of ['toString', 'constructor', '__proto__']) {
      expectCode(
        { ...VALID(), attacker: army([{ unitId, count: 1, row: 'front' }]) },
        'INVALID_UNIT',
      );
    }
  });

  it('0, 음수, 소수, 상한 초과 수량을 거부한다', () => {
    for (const count of [0, -3, 2.5, 100001]) {
      expectCode(
        { ...VALID(), attacker: army([{ unitId: 'rifle', count, row: 'front' }]) },
        'INVALID_COUNT',
      );
    }
  });

  it('잘못된 열과 예비대 라운드를 거부한다', () => {
    expectCode(
      {
        ...VALID(),
        attacker: army([{ unitId: 'rifle', count: 5, row: 'navy' as never }]),
      },
      'INVALID_ROW',
    );
    expectCode(
      {
        ...VALID(),
        attacker: army([{ unitId: 'rifle', count: 5, row: 'front', reserveRound: 0 }]),
      },
      'INVALID_RESERVE',
    );
  });

  it('범위 밖 보급·정찰 정확도·철수 임계값을 거부한다', () => {
    expectCode({ ...VALID(), attacker: army([{ unitId: 'rifle', count: 5, row: 'front' }], { supply: 1.5 }) }, 'INVALID_SUPPLY');
    expectCode({ ...VALID(), attacker: army([{ unitId: 'rifle', count: 5, row: 'front' }], { reconAccuracy: -0.1 }) }, 'INVALID_RECON');
    expectCode({ ...VALID(), attacker: army([{ unitId: 'rifle', count: 5, row: 'front' }], { retreatThreshold: 0.95 }) }, 'INVALID_THRESHOLD');
  });

  it('범위 밖 장교 능력치와 알 수 없는 교리를 거부한다', () => {
    expectCode(
      {
        ...VALID(),
        attacker: army([{ unitId: 'rifle', count: 5, row: 'front' }], {
          officer: { name: 'x', command: 120, tactics: 0, admin: 0, intel: 0, logistics: 0 },
        }),
      },
      'INVALID_OFFICER',
    );
    expectCode(
      {
        ...VALID(),
        attacker: army([{ unitId: 'rifle', count: 5, row: 'front' }], { doctrine: 'naval' as never }),
      },
      'INVALID_DOCTRINE',
    );
  });

  it('프로토타입 체인 이름을 교리로 인정하지 않는다', () => {
    for (const doctrine of ['toString', 'constructor', '__proto__']) {
      expectCode(
        {
          ...VALID(),
          attacker: army([{ unitId: 'rifle', count: 5, row: 'front' }], {
            doctrine: doctrine as never,
          }),
        },
        'INVALID_DOCTRINE',
      );
    }
  });
});

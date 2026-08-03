import { ECONOMY_ARCHETYPES, simulateSeason } from '../economy/index.js';

const reports = [
  simulateSeason({ ruleVersion: '0.1.0', archetype: ECONOMY_ARCHETYPES.four, days: 42 }),
  simulateSeason({ ruleVersion: '0.1.0', archetype: ECONOMY_ARCHETYPES.two, days: 42 }),
  simulateSeason({ ruleVersion: '0.1.0', archetype: ECONOMY_ARCHETYPES.one, days: 42 }),
];

console.log('\nVictory 1944 경제 PoC v0.1.0 — 42일 결정론 시뮬레이션\n');
console.table(reports.map((report) => ({
  코호트: report.archetypeId,
  접속: `${report.sessionsPerDay}회/일`,
  군사_가치: report.armyValue,
  병력: report.trainedUnits,
  사령부: report.finalBuildings.hq,
  연구: report.researchCount,
  출정: report.sortieCount,
  식량_미충족_시간: report.starvationHours,
})));

const [four, two, one] = reports;
if (!four || !two || !one) throw new Error('코호트 보고서가 누락됐습니다.');
const fourToTwo = four.armyValue / Math.max(1, two.armyValue);
const twoToOne = two.armyValue / Math.max(1, one.armyValue);
const productionResources = ['food', 'steel', 'oil', 'supplies', 'manpower', 'scrip'] as const;
const overflowPass = productionResources.every((resourceId) => two.totals[resourceId].overflowRatio <= 0.4);
const consumptionPass = Object.values(two.totals).every((total) => total.consumed > 0);

console.log(`4회/2회 군사 가치 비율: ${fourToTwo.toFixed(3)} (게이트 <= 1.35)`);
console.log(`2회/1회 군사 가치 비율: ${twoToOne.toFixed(3)} (강건성 게이트 <= 1.75)`);
console.log(`2회 코호트 생산 자원 초과 소실률: ${productionResources.map((id) => `${id} ${(two.totals[id].overflowRatio * 100).toFixed(1)}%`).join(', ')}`);
console.log(`6종 자원 소모처 작동: ${consumptionPass ? '통과' : '실패'}`);

const passed = four.armyValue > two.armyValue
  && two.armyValue > one.armyValue
  && fourToTwo <= 1.35
  && twoToOne <= 1.75
  && overflowPass
  && consumptionPass;
console.log(`\n탐색 품질 게이트: ${passed ? '통과' : '실패'}\n`);
if (!passed) process.exitCode = 1;

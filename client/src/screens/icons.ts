/**
 * 인라인 SVG 아이콘(D-047).
 *
 * **이미지 파일을 쓰지 않는다.** 절차적 도시 아트·효과음과 같은 이유다 —
 * 에셋 파이프라인과 라이선스가 범위 밖이고, 코드로 그리면 색이 테마를 따라간다.
 *
 * 도형은 16×16 격자에 맞춰 단순하게 유지한다. 자원 막대는 항상 화면에 있고 아주 작게 그려지므로,
 * 디테일을 넣으면 뭉개져서 오히려 못 알아본다. `currentColor`를 써서 색은 CSS가 정한다.
 */

import type { ResourceId } from '../api/contract.js';

function svg(body: string): string {
  return `<svg class="icon" viewBox="0 0 16 16" aria-hidden="true" focusable="false">${body}</svg>`;
}

/** 자원 아이콘. 글자 없이도 무엇인지 구분되게 실루엣을 서로 다르게 잡았다. */
const RESOURCE_ICONS: Readonly<Record<ResourceId, string>> = {
  // 밀 이삭
  food: svg(
    '<path d="M8 15V6" stroke="currentColor" stroke-width="1.4" stroke-linecap="round"/>'
    + '<path d="M8 6.5c0-2 1.2-3.6 3-4.5.4 2.4-.8 4.2-3 4.5Z" fill="currentColor"/>'
    + '<path d="M8 6.5c0-2-1.2-3.6-3-4.5-.4 2.4.8 4.2 3 4.5Z" fill="currentColor"/>'
    + '<path d="M8 10.5c0-2 1.2-3.4 3-4.2.3 2.2-.9 3.9-3 4.2Z" fill="currentColor" opacity=".75"/>'
    + '<path d="M8 10.5c0-2-1.2-3.4-3-4.2-.3 2.2.9 3.9 3 4.2Z" fill="currentColor" opacity=".75"/>',
  ),
  // I 형강
  steel: svg(
    '<path d="M3 2.5h10v2.2H9.3v6.6H13v2.2H3v-2.2h3.7V4.7H3V2.5Z" fill="currentColor"/>',
  ),
  // 유적
  oil: svg(
    '<path d="M8 1.6c2.6 3 4.3 5.2 4.3 7.4A4.3 4.3 0 0 1 8 13.3a4.3 4.3 0 0 1-4.3-4.3c0-2.2 1.7-4.4 4.3-7.4Z" fill="currentColor"/>',
  ),
  // 보급 상자
  supplies: svg(
    '<path d="M2.6 4.4 8 2l5.4 2.4v7.2L8 14l-5.4-2.4V4.4Z" fill="currentColor" opacity=".85"/>'
    + '<path d="M2.6 4.4 8 6.8l5.4-2.4M8 6.8V14" stroke="var(--surface)" stroke-width="1.1" fill="none"/>',
  ),
  // 인원
  manpower: svg(
    '<circle cx="8" cy="4.4" r="2.6" fill="currentColor"/>'
    + '<path d="M2.6 14.2c0-3 2.4-5 5.4-5s5.4 2 5.4 5H2.6Z" fill="currentColor"/>',
  ),
  // 군표(지폐)
  scrip: svg(
    '<rect x="1.6" y="4" width="12.8" height="8" rx="1.2" fill="currentColor" opacity=".85"/>'
    + '<circle cx="8" cy="8" r="2.1" fill="var(--surface)"/>',
  ),
};

export function resourceIcon(resourceId: ResourceId): string {
  return RESOURCE_ICONS[resourceId];
}

/**
 * 하단 탭 아이콘(D-053).
 * 원작의 우측 레일은 아이콘+글자였다. 레일 자체는 2012년 패턴이라 가져오지 않았지만,
 * **아이콘을 붙이면 훑어 읽기가 빨라진다**는 점은 지금도 유효하다.
 */
const TAB_ICONS: Readonly<Record<string, string>> = {
  // 도시: 건물 실루엣
  city: svg(
    '<path d="M2 14V7l4-2.5V14H2Z" fill="currentColor" opacity=".8"/>'
    + '<path d="M7 14V3l4 2v9H7Z" fill="currentColor"/>'
    + '<path d="M12 14V7l2.5 1.5V14H12Z" fill="currentColor" opacity=".8"/>',
  ),
  // 작전: 목표 표적
  operations: svg(
    '<circle cx="8" cy="8" r="5.6" fill="none" stroke="currentColor" stroke-width="1.5"/>'
    + '<circle cx="8" cy="8" r="1.9" fill="currentColor"/>'
    + '<path d="M8 .8v2.4M8 12.8v2.4M.8 8h2.4M12.8 8h2.4" stroke="currentColor" stroke-width="1.4"'
    + ' stroke-linecap="round"/>',
  ),
  // 보고서: 문서
  reports: svg(
    '<path d="M3.4 1.8h6.2L12.6 5v9.2H3.4V1.8Z" fill="currentColor" opacity=".85"/>'
    + '<path d="M5.4 7.4h5.2M5.4 9.8h5.2M5.4 12h3.2" stroke="var(--surface)" stroke-width="1.1"'
    + ' stroke-linecap="round"/>',
  ),
  // 설정: 톱니
  settings: svg(
    '<circle cx="8" cy="8" r="2.6" fill="none" stroke="currentColor" stroke-width="1.6"/>'
    + '<path d="M8 1.4v2M8 12.6v2M1.4 8h2M12.6 8h2M3.4 3.4l1.4 1.4M11.2 11.2l1.4 1.4'
    + 'M12.6 3.4l-1.4 1.4M4.8 11.2l-1.4 1.4" stroke="currentColor" stroke-width="1.5"'
    + ' stroke-linecap="round"/>',
  ),
};

export function tabIcon(tab: string): string {
  return TAB_ICONS[tab] ?? '';
}

/** 화면 표제 옆에 붙는 작은 표식. 카드가 무엇에 대한 것인지 한눈에 갈리게 한다. */
export const CHEVRON = svg(
  '<path d="M6 3.5 10.5 8 6 12.5" stroke="currentColor" stroke-width="1.8" fill="none"'
  + ' stroke-linecap="round" stroke-linejoin="round"/>',
);

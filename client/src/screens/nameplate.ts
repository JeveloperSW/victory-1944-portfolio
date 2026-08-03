/**
 * 도시 이름패(D-054).
 *
 * 상단에는 지금까지 앱 제목이 박혀 있었다. 제목은 아이콘과 첫 화면이 이미 말해 주므로
 * **모든 화면의 가장 좋은 자리를 제목에 쓰는 것은 낭비다.** 그 자리를 도시 이름에 넘긴다 —
 * 플레이어가 부르는 이름이 화면의 주어가 되어야 한다.
 *
 * 원작도 상단에 도시 이름을 두었지만 별도 창을 띄워 고치게 했다.
 * 여기서는 이름패를 그대로 눌러 자리에서 고친다(창 없음). 손가락 하나로 끝나는 것이
 * 창을 띄우고 닫는 것보다 언제나 빠르다.
 *
 * 규칙은 하나도 갖지 않는다. 길이·문자 판정은 서버가 하고(`INVALID_CITY_NAME`),
 * 여기 `maxlength`는 손가락을 돕는 장치일 뿐 검증이 아니다. 저장 뒤에는
 * **서버가 정규화한 이름**을 다시 받아 표시한다 — 화면이 다듬은 값을 정답으로 삼지 않는다.
 */

/** 서버 CHECK와 같은 값. 입력창 편의용이며 판정은 서버가 한다. */
const NAME_LIMIT = 24;

export interface NamePlateHandlers {
  /** 저장을 시도한다. 성공하면 true. 거부 사유는 호출자가 상태줄에 띄운다. */
  readonly onRename: (name: string) => Promise<boolean>;
}

/** 방패꼴 문장. 이미지 파일 없이 코드로 그린다(D-047 아이콘과 같은 원칙). */
function crestSvg(): SVGSVGElement {
  const NS = 'http://www.w3.org/2000/svg';
  const svg = document.createElementNS(NS, 'svg');
  svg.setAttribute('viewBox', '0 0 32 36');
  svg.setAttribute('class', 'crest');
  svg.setAttribute('aria-hidden', 'true');
  svg.setAttribute('focusable', 'false');

  const shield = document.createElementNS(NS, 'path');
  shield.setAttribute('d', 'M2.6 2.6h26.8v19.6c0 5.9-6 9.5-13.4 11.6C8.6 31.7 2.6 28.1 2.6 22.2V2.6Z');
  shield.setAttribute('fill', 'var(--crest-fill)');
  shield.setAttribute('stroke', 'var(--accent-deep)');
  shield.setAttribute('stroke-width', '1.4');
  svg.append(shield);

  // 놋쇠판 상단의 빛. 방패가 평평한 색면으로 보이지 않게 한다.
  const gleam = document.createElementNS(NS, 'path');
  gleam.setAttribute('d', 'M4.4 4.4h23.2v6.4H4.4z');
  gleam.setAttribute('fill', 'var(--accent)');
  gleam.setAttribute('opacity', '0.1');
  svg.append(gleam);

  const initial = document.createElementNS(NS, 'text');
  initial.setAttribute('class', 'crest-initial');
  initial.setAttribute('x', '16');
  initial.setAttribute('y', '17.5');
  initial.setAttribute('text-anchor', 'middle');
  initial.setAttribute('dominant-baseline', 'central');
  svg.append(initial);

  return svg;
}

function pencilSvg(): string {
  return '<svg class="icon" viewBox="0 0 16 16" aria-hidden="true" focusable="false">'
    + '<path d="M11.1 1.9l3 3-1.6 1.6-3-3 1.6-1.6Z" fill="currentColor"/>'
    + '<path d="M8.6 3.4l3 3-6.2 6.2-3.6.6.6-3.6 6.2-6.2Z" fill="currentColor" opacity=".8"/>'
    + '</svg>';
}

export class CityNamePlate {
  private readonly host: HTMLElement;
  private readonly handlers: NamePlateHandlers;

  private readonly display: HTMLButtonElement;
  private readonly crest: SVGSVGElement;
  private readonly nameText: HTMLSpanElement;
  private readonly metaText: HTMLSpanElement;

  private readonly form: HTMLFormElement;
  private readonly draftCrest: SVGSVGElement;
  private readonly input: HTMLInputElement;
  private readonly counter: HTMLSpanElement;
  private readonly save: HTMLButtonElement;
  private readonly cancel: HTMLButtonElement;

  private name = '';
  private editing = false;
  private saving = false;

  constructor(host: HTMLElement, handlers: NamePlateHandlers) {
    this.host = host;
    this.handlers = handlers;
    this.host.className = 'nameplate';

    this.display = document.createElement('button');
    this.display.type = 'button';
    this.display.className = 'plate';
    this.display.setAttribute('aria-label', '도시 이름 바꾸기');
    this.crest = crestSvg();
    const stack = document.createElement('span');
    stack.className = 'plate-stack';
    this.nameText = document.createElement('span');
    this.nameText.className = 'plate-name';
    this.metaText = document.createElement('span');
    this.metaText.className = 'plate-meta';
    stack.append(this.nameText, this.metaText);
    const pencil = document.createElement('span');
    pencil.className = 'plate-pencil';
    pencil.innerHTML = pencilSvg();
    this.display.append(this.crest, stack, pencil);
    this.display.addEventListener('click', () => { this.open(); });

    this.form = document.createElement('form');
    this.form.className = 'plate-form';
    this.form.hidden = true;
    this.input = document.createElement('input');
    this.input.className = 'plate-input';
    this.input.type = 'text';
    this.input.maxLength = NAME_LIMIT;
    this.input.autocomplete = 'off';
    this.input.spellcheck = false;
    this.input.enterKeyHint = 'done';
    this.input.setAttribute('aria-label', '도시 이름');
    this.input.placeholder = '도시 이름';
    /**
     * 고치는 중에도 문장은 자리를 지킨다. 입력칸만 남으면 머리글이 통째로 다른 화면처럼 보인다.
     * 첫 글자는 타이핑을 따라 바로 바뀐다 — 이름이 문장에 새겨지는 것을 손으로 확인하게 한다.
     */
    this.draftCrest = crestSvg();
    const row = document.createElement('div');
    row.className = 'plate-edit-row';
    row.append(this.draftCrest, this.input);

    const foot = document.createElement('div');
    foot.className = 'plate-foot';
    this.counter = document.createElement('span');
    this.counter.className = 'plate-count';
    this.cancel = document.createElement('button');
    this.cancel.type = 'button';
    this.cancel.className = 'plate-button';
    this.cancel.textContent = '취소';
    this.save = document.createElement('button');
    this.save.type = 'submit';
    this.save.className = 'plate-button primary';
    this.save.textContent = '저장';
    foot.append(this.counter, this.cancel, this.save);
    this.form.append(row, foot);

    this.input.addEventListener('input', () => { this.paintCounter(); });
    this.input.addEventListener('keydown', (event) => {
      // 취소는 창을 닫는 동작이 아니라 "고치기 전으로 되돌리기"다.
      if (event.key === 'Escape') { event.preventDefault(); this.close(); }
      /**
       * 한글 입력 중의 Enter는 **글자를 완성하는 키**다(`isComposing`).
       * 그때 저장해 버리면 마지막 음절이 빠진 이름이 올라간다. 조합이 끝난 뒤에만 저장한다.
       */
      if (event.key === 'Enter' && !event.isComposing) {
        event.preventDefault();
        void this.submit();
      }
    });
    this.cancel.addEventListener('click', () => { this.close(); });
    this.form.addEventListener('submit', (event) => {
      event.preventDefault();
      void this.submit();
    });

    this.host.append(this.display, this.form);
  }

  /** 표시 갱신. 고치는 중에는 입력값을 건드리지 않는다(매 초 다시 그려도 글자가 날아가지 않게). */
  update(name: string, meta: string): void {
    this.name = name;
    this.metaText.textContent = meta;
    if (this.editing) return;
    const shown = name.length > 0 ? name : '이름 없는 도시';
    this.nameText.textContent = shown;
    // 긴 이름까지 큰 글자로 두면 잘려 나간다. 길이에 맞춰 한 단계만 줄인다.
    this.display.dataset.long = String([...shown].length > 8);
    const initial = this.crest.querySelector('.crest-initial');
    if (initial !== null) initial.textContent = [...shown][0] ?? '·';
  }

  private open(): void {
    if (this.editing) return;
    this.editing = true;
    this.input.value = this.name;
    this.paintCounter();
    this.display.hidden = true;
    this.form.hidden = false;
    this.input.focus();
    this.input.select();
  }

  private close(): void {
    if (!this.editing || this.saving) return;
    this.editing = false;
    this.form.hidden = true;
    this.display.hidden = false;
    this.update(this.name, this.metaText.textContent ?? '');
  }

  private paintCounter(): void {
    const trimmed = this.input.value.trim();
    const length = [...trimmed].length;
    this.counter.textContent = `${length}/${NAME_LIMIT}`;
    this.counter.dataset.empty = String(length === 0);
    this.save.disabled = this.saving || length === 0;
    const initial = this.draftCrest.querySelector('.crest-initial');
    if (initial !== null) initial.textContent = [...trimmed][0] ?? '·';
  }

  private async submit(): Promise<void> {
    if (this.saving) return;
    const wanted = this.input.value.trim();
    if (wanted.length === 0) return;
    if (wanted === this.name) { this.close(); return; }
    this.saving = true;
    this.form.dataset.saving = 'true';
    this.input.disabled = true;
    this.save.disabled = true;
    this.cancel.disabled = true;
    try {
      const ok = await this.handlers.onRename(wanted);
      this.saving = false;
      // 성공했으면 `update()`가 이미 서버 정규화 이름을 넣어 두었다(고치는 중에도 값은 받는다).
      // 거부되면 닫지 않는다 — 고치던 글자를 남겨 두어야 다시 시도할 수 있다.
      if (ok) this.close();
    } finally {
      this.saving = false;
      delete this.form.dataset.saving;
      this.input.disabled = false;
      this.cancel.disabled = false;
      this.paintCounter();
      if (this.editing) this.input.focus();
    }
  }
}

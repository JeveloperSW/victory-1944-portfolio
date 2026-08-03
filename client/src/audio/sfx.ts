/**
 * 효과음(D-045).
 *
 * **오디오 파일을 넣지 않는다.** WebAudio 오실레이터와 노이즈 버퍼로 그 자리에서 만든다.
 * 이유는 셋이다: 저작권 있는 음원을 쓸 수 없고, 앱 용량과 에셋 파이프라인이 범위 밖이며,
 * 절차적이면 화면의 절차적 아트와 톤이 맞는다.
 *
 * 규칙:
 * - `AudioContext`는 **첫 사용자 조작 뒤에만** 만든다. 모바일 브라우저는 그 전에는 소리를 막고,
 *   미리 만들면 suspended 상태로 남아 첫 소리가 나오지 않는다.
 * - 어떤 실패도 게임을 멈추지 않는다. 소리는 없어도 되는 것이다.
 * - 설정으로 끌 수 있고 선택은 기기에 남는다.
 */

const STORAGE_KEY = 'victory1944.sound.v1';

export type SoundName =
  | 'tap'
  | 'build'
  | 'mobilize'
  | 'research'
  | 'recon'
  | 'hit'
  | 'victory'
  | 'defeat'
  | 'reject';

let context: AudioContext | null = null;
let master: GainNode | null = null;
let enabled = readEnabled();

function readEnabled(): boolean {
  try {
    return localStorage.getItem(STORAGE_KEY) !== 'off';
  } catch {
    return true;
  }
}

export function soundEnabled(): boolean {
  return enabled;
}

export function setSoundEnabled(value: boolean): void {
  enabled = value;
  try {
    localStorage.setItem(STORAGE_KEY, value ? 'on' : 'off');
  } catch {
    // 저장 실패는 이번 실행에만 영향을 준다.
  }
  if (!value && context !== null) void context.suspend();
  if (value && context !== null) void context.resume();
}

/** 첫 조작 시점에 부른다. 이미 만들어졌으면 아무 일도 하지 않는다. */
function ensureContext(): AudioContext | null {
  if (!enabled) return null;
  if (context !== null) {
    if (context.state === 'suspended') void context.resume();
    return context;
  }
  try {
    const Ctor = window.AudioContext
      ?? (window as unknown as { webkitAudioContext?: typeof AudioContext }).webkitAudioContext;
    if (Ctor === undefined) return null;
    context = new Ctor();
    master = context.createGain();
    // 전체를 낮게 깐다. 게임 소리가 알림보다 커서는 안 된다.
    master.gain.value = 0.18;
    master.connect(context.destination);
    return context;
  } catch {
    context = null;
    master = null;
    return null;
  }
}

interface ToneOptions {
  readonly type: OscillatorType;
  readonly from: number;
  readonly to?: number;
  readonly duration: number;
  readonly gain?: number;
  readonly delay?: number;
}

function tone(ctx: AudioContext, options: ToneOptions): void {
  const start = ctx.currentTime + (options.delay ?? 0);
  const oscillator = ctx.createOscillator();
  const gain = ctx.createGain();
  oscillator.type = options.type;
  oscillator.frequency.setValueAtTime(options.from, start);
  if (options.to !== undefined) {
    oscillator.frequency.exponentialRampToValueAtTime(Math.max(1, options.to), start + options.duration);
  }
  // 감쇠는 지수로 준다. 선형이면 끝에서 딱 끊겨 클릭 잡음이 난다.
  gain.gain.setValueAtTime(options.gain ?? 0.5, start);
  gain.gain.exponentialRampToValueAtTime(0.0001, start + options.duration);
  oscillator.connect(gain).connect(master!);
  oscillator.start(start);
  oscillator.stop(start + options.duration + 0.02);
}

/** 폭발·타격용 잡음. 짧은 화이트 노이즈를 저역 통과로 깎는다. */
function noise(ctx: AudioContext, duration: number, cutoff: number, gainValue: number, delay = 0): void {
  const start = ctx.currentTime + delay;
  const frames = Math.max(1, Math.floor(ctx.sampleRate * duration));
  const buffer = ctx.createBuffer(1, frames, ctx.sampleRate);
  const data = buffer.getChannelData(0);
  for (let index = 0; index < frames; index += 1) {
    data[index] = (Math.random() * 2 - 1) * (1 - index / frames);
  }
  const source = ctx.createBufferSource();
  source.buffer = buffer;
  const filter = ctx.createBiquadFilter();
  filter.type = 'lowpass';
  filter.frequency.setValueAtTime(cutoff, start);
  const gain = ctx.createGain();
  gain.gain.setValueAtTime(gainValue, start);
  gain.gain.exponentialRampToValueAtTime(0.0001, start + duration);
  source.connect(filter).connect(gain).connect(master!);
  source.start(start);
}

/**
 * 소리 하나를 낸다. 실패하면 조용히 넘어간다.
 * 음색은 1940년대 야전을 흉내 내되 짧게 — 조작 피드백이지 음악이 아니다.
 */
export function play(name: SoundName): void {
  const ctx = ensureContext();
  if (ctx === null || master === null) return;
  try {
    switch (name) {
      case 'tap':
        tone(ctx, { type: 'square', from: 420, to: 300, duration: 0.05, gain: 0.16 });
        break;
      case 'build':
        // 망치질 두 번.
        noise(ctx, 0.09, 1600, 0.5);
        noise(ctx, 0.09, 1400, 0.4, 0.13);
        tone(ctx, { type: 'triangle', from: 180, to: 120, duration: 0.16, gain: 0.2 });
        break;
      case 'mobilize':
        // 나팔 신호처럼 두 음 올림.
        tone(ctx, { type: 'sawtooth', from: 294, duration: 0.13, gain: 0.22 });
        tone(ctx, { type: 'sawtooth', from: 440, duration: 0.22, gain: 0.22, delay: 0.13 });
        break;
      case 'research':
        tone(ctx, { type: 'sine', from: 660, to: 990, duration: 0.28, gain: 0.24 });
        break;
      case 'recon':
        // 무전 삐 소리 두 번.
        tone(ctx, { type: 'sine', from: 1200, duration: 0.07, gain: 0.14 });
        tone(ctx, { type: 'sine', from: 1200, duration: 0.07, gain: 0.14, delay: 0.12 });
        break;
      case 'hit':
        noise(ctx, 0.18, 900, 0.55);
        tone(ctx, { type: 'triangle', from: 90, to: 45, duration: 0.2, gain: 0.3 });
        break;
      case 'victory':
        tone(ctx, { type: 'sawtooth', from: 392, duration: 0.16, gain: 0.2 });
        tone(ctx, { type: 'sawtooth', from: 523, duration: 0.16, gain: 0.2, delay: 0.16 });
        tone(ctx, { type: 'sawtooth', from: 659, duration: 0.4, gain: 0.22, delay: 0.32 });
        break;
      case 'defeat':
        tone(ctx, { type: 'sawtooth', from: 330, to: 160, duration: 0.55, gain: 0.22 });
        noise(ctx, 0.4, 500, 0.25, 0.1);
        break;
      case 'reject':
        tone(ctx, { type: 'square', from: 200, to: 140, duration: 0.16, gain: 0.2 });
        break;
      default:
        break;
    }
  } catch {
    // 소리는 없어도 게임이 돌아간다.
  }
}

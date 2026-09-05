/**
 * シーンに付ける効果音。
 *
 * 音声ファイルは持たず、Web Audio API の発振器とノイズだけで組み立てている。
 * 入眠前に聴く前提なので、
 *   - 全体を低い音量に抑える
 *   - 立ち上がりを鈍らせ、耳を刺す帯域をローパスで削る
 *   - 残響を長めに取って、音の切れ目を作らない
 * という方針で、どの音も「遠くで鳴っている」ように整えてある。
 *
 * ブラウザは操作なしに音を出せないので、AudioContext は
 * setEnabled(true)（＝ユーザーがボタンを押した瞬間）に初めて作る。
 */

/** 出力の最大音量。就寝前に流す前提で低く取っている。 */
const MASTER = 0.34;
/** 同時に鳴らす音の上限。超えた分は捨てて、音が団子になるのを防ぐ。 */
const VOICE_LIMIT = 24;
/** 音階の基準。A2。 */
const ROOT = 110;
/** 使う音程（半音）。ペンタトニックなので、どう重なっても濁らない。 */
const PENTA = [0, 3, 5, 7, 10];

export interface VoiceOpt {
  /** 0..1。既定 0.5 */
  gain?: number;
  /** 減衰にかける秒数 */
  decay?: number;
  /** 定位。-1 = 左、1 = 右 */
  pan?: number;
}

export interface Sfx {
  /** いま実際に音を出せる状態か */
  readonly active: boolean;
  /** ON/OFF。ON にした瞬間だけ AudioContext を作る／再開する。 */
  setEnabled(on: boolean): void;
  /** オルゴールのような、丸く減衰する音 */
  pluck(freq: number, opt?: VoiceOpt): void;
  /** 水滴。音程が滑るので、粒立ちが柔らかい */
  drop(freq: number, opt?: VoiceOpt & { bend?: number }): void;
  /** 風・衣ずれ。帯域を絞ったノイズ */
  air(opt?: VoiceOpt & { freq?: number; q?: number; sweep?: number }): void;
  /** 鳴らし続ける低音。freq に null を渡すと止まる。毎フレーム呼んでよい。 */
  drone(freq: number | null, gain?: number): void;
  /** シーン切替時に呼ぶ。持続音を止める。 */
  reset(): void;
}

/** 音階の n 番目（0 = A2）の周波数。負の値も渡せる。 */
export function tone(n: number): number {
  const i = Math.round(n);
  const len = PENTA.length;
  const oct = Math.floor(i / len);
  const semi = PENTA[((i % len) + len) % len]! + oct * 12;
  return ROOT * Math.pow(2, semi / 12);
}

/**
 * 位相が整数をまたいだ回数を返す関数を作る。
 *
 * 「波の山が通過した」「振り子が真下を通った」のような瞬間は、
 * どのシーンも t の関数として書けるので、その値が整数を越えたかで拾う。
 * 音を止めている間 sound() は呼ばれないため、間が空いても
 * 最大 2 回までしか返さない（再開時にまとめて鳴るのを防ぐ）。
 */
export function ticker(): (phase: number) => number {
  let prev = NaN;
  return (phase) => {
    if (!Number.isFinite(prev)) {
      prev = phase;
      return 0;
    }
    const n = Math.floor(phase) - Math.floor(prev);
    prev = phase;
    return n > 0 ? Math.min(n, 2) : 0;
  };
}

/** ticker() を n 個まとめて作る。振り子やドミノのような列に使う。 */
export function tickers(n: number): ((phase: number) => number)[] {
  return Array.from({ length: n }, () => ticker());
}

/** 残響用のインパルス応答。ノイズを指数関数で減衰させただけのもの。 */
function impulse(ctx: AudioContext, sec: number): AudioBuffer {
  const n = Math.floor(ctx.sampleRate * sec);
  const buf = ctx.createBuffer(2, n, ctx.sampleRate);
  for (let c = 0; c < 2; c++) {
    const data = buf.getChannelData(c);
    for (let i = 0; i < n; i++) {
      data[i] = (Math.random() * 2 - 1) * Math.pow(1 - i / n, 2.6);
    }
  }
  return buf;
}

/** ノイズ音源の種。使い回すので 1 度だけ作る。 */
function noiseBuffer(ctx: AudioContext): AudioBuffer {
  const n = ctx.sampleRate * 2;
  const buf = ctx.createBuffer(1, n, ctx.sampleRate);
  const data = buf.getChannelData(0);
  for (let i = 0; i < n; i++) data[i] = Math.random() * 2 - 1;
  return buf;
}

export function createSfx(): Sfx {
  let ctx: AudioContext | null = null;
  let master: GainNode;
  let bus: GainNode; // 各音はここへ集める
  let noise: AudioBuffer;
  let droneGain: GainNode | null = null;
  let droneOsc: OscillatorNode[] = [];

  let enabled = false;
  let voices = 0;
  /** 自動再生を止められたとき、次の操作で鳴らし直すためのフラグ */
  let waitingGesture = false;

  function setup(): AudioContext {
    const c = new AudioContext();

    master = c.createGain();
    master.gain.value = 0;
    master.connect(c.destination);

    // 耳に刺さる高域を落として、遠くで鳴っているように聞かせる
    const soft = c.createBiquadFilter();
    soft.type = 'lowpass';
    soft.frequency.value = 2400;
    soft.Q.value = 0.6;
    soft.connect(master);

    bus = c.createGain();
    bus.gain.value = 1;
    bus.connect(soft);

    // 長めの残響。音の輪郭が溶けて、切れ目が気にならなくなる
    const conv = c.createConvolver();
    conv.buffer = impulse(c, 2.8);
    const send = c.createGain();
    send.gain.value = 0.5;
    bus.connect(send);
    send.connect(conv);
    conv.connect(soft);

    noise = noiseBuffer(c);
    return c;
  }

  /** 鳴らせる状態なら AudioContext を返す。そうでなければ null。 */
  function audible(): AudioContext | null {
    return enabled && ctx && ctx.state === 'running' ? ctx : null;
  }

  /** ブラウザに再生を止められた場合に備え、次の操作で resume を試す。 */
  function armGesture(): void {
    if (waitingGesture) return;
    waitingGesture = true;
    const retry = (): void => {
      waitingGesture = false;
      window.removeEventListener('pointerdown', retry);
      window.removeEventListener('keydown', retry);
      if (enabled) void ctx?.resume();
    };
    window.addEventListener('pointerdown', retry, { once: true });
    window.addEventListener('keydown', retry, { once: true });
  }

  /** 出力先。定位を挟んで bus へ繋ぐ。 */
  function out(c: AudioContext, pan: number): GainNode {
    const g = c.createGain();
    const p = c.createStereoPanner();
    p.pan.value = Math.max(-1, Math.min(1, pan));
    g.connect(p);
    p.connect(bus);
    return g;
  }

  /** 立ち上がり → 減衰の包絡線。exponential なので自然に消える。 */
  function envelope(g: GainNode, t0: number, peak: number, attack: number, decay: number): void {
    g.gain.setValueAtTime(0.0001, t0);
    g.gain.exponentialRampToValueAtTime(Math.max(peak, 0.0002), t0 + attack);
    g.gain.exponentialRampToValueAtTime(0.0001, t0 + attack + decay);
  }

  function claim(): boolean {
    if (voices >= VOICE_LIMIT) return false;
    voices++;
    return true;
  }

  return {
    get active(): boolean {
      return audible() !== null;
    },

    setEnabled(on) {
      enabled = on;
      if (on) {
        ctx ??= setup();
        void ctx.resume().catch(() => armGesture());
        if (ctx.state !== 'running') armGesture();
        const t0 = ctx.currentTime;
        master.gain.cancelScheduledValues(t0);
        master.gain.setValueAtTime(master.gain.value, t0);
        master.gain.linearRampToValueAtTime(MASTER, t0 + 0.8); // ふわりと入る
      } else if (ctx) {
        this.drone(null);
        const t0 = ctx.currentTime;
        master.gain.cancelScheduledValues(t0);
        master.gain.setValueAtTime(master.gain.value, t0);
        master.gain.linearRampToValueAtTime(0, t0 + 0.5);
      }
    },

    pluck(freq, opt = {}) {
      const c = audible();
      if (!c || !claim()) return;
      const { gain = 0.5, decay = 1.6, pan = 0 } = opt;
      const t0 = c.currentTime;

      const g = out(c, pan);
      envelope(g, t0, gain * 0.5, 0.02, decay);

      const o = c.createOscillator();
      o.type = 'sine';
      o.frequency.value = freq;
      o.connect(g);

      // 倍音を薄く重ねると、正弦波だけより芯が出る
      const h = c.createOscillator();
      h.type = 'triangle';
      h.frequency.value = freq * 2.01;
      const hg = c.createGain();
      hg.gain.value = 0.16;
      h.connect(hg);
      hg.connect(g);

      const end = t0 + 0.02 + decay + 0.05;
      o.start(t0);
      h.start(t0);
      o.stop(end);
      h.stop(end);
      o.onended = () => {
        voices--;
        g.disconnect();
      };
    },

    drop(freq, opt = {}) {
      const c = audible();
      if (!c || !claim()) return;
      const { gain = 0.5, decay = 0.5, pan = 0, bend = 0.55 } = opt;
      const t0 = c.currentTime;

      const g = out(c, pan);
      envelope(g, t0, gain * 0.45, 0.008, decay);

      const o = c.createOscillator();
      o.type = 'sine';
      // 低いところから跳ね上がると、水滴のあの「ぽとん」になる
      o.frequency.setValueAtTime(freq * bend, t0);
      o.frequency.exponentialRampToValueAtTime(freq, t0 + decay * 0.55);
      o.connect(g);

      const end = t0 + decay + 0.05;
      o.start(t0);
      o.stop(end);
      o.onended = () => {
        voices--;
        g.disconnect();
      };
    },

    air(opt = {}) {
      const c = audible();
      if (!c || !claim()) return;
      const { gain = 0.4, decay = 1.2, pan = 0, freq = 700, q = 1.4, sweep = 1 } = opt;
      const t0 = c.currentTime;

      const g = out(c, pan);
      // 風は立ち上がりも遅い。attack を長く取って撫でるように
      envelope(g, t0, gain * 0.35, decay * 0.45, decay);

      const f = c.createBiquadFilter();
      f.type = 'bandpass';
      f.frequency.setValueAtTime(freq, t0);
      if (sweep !== 1) f.frequency.exponentialRampToValueAtTime(freq * sweep, t0 + decay);
      f.Q.value = q;
      f.connect(g);

      const src = c.createBufferSource();
      src.buffer = noise;
      src.loop = true;
      src.connect(f);

      const end = t0 + decay * 1.45 + 0.05;
      src.start(t0);
      src.stop(end);
      src.onended = () => {
        voices--;
        g.disconnect();
      };
    },

    drone(freq, gain = 0.3) {
      const c = ctx;
      if (!c) return;

      if (freq === null) {
        if (droneGain) droneGain.gain.setTargetAtTime(0.0001, c.currentTime, 0.4);
        return;
      }
      if (!audible()) return;

      if (!droneGain) {
        droneGain = c.createGain();
        droneGain.gain.value = 0.0001;
        droneGain.connect(bus);
        // わずかに離調した 2 本で、うなりのあるぶ厚い持続音にする
        for (const detune of [-4, 5]) {
          const o = c.createOscillator();
          o.type = 'sine';
          o.detune.value = detune;
          o.frequency.value = freq;
          o.connect(droneGain);
          o.start();
          droneOsc.push(o);
        }
      }
      const t0 = c.currentTime;
      // 毎フレーム呼ばれるので、必ず時定数付きで滑らかに追従させる
      for (const o of droneOsc) o.frequency.setTargetAtTime(freq, t0, 0.25);
      droneGain.gain.setTargetAtTime(Math.max(gain * 0.35, 0.0001), t0, 0.15);
    },

    reset() {
      this.drone(null);
    },
  };
}

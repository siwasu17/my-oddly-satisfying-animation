import type { SceneModule } from './types.ts';

export interface UiHandlers {
  /** シーンを選ぶ（範囲外の index は巻き戻す） */
  select(index: number): void;
  /** 自動切替の ON/OFF を反転し、切替後の状態を返す */
  toggleAutoPlay(): boolean;
  /** 効果音の ON/OFF を反転し、切替後の状態を返す */
  toggleSound(): boolean;
}

export interface Ui {
  /** 現在のシーンをタイトル・タブへ反映する */
  show(index: number, scene: SceneModule): void;
  /** 説明文だけを一時的に差し替える（自動切替の状態表示など） */
  setDesc(text: string): void;
  /** 画面を一瞬だけ暗転させ、シーンの入れ替わりを隠す */
  flash(): void;
  /** 効果音ボタンの見た目を現在の状態に合わせる */
  showSound(on: boolean): void;
  /** 自動切替ボタンの見た目を現在の状態に合わせる */
  showAutoPlay(on: boolean): void;
}

// 横スワイプでシーンを送るときのしきい値。
// これらを超えなかった指の動きは、OrbitControls の視点回転にそのまま残る。

/** 送りと判定する横方向の移動量（px） */
const SWIPE_MIN_X = 56;
/** 縦揺れに対して横がこれだけ勝っていること */
const SWIPE_RATIO = 1.6;
/** ゆっくりした指の動きは回転なので、この時間を過ぎたら送らない（ms） */
const SWIPE_MAX_MS = 600;

/** タブ列の端をぼかす幅（px）。まだ先があることを示すためだけのもの。 */
const TAB_FADE_PX = 48;

function el<T extends HTMLElement>(id: string): T {
  const node = document.getElementById(id);
  if (!node) throw new Error(`#${id} が index.html に見つかりません`);
  return node as T;
}

export function createUi(scenes: readonly SceneModule[], handlers: UiHandlers): Ui {
  const app = el('app');
  const title = el('title');
  const desc = el('desc');
  const fade = el('fade');
  const tabs = el('tabs');
  const sound = el<HTMLButtonElement>('sound');
  const auto = el<HTMLButtonElement>('auto');

  const buttons = scenes.map((scene, i) => {
    const b = document.createElement('button');
    b.type = 'button';
    b.className = 'tab';
    b.textContent = `${i + 1}. ${scene.name}`;
    b.addEventListener('click', () => handlers.select(i));
    tabs.appendChild(b);
    return b;
  });

  /** ボタンとキーの両方から呼ぶ。表示は必ずここを通して更新する。 */
  function flipSound(): void {
    showSound(handlers.toggleSound());
  }

  function showSound(on: boolean): void {
    sound.textContent = on ? '♪ 効果音 ON' : '♪ 効果音 OFF';
    sound.setAttribute('aria-pressed', String(on));
    sound.classList.toggle('on', on);
  }

  /** ボタンとキーの両方から呼ぶ。表示は必ずここを通して更新する。 */
  function flipAutoPlay(): void {
    showAutoPlay(handlers.toggleAutoPlay());
  }

  function showAutoPlay(on: boolean): void {
    auto.textContent = on ? '⟳ 自動切替 ON' : '⟳ 自動切替 OFF';
    auto.setAttribute('aria-pressed', String(on));
    auto.classList.toggle('on', on);
  }

  sound.addEventListener('click', flipSound);
  auto.addEventListener('click', flipAutoPlay);

  window.addEventListener('keydown', (e) => {
    if (e.key >= '1' && e.key <= String(Math.min(scenes.length, 9))) {
      handlers.select(Number(e.key) - 1);
    } else if (e.key === 'ArrowRight') {
      handlers.select(currentIndex + 1);
    } else if (e.key === 'ArrowLeft') {
      handlers.select(currentIndex - 1);
    } else if (e.key === 's' || e.key === 'S') {
      flipSound();
    } else if (e.code === 'Space') {
      e.preventDefault();
      flipAutoPlay();
    }
  });

  let currentIndex = 0;

  /**
   * スマホでの横スワイプ。指 1 本で素早く払われたときだけ前後のシーンへ送る。
   * 見ているのは映像の面（#app）だけなので、タブの横スクロールとはぶつからない。
   * マウスやペンでは動かさない（視点のドラッグ回転と区別がつかないため）。
   */
  function watchSwipe(surface: HTMLElement): void {
    const touching = new Set<number>();
    let id = -1; // 送りの候補として追っている指。-1 は「追っていない」
    let x0 = 0;
    let y0 = 0;
    let t0 = 0;

    surface.addEventListener('pointerdown', (e) => {
      if (e.pointerType !== 'touch') return;
      touching.add(e.pointerId);
      // 2 本目が触れたらピンチ。このジェスチャは送りに使わない
      if (touching.size > 1) {
        id = -1;
        return;
      }
      id = e.pointerId;
      x0 = e.clientX;
      y0 = e.clientY;
      t0 = e.timeStamp;
    });

    surface.addEventListener('pointermove', (e) => {
      if (e.pointerId !== id) return;
      if (e.timeStamp - t0 > SWIPE_MAX_MS) {
        id = -1; // 払うにしては遅い。指を離すまで視点回転として扱う
        return;
      }
      const dx = e.clientX - x0;
      const dy = e.clientY - y0;
      if (Math.abs(dx) < SWIPE_MIN_X) return;
      if (Math.abs(dx) < Math.abs(dy) * SWIPE_RATIO) return;
      id = -1; // 1 回のスワイプで送るのは 1 枚だけ
      // 左へ払ったら次（タブの並びで右隣）のシーンへ
      handlers.select(currentIndex + (dx < 0 ? 1 : -1));
    });

    const release = (e: PointerEvent): void => {
      touching.delete(e.pointerId);
      if (e.pointerId === id) id = -1;
    };
    surface.addEventListener('pointerup', release);
    surface.addEventListener('pointercancel', release);
  }

  watchSwipe(app);

  /**
   * タブ列の端のフェード幅を、残りのスクロール量から決める。
   * 固定幅でぼかすと端まで送っても最後のタブが霞んだままになるので、
   * 端に近づくほど細くし、着いたら 0 にして全部見せる。
   */
  function fadeTabEdges(): void {
    const rest = Math.max(tabs.scrollWidth - tabs.clientWidth - tabs.scrollLeft, 0);
    tabs.style.setProperty('--fade-l', `${Math.min(tabs.scrollLeft, TAB_FADE_PX)}px`);
    tabs.style.setProperty('--fade-r', `${Math.min(rest, TAB_FADE_PX)}px`);
  }

  tabs.addEventListener('scroll', fadeTabEdges, { passive: true });
  window.addEventListener('resize', fadeTabEdges);
  fadeTabEdges();

  return {
    show(index, scene) {
      currentIndex = index;
      title.textContent = scene.name;
      desc.textContent = scene.desc;
      buttons.forEach((b, i) => b.classList.toggle('on', i === index));
      // 狭い画面ではタブが横スクロールするので、選択中のものを見える位置へ
      buttons[index]?.scrollIntoView({ block: 'nearest', inline: 'center' });
      fadeTabEdges(); // スクロールが起きなかったときのために自分でも呼ぶ
    },
    setDesc(text) {
      desc.textContent = text;
    },
    flash() {
      fade.style.opacity = '1';
      window.setTimeout(() => {
        fade.style.opacity = '0';
      }, 180);
    },
    showSound,
    showAutoPlay,
  };
}

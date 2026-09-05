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

function el<T extends HTMLElement>(id: string): T {
  const node = document.getElementById(id);
  if (!node) throw new Error(`#${id} が index.html に見つかりません`);
  return node as T;
}

export function createUi(scenes: readonly SceneModule[], handlers: UiHandlers): Ui {
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

  return {
    show(index, scene) {
      currentIndex = index;
      title.textContent = scene.name;
      desc.textContent = scene.desc;
      buttons.forEach((b, i) => b.classList.toggle('on', i === index));
      // 狭い画面ではタブが横スクロールするので、選択中のものを見える位置へ
      buttons[index]?.scrollIntoView({ block: 'nearest', inline: 'center' });
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

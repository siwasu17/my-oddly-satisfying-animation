import type { SceneModule } from './types.ts';

export interface UiHandlers {
  /** シーンを選ぶ（範囲外の index は巻き戻す） */
  select(index: number): void;
  /** 自動切替の ON/OFF を反転し、切替後の状態を返す */
  toggleAutoPlay(): boolean;
}

export interface Ui {
  /** 現在のシーンをタイトル・タブへ反映する */
  show(index: number, scene: SceneModule): void;
  /** 説明文だけを一時的に差し替える（自動切替の状態表示など） */
  setDesc(text: string): void;
  /** 画面を一瞬だけ暗転させ、シーンの入れ替わりを隠す */
  flash(): void;
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

  const buttons = scenes.map((scene, i) => {
    const b = document.createElement('button');
    b.type = 'button';
    b.className = 'tab';
    b.textContent = `${i + 1}. ${scene.name}`;
    b.addEventListener('click', () => handlers.select(i));
    tabs.appendChild(b);
    return b;
  });

  window.addEventListener('keydown', (e) => {
    if (e.key >= '1' && e.key <= String(Math.min(scenes.length, 9))) {
      handlers.select(Number(e.key) - 1);
    } else if (e.key === 'ArrowRight') {
      handlers.select(currentIndex + 1);
    } else if (e.key === 'ArrowLeft') {
      handlers.select(currentIndex - 1);
    } else if (e.code === 'Space') {
      e.preventDefault();
      const on = handlers.toggleAutoPlay();
      desc.textContent = on
        ? scenes[currentIndex]!.desc
        : '自動切替：OFF（Space でもう一度 ON）';
    }
  });

  let currentIndex = 0;

  return {
    show(index, scene) {
      currentIndex = index;
      title.textContent = scene.name;
      desc.textContent = scene.desc;
      buttons.forEach((b, i) => b.classList.toggle('on', i === index));
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
  };
}

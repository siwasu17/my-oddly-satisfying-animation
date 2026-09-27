import * as THREE from 'three';
import { mergeVertices } from 'three/addons/utils/BufferGeometryUtils.js';

/**
 * セル調（トゥーン）の陰影と輪郭線。
 *
 * 陰影は MeshToonMaterial に celGradient() を gradientMap として渡す。
 * 輪郭線は「裏返した一回り大きい殻」を黒で描く方式（inverted hull）で、
 * addInk(mesh, inkMaterial(太さ)) を呼ぶと mesh の子として付く。
 * 子なので mesh を動かせば線も付いてくるし、切替時の disposeGroup() でまとめて破棄される。
 *
 * 背景（palette の BG）はほぼ黒なので、黒い線が見えるのは明るい物どうしが重なるところだけ。
 * 線をはっきり見せたいときは、後ろに少しだけ明るい面（床・背板）を置く。
 */

/** 輪郭線の色。BG よりわずかに明るい焦げ茶で、真っ黒の穴に見えないようにしてある */
export const INK = 0x1a0c0a;

/** セルの段の既定（0..255、暗い順） */
const DEFAULT_BANDS: readonly number[] = [70, 150, 255];

const gradients = new Map<string, THREE.DataTexture>();

/**
 * セル陰影の段を作るグラデーション。Nearest で引くので段が混ざらない。
 * 同じ段の組は 1 枚を使い回す（材質を破棄しても map は破棄されないので、作り直すと溜まっていく）。
 */
export function celGradient(bands: readonly number[] = DEFAULT_BANDS): THREE.DataTexture {
  const key = bands.join(',');
  let tex = gradients.get(key);
  if (tex) return tex;
  tex = new THREE.DataTexture(new Uint8Array(bands), bands.length, 1, THREE.RedFormat);
  tex.minFilter = THREE.NearestFilter;
  tex.magFilter = THREE.NearestFilter;
  tex.generateMipmaps = false;
  tex.needsUpdate = true;
  gradients.set(key, tex);
  return tex;
}

/**
 * 輪郭線の材質。裏面だけを法線の向きへ width（ワールド単位）押し出して描くと、
 * 表の縁からはみ出したぶんが線になる。押し出しはビュー空間で行うので、
 * メッシュやインスタンスを伸び縮みさせても線の太さは変わらない。
 *
 * ただしインスタンスがいちばん縮んだ軸で fade 倍を下回ったら、線も一緒に細らせる
 * （大きさ 0 で隠したインスタンスや、画面端で細らせて消すものに、線だけが残らないように）。
 */
export function inkMaterial(width: number, fade = 0.2): THREE.MeshBasicMaterial {
  const mat = new THREE.MeshBasicMaterial({ color: INK, side: THREE.BackSide });
  mat.onBeforeCompile = (shader) => {
    shader.uniforms.inkWidth = { value: width };
    shader.uniforms.inkFade = { value: fade };
    shader.vertexShader = shader.vertexShader
      .replace('void main() {', 'uniform float inkWidth;\nuniform float inkFade;\nvoid main() {')
      .replace(
        '#include <project_vertex>',
        `#include <project_vertex>
        vec3 inkN = normal;
        float inkK = 1.0;
        #ifdef USE_INSTANCING
          mat3 inkIm = mat3( instanceMatrix );
          vec3 inkS2 = max( vec3( dot( inkIm[ 0 ], inkIm[ 0 ] ), dot( inkIm[ 1 ], inkIm[ 1 ] ), dot( inkIm[ 2 ], inkIm[ 2 ] ) ), vec3( 1e-12 ) );
          inkN = inkIm * ( inkN / inkS2 );
          inkK = clamp( sqrt( min( inkS2.x, min( inkS2.y, inkS2.z ) ) ) / max( inkFade, 1e-6 ), 0.0, 1.0 );
        #endif
        mvPosition.xyz += normalize( normalMatrix * inkN + vec3( 1e-6 ) ) * inkWidth * inkK;
        gl_Position = projectionMatrix * mvPosition;`,
      );
  };
  return mat;
}

/**
 * mesh に輪郭線を子として付けて返す。
 *
 * 角で法線が割れている形（箱・円柱のふち）でも線が途切れないよう、輪郭用のジオメトリは
 * 位置だけで頂点を束ねて法線をならしておく。
 * InstancedMesh なら行列を共有するので、update で動かすのは元のメッシュだけでよい。
 * ただし元の count を毎フレーム変えるなら、返り値の count も合わせること。
 */
export function addInk(mesh: THREE.Mesh, mat: THREE.Material): THREE.Mesh {
  const geo = mesh.geometry.clone();
  for (const name of Object.keys(geo.attributes)) if (name !== 'position') geo.deleteAttribute(name);
  const merged = mergeVertices(geo);
  geo.dispose();
  merged.computeVertexNormals();

  let ink: THREE.Mesh;
  const inst = mesh as THREE.InstancedMesh;
  if (inst.isInstancedMesh) {
    const copy = new THREE.InstancedMesh(merged, mat, inst.count);
    copy.instanceMatrix = inst.instanceMatrix;
    copy.frustumCulled = false;
    ink = copy;
  } else {
    ink = new THREE.Mesh(merged, mat);
  }
  // 影は元のメッシュが落とす。殻まで落とすと影が一回り太る
  ink.userData.shadow = false;
  mesh.add(ink);
  return ink;
}

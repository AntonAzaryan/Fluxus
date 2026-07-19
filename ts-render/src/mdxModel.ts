/**
 * MDX model loader and builder for Warcraft 3 models
 * Uses war3-model package for parsing binary MDX files
 */

import * as THREE from 'three';
import { parseMDX, model as MdlModel } from 'war3-model';

// ============================================================================
// Type declarations (local mirrors for war3-model types used internally)
// ============================================================================

interface AnimVector {
  LineType: number;
  GlobalSeqId?: number;
  Keys: { Frame: number; Vector: ArrayLike<number> }[];
}

// ============================================================================
// Public API
// ============================================================================

export interface MdxInstance {
  root: THREE.Group;
  mixer: THREE.AnimationMixer;
  clips: THREE.AnimationClip[];
  play(nameSubstr: string): void;
  /** Скрыть геосеты по индексу (индекс в mdl.Geosets). */
  hideGeosets(ids: number[]): void;
}

/**
 * Load and parse MDX model from URL
 */
export async function loadMdxModel(url: string): Promise<MdlModel.Model> {
  const buf = await (await fetch(url)).arrayBuffer();
  return parseMDX(buf);
}

/**
 * Evaluate alpha value for a geoset at a specific frame
 */
function evalAlphaAt(
  alpha: number | { Keys?: { Frame: number; Vector: ArrayLike<number> }[] } | undefined,
  frame: number
): number {
  if (alpha == null) return 1;
  if (typeof alpha === 'number') return alpha;
  const keys = alpha.Keys;
  if (!keys || keys.length === 0) return 1;
  // берём значение последнего ключа с Frame <= frame, иначе первый ключ
  let val = keys[0].Vector[0];
  for (const k of keys) {
    if (k.Frame <= frame) val = k.Vector[0];
    else break;
  }
  return val;
}

/**
 * Build a fresh instance from parsed model
 */
export function buildMdxInstance(mdl: MdlModel.Model): MdxInstance {
  // ==========================================================================
  // A. Кости и скелет
  // ==========================================================================
  const nodes = mdl.Nodes;
  const bones: THREE.Bone[] = nodes.map((n) => {
    const b = new THREE.Bone();
    b.name = `b${n.ObjectId}`;
    return b;
  });

  const byId = new Map<number, THREE.Bone>();
  nodes.forEach((n, i) => byId.set(n.ObjectId, bones[i]));

  const roots: THREE.Bone[] = [];
  nodes.forEach((n, i) => {
    const b = bones[i];
    const p = n.PivotPoint; // [x,y,z]
    if (n.Parent != null && byId.has(n.Parent)) {
      const parentNode = nodes.find((m) => m.ObjectId === n.Parent)!;
      const pp = parentNode.PivotPoint;
      byId.get(n.Parent)!.add(b);
      b.position.set(p[0] - pp[0], p[1] - pp[1], p[2] - pp[2]);
    } else {
      b.position.set(p[0], p[1], p[2]);
      roots.push(b);
    }
  });

  const boneIndexById = new Map<number, number>();
  nodes.forEach((n, i) => boneIndexById.set(n.ObjectId, i));

  // ==========================================================================
  // B. Группа и биндинг
  // ==========================================================================
  const root = new THREE.Group();
  roots.forEach((b) => root.add(b));
  // ВАЖНО: обновить мировые матрицы костей ДО создания Skeleton — иначе
  // Skeleton.calculateInverses() посчитает inverse-bind по единичным матрицам
  // (кости ещё не в графе сцены) и скининг забайндится с искажением/схлопыванием.
  root.updateMatrixWorld(true);

  const skeleton = new THREE.Skeleton(bones);

  // ==========================================================================
  // C. Геометрия — по одному SkinnedMesh на геосет
  // ==========================================================================
  const material = new THREE.MeshStandardMaterial({
    color: 0xb8b8b0,
    roughness: 0.85,
    metalness: 0.05,
    side: THREE.DoubleSide,
  });

  const geoMeshes: { mesh: THREE.SkinnedMesh; geosetId: number }[] = [];
  mdl.Geosets.forEach((g, gi) => {
    const vcount = g.Vertices.length / 3;
    const skinIndex = new Uint16Array(vcount * 4);
    const skinWeight = new Float32Array(vcount * 4);

    for (let v = 0; v < vcount; v++) {
      const grp = g.Groups[g.VertexGroup[v]] ?? [];
      const n = Math.min(grp.length, 4);
      for (let k = 0; k < n; k++) {
        skinIndex[v * 4 + k] = boneIndexById.get(grp[k]) ?? 0;
        skinWeight[v * 4 + k] = 1 / n;
      }
      if (n === 0) skinWeight[v * 4] = 1;
    }

    const geo = new THREE.BufferGeometry();
    geo.setAttribute('position', new THREE.BufferAttribute(g.Vertices, 3));
    if (g.Normals && g.Normals.length === g.Vertices.length) {
      geo.setAttribute('normal', new THREE.BufferAttribute(g.Normals, 3));
    }
    if (g.TVertices && g.TVertices[0]) {
      geo.setAttribute('uv', new THREE.BufferAttribute(g.TVertices[0], 2));
    }
    geo.setAttribute('skinIndex', new THREE.Uint16BufferAttribute(skinIndex, 4));
    geo.setAttribute('skinWeight', new THREE.Float32BufferAttribute(skinWeight, 4));
    geo.setIndex(new THREE.BufferAttribute(g.Faces, 1));
    if (!g.Normals || g.Normals.length !== g.Vertices.length) {
      geo.computeVertexNormals();
    }

    const mesh = new THREE.SkinnedMesh(geo, material);
    mesh.name = `geo${gi}`;
    mesh.bind(skeleton);
    mesh.frustumCulled = false;
    root.add(mesh);
    geoMeshes.push({ mesh, geosetId: gi });
  });

  // ==========================================================================
  // D. Клипы анимаций
  // ==========================================================================
  const clips: THREE.AnimationClip[] = [];
  for (const seq of mdl.Sequences) {
    const s0 = seq.Interval[0];
    const s1 = seq.Interval[1];
    const dur = Math.max((s1 - s0) / 1000, 0.001);
    const tracks: THREE.KeyframeTrack[] = [];

    nodes.forEach((n, i) => {
      const bn = `b${n.ObjectId}`;
      const rp = bones[i].position;

      const inWin = (v: AnimVector | undefined): { t: number[]; vec: number[][] } | null => {
        if (!v || !v.Keys) return null;
        const t: number[] = [];
        const vec: number[][] = [];
        for (const key of v.Keys) {
          if (key.Frame < s0 || key.Frame > s1) continue;
          t.push((key.Frame - s0) / 1000);
          vec.push(Array.from(key.Vector as ArrayLike<number>));
        }
        return t.length ? { t, vec } : null;
      };

      const tr = inWin(n.Translation);
      if (tr) {
        const vals: number[] = [];
        tr.vec.forEach((d) => vals.push(rp.x + d[0], rp.y + d[1], rp.z + d[2]));
        tracks.push(new THREE.VectorKeyframeTrack(`${bn}.position`, tr.t, vals));
      }

      const ro = inWin(n.Rotation);
      if (ro) {
        const vals: number[] = [];
        ro.vec.forEach((q) => vals.push(q[0], q[1], q[2], q[3]));
        tracks.push(new THREE.QuaternionKeyframeTrack(`${bn}.quaternion`, ro.t, vals));
      }

      const sc = inWin(n.Scaling);
      if (sc) {
        const vals: number[] = [];
        sc.vec.forEach((s) => vals.push(s[0], s[1], s[2]));
        tracks.push(new THREE.VectorKeyframeTrack(`${bn}.scale`, sc.t, vals));
      }
    });

    clips.push(new THREE.AnimationClip(seq.Name, dur, tracks));
  }

  // ==========================================================================
  // E. Нормализация масштаба
  // ==========================================================================
  const bbox = new THREE.Box3();
  for (const g of mdl.Geosets) {
    const arr = g.Vertices;
    for (let k = 0; k < arr.length; k += 3) {
      bbox.expandByPoint(new THREE.Vector3(arr[k], arr[k + 1], arr[k + 2]));
    }
  }
  const height = Math.max(bbox.max.z - bbox.min.z, 1e-3);

  const inner = new THREE.Group();
  while (root.children.length) inner.add(root.children[0]);
  inner.scale.setScalar(1 / height);
  inner.position.z = -bbox.min.z / height;
  root.add(inner);

  // ==========================================================================
  // F. Микшер и play
  // ==========================================================================
  const mixer = new THREE.AnimationMixer(root);
  let current: THREE.AnimationAction | null = null;

  const play = (sub: string) => {
    const clip = clips.find((c) => c.name.toLowerCase().includes(sub.toLowerCase())) ?? clips[0];
    if (!clip) return;
    const next = mixer.clipAction(clip);
    next.reset().fadeIn(0.2).play();
    if (current && current !== next) current.fadeOut(0.2);
    current = next;
  };

  const hideGeosets = (ids: number[]) => {
    for (const gm of geoMeshes) {
      if (ids.includes(gm.geosetId)) gm.mesh.visible = false;
    }
  };

  return { root, mixer, clips, play, hideGeosets };
}

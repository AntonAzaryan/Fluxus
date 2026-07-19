# Задача: рендер WC3-модели SkeletonBarbarian.mdx с анимациями в three.js

Ты работаешь в репозитории `game-mvp`, воркспейс `ts-render` (three.js 0.160.1, vite, TypeScript).
Пакет `war3-model@4.0.0` уже установлен в `node_modules` (корень репо).
Цель: игрок в игре сейчас рендерится зелёным цилиндром. Заменить его на анимированную
скелет-модель из `assets/SkeletonBarbarian.mdx`. **Текстур пока нет — рендерим серым материалом.**

Модель: бинарный MDX v800, Z-up (совпадает с игрой: Z — высота), ~17 анимаций
(`BStand`, `BWalk`, `BAttack - 1`, `BAttack - 2`, `BDeath`, `BSpell`, `BBirth`, `BStand Ready` ...).

Работай итеративно: после каждого файла запускай `cd ts-render && npm run typecheck` и чини ошибки,
пока не станет чисто. В конце запусти ещё раз и покажи, что typecheck зелёный.

---

## Шаг 0. Скопировать ассет в статику vite

Vite отдаёт статику из `ts-render/public`. Модель лежит вне воркспейса, скопируй её:

```bash
mkdir -p ts-render/public/models
cp assets/SkeletonBarbarian.mdx/SkeletonBarbarian.mdx ts-render/public/models/SkeletonBarbarian.mdx
```

Проверь, что файл на месте и весит ~147 КБ.

---

## Шаг 1. Новый файл `ts-render/src/mdxModel.ts`

Это ядро. Реализуй ТОЧНО по алгоритму ниже — не отступай от него.

### API war3-model (уже проверено, используй именно эти имена)

```ts
import { parseMDX, model as MdlModel } from 'war3-model';
// parseMDX(arrayBuffer: ArrayBuffer): Model
// Model.Sequences: { Name: string; Interval: Uint32Array /* [start,end] в кадрах-мс */; NonLooping: boolean }[]
// Model.Geosets: { Vertices: Float32Array; Normals: Float32Array; TVertices: Float32Array[];
//                  VertexGroup: Uint8Array; Faces: Uint16Array; Groups: number[][]; MaterialID: number }[]
// Model.Nodes: Node[]  // все узлы (кости+хелперы), обычно индекс === ObjectId
// Node: { Name: string; ObjectId: number; Parent?: number|null; PivotPoint: Float32Array /*[x,y,z]*/;
//         Translation?: AnimVector; Rotation?: AnimVector; Scaling?: AnimVector }
// AnimVector: { LineType: number; GlobalSeqId?: number; Keys: AnimKeyframe[] }
// AnimKeyframe: { Frame: number; Vector: Float32Array|Int32Array /* transl/scale=[x,y,z], rotation=[x,y,z,w] */ }
```

Типы бери так: `import type { model } from 'war3-model'` и обращайся к `model.Model`, `model.Node`, `model.Sequence`.
Если импорт типов из namespace не заведётся — объяви локальные `interface`-ы с нужными полями вручную.

### Экспорт

```ts
import * as THREE from 'three';

export interface MdxInstance {
  root: THREE.Group;               // добавляй в сцену; двигай root.position
  mixer: THREE.AnimationMixer;     // обновляй каждый кадр mixer.update(dt)
  clips: THREE.AnimationClip[];
  play(nameSubstr: string): void;  // включить клип по подстроке имени (регистр игнорируем)
}

export async function loadMdxModel(url: string): Promise<model.Model> {
  const buf = await (await fetch(url)).arrayBuffer();
  return parseMDX(buf);
}

// Строит свежий инстанс из уже распарсенной модели.
export function buildMdxInstance(mdl: model.Model): MdxInstance { ... }
```

### Алгоритм `buildMdxInstance` — реализуй по шагам

**A. Кости и скелет.** По одной `THREE.Bone` на каждый узел `mdl.Nodes`, имя делай УНИКАЛЬНЫМ:

```ts
const nodes = mdl.Nodes;
const bones: THREE.Bone[] = nodes.map((n) => {
  const b = new THREE.Bone();
  b.name = `b${n.ObjectId}`;      // уникально; тем же именем адресуем треки
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
    b.position.set(p[0] - pp[0], p[1] - pp[1], p[2] - pp[2]); // локально относительно родителя
  } else {
    b.position.set(p[0], p[1], p[2]);
    roots.push(b);
  }
});
const skeleton = new THREE.Skeleton(bones);
const boneIndexById = new Map<number, number>();
nodes.forEach((n, i) => boneIndexById.set(n.ObjectId, i)); // ObjectId -> индекс в bones/skeleton
```

**B. Группа и биндинг.** Корневые кости кладём в группу, чтобы скелет был в графе сцены:

```ts
const root = new THREE.Group();
roots.forEach((b) => root.add(b));
root.updateMatrixWorld(true); // важно ДО bind: даёт костям matrixWorld для расчёта inverses
```

**C. Геометрия — по одному `SkinnedMesh` на геосет, все на общий skeleton.**

```ts
const material = new THREE.MeshStandardMaterial({ color: 0xb8b8b0, roughness: 0.85, metalness: 0.05, side: THREE.DoubleSide });
for (const g of mdl.Geosets) {
  const vcount = g.Vertices.length / 3;
  const skinIndex = new Uint16Array(vcount * 4);
  const skinWeight = new Float32Array(vcount * 4);
  for (let v = 0; v < vcount; v++) {
    const grp = g.Groups[g.VertexGroup[v]] ?? [];
    const n = Math.min(grp.length, 4);
    for (let k = 0; k < n; k++) {
      skinIndex[v * 4 + k] = boneIndexById.get(grp[k]) ?? 0;
      skinWeight[v * 4 + k] = 1 / n;   // равные веса — модель WC3 усредняет матрицы группы
    }
    if (n === 0) skinWeight[v * 4] = 1; // страховка от нулевого веса
  }
  const geo = new THREE.BufferGeometry();
  geo.setAttribute('position', new THREE.BufferAttribute(g.Vertices, 3));
  if (g.Normals && g.Normals.length === g.Vertices.length)
    geo.setAttribute('normal', new THREE.BufferAttribute(g.Normals, 3));
  if (g.TVertices && g.TVertices[0])
    geo.setAttribute('uv', new THREE.BufferAttribute(g.TVertices[0], 2));
  geo.setAttribute('skinIndex', new THREE.Uint16BufferAttribute(skinIndex, 4));
  geo.setAttribute('skinWeight', new THREE.Float32BufferAttribute(skinWeight, 4));
  geo.setIndex(new THREE.BufferAttribute(g.Faces, 1));
  if (!g.Normals || g.Normals.length !== g.Vertices.length) geo.computeVertexNormals();

  const mesh = new THREE.SkinnedMesh(geo, material);
  mesh.bind(skeleton);
  root.add(mesh);
}
```

**D. Клипы анимаций.** По одной `AnimationClip` на секвенцию. Тайминг WC3 — единый глобальный
таймлайн в «кадрах» (мс); секвенция = окно `[Interval[0], Interval[1]]`. Треки адресуем `b<ObjectId>.*`.
Позиция трека = базовая rest-позиция кости + анимированная трансляция (в WC3 трансляция аддитивна к пивоту).

```ts
const clips: THREE.AnimationClip[] = [];
for (const seq of mdl.Sequences) {
  const s0 = seq.Interval[0], s1 = seq.Interval[1];
  const dur = Math.max((s1 - s0) / 1000, 0.001);
  const tracks: THREE.KeyframeTrack[] = [];

  nodes.forEach((n, i) => {
    const bn = `b${n.ObjectId}`;
    const rp = bones[i].position; // rest-позиция

    const inWin = (v: any): { t: number[]; vec: number[][] } | null => {
      if (!v || !v.Keys) return null;
      const t: number[] = [], vec: number[][] = [];
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
      ro.vec.forEach((q) => vals.push(q[0], q[1], q[2], q[3])); // xyzw
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
```

**E. Нормализация масштаба.** WC3-модели крупные. Приведи высоту (ось Z) к 1, чтобы вызывающий код
масштабировал так же, как цилиндр (умножением на height коллайдера). Считай bbox по вершинам:

```ts
const bbox = new THREE.Box3();
for (const g of mdl.Geosets) {
  const arr = g.Vertices;
  for (let k = 0; k < arr.length; k += 3)
    bbox.expandByPoint(new THREE.Vector3(arr[k], arr[k + 1], arr[k + 2]));
}
const height = Math.max(bbox.max.z - bbox.min.z, 1e-3);
const inner = new THREE.Group();
// перенос: ставим "низ" модели на z=0 и нормируем высоту
while (root.children.length) inner.add(root.children[0]);
inner.scale.setScalar(1 / height);
inner.position.z = -bbox.min.z / height;
root.add(inner);
```
(Кости-корни и меши переезжают в `inner`; skeleton остаётся валиден, т.к. это те же объекты.)

**F. Микшер и play.**

```ts
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
return { root, mixer, clips, play };
```

Учти: `THREE.SkinnedMesh` по умолчанию `frustumCulled=true` и может пропадать при анимации — поставь
`mesh.frustumCulled = false` для каждого меша.

---

## Шаг 2. Прокинуть модель в фабрику: `ts-render/src/entities.ts`

1. Импортни: `import type { MdxInstance } from './mdxModel';` и `import { buildMdxInstance } from './mdxModel';`
   плюс `import type { model } from 'war3-model';`
2. Расширь интерфейс `EntityMeshes`:
   ```ts
   export interface EntityMeshes {
     mesh: THREE.Object3D;      // было THREE.Mesh — расширить до Object3D (skinned-модель — Group)
     healthBar?: THREE.Mesh;
     trail?: THREE.Line;
     mixer?: THREE.AnimationMixer; // добавить
   }
   ```
   Проверь, что дальше по коду `meshes.mesh` используется только через свойства `Object3D`
   (`.position`, `.scale`, `.rotation`) — они есть у Object3D, ок.
3. В `EntityMeshFactory` добавь поле и сеттер прототипа модели:
   ```ts
   private playerModel: model.Model | null = null;
   setPlayerModel(m: model.Model): void { this.playerModel = m; }
   ```
4. Перепиши `createPlayer` так, чтобы при наличии `playerModel` строить MDX-инстанс, иначе — старый цилиндр.
   Верни из `create(...)` также mixer. Сейчас `create` возвращает `{ mesh, healthBar }`; сделай, чтобы
   `createPlayer` возвращал `{ mesh: THREE.Object3D; mixer?: THREE.AnimationMixer }` и пробрасывай mixer наружу.
   ```ts
   private createPlayer(entity: Entity): { mesh: THREE.Object3D; mixer?: THREE.AnimationMixer } {
     if (this.playerModel) {
       const inst = buildMdxInstance(this.playerModel);
       const height = entity.Collider ? Number(entity.Collider.height) / 65536 : 1;
       inst.root.scale.setScalar(height);   // нормированная модель имеет высоту 1
       inst.play('BStand');                 // idle по умолчанию
       return { mesh: inst.root, mixer: inst.mixer };
     }
     // ---- fallback: старый цилиндр ----
     const mesh = new THREE.Mesh(geometries.cylinder, materials.player);
     const radius = entity.Collider ? Number(entity.Collider.radius) / 65536 : 1;
     const h = entity.Collider ? Number(entity.Collider.height) / 65536 : 1;
     mesh.scale.set(radius, radius, h);
     return { mesh };
   }
   ```
   Обнови сигнатуры `createFireball/createShield/createWall` — они возвращают `THREE.Mesh`, оставь как есть,
   а в `create(...)` приведи к общему: заведи `let mesh: THREE.Object3D; let mixer: THREE.AnimationMixer | undefined;`
   Для игрока — из `createPlayer`; для остальных — как раньше. В конце верни `{ mesh, healthBar, mixer }`.
5. В `dispose` для MDX-меша НЕ трогай общие геометрии (их нет у модели — у неё свои BufferGeometry).
   Достаточно `this.scene.remove(meshes.mesh)`. Оставь текущий комментарий про общие геометрии для цилиндра.
   Дополнительно, если `meshes.mixer` есть — `meshes.mixer.stopAllAction()`.

---

## Шаг 3. Микшер в рендер-цикле: `ts-render/src/renderer.ts`

1. Добавь поле `private clock = new THREE.Clock();`
2. Добавь метод классу для установки прототипа модели во внутреннюю фабрику:
   ```ts
   setPlayerModel(m: import('war3-model').model.Model): void {
     this.entityFactory.setPlayerModel(m);
   }
   ```
3. В `updateState`, когда создаёшь meshes через фабрику, сохрани mixer (он уже в `EntityMeshes`).
   Ничего доп. не нужно, если фабрика кладёт mixer в возвращаемый объект.
4. В `start()` в `animate` перед `render` обнови все миксеры:
   ```ts
   const dt = this.clock.getDelta();
   for (const meshes of this.entityMeshes.values()) {
     if (meshes.mixer) meshes.mixer.update(dt);
   }
   ```

---

## Шаг 4. Загрузка модели при старте: `ts-render/src/demo.ts`

Перед `renderer.start()` (ближе к концу файла) добавь асинхронную предзагрузку и повесь модель на фабрику
ДО того, как игрок впервые попадёт в `updateState`. Проще всего — загрузить и только потом стартовать цикл:

```ts
import { loadMdxModel } from './mdxModel';

// ... существующий код до renderer.start() ...

loadMdxModel('/models/SkeletonBarbarian.mdx')
  .then((mdl) => {
    renderer.setPlayerModel(mdl);
    console.log('MDX модель загружена:', mdl.Sequences.map((s) => s.Name));
  })
  .catch((e) => console.error('Не удалось загрузить MDX:', e))
  .finally(() => {
    renderer.start();
    requestAnimationFrame(gameLoop);
  });
```
Убери прежние безусловные `renderer.start(); requestAnimationFrame(gameLoop);` в конце (они переезжают в `.finally`).
Если игрок уже заспавнен и его mesh создался цилиндром до загрузки — не страшно; но чтобы сразу был скелет,
`.finally` гарантирует, что модель проставлена до первого кадра. Если всё же цилиндр успевает создаться,
допустимо в `updateState` при установке модели пересоздавать mesh игрока — НО это усложнение, для MVP не делай.

---

## Шаг 5. Проверка

```bash
cd ts-render && npm run typecheck
```
Добейся нуля ошибок. Затем кратко отчитайся: какие файлы создал/изменил, что показал typecheck,
и напиши команду запуска для человека: `npm run dev -w ts-render` (откроется на :3000).

Не запускай dev-сервер сам (он блокирующий). Просто убедись, что typecheck зелёный.
```

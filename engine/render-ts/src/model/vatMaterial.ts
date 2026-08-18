/**
 * Материал батчевого яруса (REND-20, design D1/D2/D8): `MeshStandardMaterial`,
 * которому `onBeforeCompile` подменяет скиннинг и выборку карт.
 *
 * Что делает патч:
 *
 * - **скиннинг по VAT** (`assets` ASSET-12): матрица кости берётся из
 *   float-текстуры (строка — кадр, четыре текселя — матрица), а не из массива
 *   uniform'ов скелета. Пер-инстансный атрибут `instancePose` несёт две строки
 *   и вес их смешивания — этим же весом делается кроссфейд (REND-4) и
 *   межкадровое сглаживание (`vatAnimation.ts`);
 * - **скин выбором слоя** (REND-6): карты читаются из `sampler2DArray`, слой —
 *   четвёртая компонента того же атрибута. Смена скина записи — запись одного
 *   числа, а не копия материала.
 *
 * Фильтрации у VAT-текстуры нет намеренно (design, Risks): WebGL2 гарантирует
 * выборку float-текстур в вершинном стейдже только без фильтрации, поэтому
 * кадры читаются `texelFetch`, а смешивание двух поз делается руками.
 *
 * ПРОВЕРИТЬ ЭТОТ ФАЙЛ ТЕСТОМ НЕЛЬЗЯ: `onBeforeCompile` зовёт рендерер при
 * компиляции программы, а её в headless-прогоне не существует. Тестами покрыт
 * весь путь ДАННЫХ (атрибуты, uniform'ы, слои), сам GLSL проверяется глазами на
 * арене — и это известное ограничение батчевого яруса, а не недосмотр.
 */
import * as THREE from 'three';
import type { NormalizedMaterial } from '@game-mvp/assets';

/** Вид карты материала — тот же словарь, что у мест употребления слотов (REND-6). */
export type VatMapKind = 'base' | 'normal' | 'emissive';

/** Все виды карт в фиксированном порядке: обход не должен зависеть от Set'а. */
export const VAT_MAP_KINDS: readonly VatMapKind[] = ['base', 'normal', 'emissive'];

/**
 * Uniform-держатели материала. Живут отдельно от материала потому, что массив
 * вариантов скина приезжает ПОЗЖЕ материала (текстуры грузятся асинхронно,
 * ASSET-4), а `shader.uniforms` существует только внутри `onBeforeCompile`:
 * подменяется значение в держателе, а не uniform в шейдере.
 */
export interface VatMaterialUniforms {
  readonly vatMap: { value: THREE.Texture | null };
  readonly vatSkinBase: { value: THREE.Texture | null };
  readonly vatSkinNormal: { value: THREE.Texture | null };
  readonly vatSkinEmissive: { value: THREE.Texture | null };
}

export interface VatMaterial {
  readonly material: THREE.MeshStandardMaterial;
  readonly uniforms: VatMaterialUniforms;
  /** Карты, читаемые из массива вариантов скина; остальные материал не несёт. */
  readonly maps: ReadonlySet<VatMapKind>;
}

/** Uniform массива вариантов по виду карты — один ответ на весь файл. */
const SKIN_UNIFORM: Readonly<Record<VatMapKind, keyof VatMaterialUniforms>> = {
  base: 'vatSkinBase',
  normal: 'vatSkinNormal',
  emissive: 'vatSkinEmissive',
};

/** Какие карты у материала модели заняты слотами текстур (ASSET-5). */
export function materialMapKinds(source: NormalizedMaterial): Set<VatMapKind> {
  const kinds = new Set<VatMapKind>();
  if (source.baseColorTexture !== null) kinds.add('base');
  if (source.normalTexture !== null) kinds.add('normal');
  if (source.emissiveTexture !== null) kinds.add('emissive');
  return kinds;
}

/**
 * VAT-текстура модели: строка — кадр, четыре текселя подряд — матрица кости
 * (`assets` ASSET-12). RGBA32F без фильтрации и без мипов: выборка идёт
 * `texelFetch`, а мипы у таблицы матриц смысла не имеют.
 */
export function createVatTexture(width: number, height: number, data: Float32Array): THREE.DataTexture {
  const texture = new THREE.DataTexture(data, width, height, THREE.RGBAFormat, THREE.FloatType);
  texture.minFilter = THREE.NearestFilter;
  texture.magFilter = THREE.NearestFilter;
  texture.wrapS = THREE.ClampToEdgeWrapping;
  texture.wrapT = THREE.ClampToEdgeWrapping;
  texture.generateMipmaps = false;
  texture.flipY = false;
  texture.needsUpdate = true;
  return texture;
}

/**
 * Заглушка массива вариантов — один белый тексель в одном слое. Нужна потому,
 * что несвязанный сэмплер читать нельзя, а текстуры скинов приезжают асинхронно
 * (ASSET-4): до их готовности запись рисуется цветом материала, а не мусором.
 */
export function createSkinPlaceholder(): THREE.DataArrayTexture {
  const texture = new THREE.DataArrayTexture(new Uint8Array([255, 255, 255, 255]), 1, 1, 1);
  texture.needsUpdate = true;
  return texture;
}

/**
 * Материал батча из материала ассета. Исходный материал НЕ трогается: он
 * разделяется детальным ярусом (REND-3), а патч шейдера — свойство батча.
 */
export function createVatMaterial(
  source: THREE.MeshStandardMaterial,
  vatTexture: THREE.Texture,
  maps: ReadonlySet<VatMapKind>,
  placeholder: THREE.DataArrayTexture,
): VatMaterial {
  const material = source.clone();
  // Fade «ушла в туман» (FOW-8): доля проявленности едет пер-инстансным
  // атрибутом в альфу, и материал живёт в прозрачном проходе постоянно —
  // запись с fade = 1 рисуется теми же пикселями, что рисовалась бы в
  // непрозрачном (альфа 1 — тождественный блендинг), а переключение прохода
  // на лету пересобирало бы программу посреди матча.
  material.transparent = true;
  const uniforms: VatMaterialUniforms = {
    vatMap: { value: vatTexture },
    vatSkinBase: { value: placeholder },
    vatSkinNormal: { value: placeholder },
    vatSkinEmissive: { value: placeholder },
  };

  // Карта-заглушка на каждый скинуемый вид: ею three объявляет `USE_MAP` и
  // varying координат, из которых читает наш патч. Сами пиксели заглушки в
  // кадр не попадают — выборка подменена целиком.
  if (maps.has('base')) material.map = placeholder;
  if (maps.has('normal')) material.normalMap = placeholder;
  if (maps.has('emissive')) material.emissiveMap = placeholder;

  const key = `vat:${VAT_MAP_KINDS.filter((kind) => maps.has(kind)).join(',')}`;
  material.customProgramCacheKey = (): string => key;
  material.onBeforeCompile = (shader): void => {
    shader.uniforms.vatMap = uniforms.vatMap;
    for (const kind of VAT_MAP_KINDS) {
      if (!maps.has(kind)) continue;
      shader.uniforms[SKIN_UNIFORM[kind]] = uniforms[SKIN_UNIFORM[kind]];
    }
    shader.vertexShader = patchVertex(shader.vertexShader);
    shader.fragmentShader = patchFragment(shader.fragmentShader, maps);
  };

  return { material, uniforms, maps };
}

// ------------------------------------------------------------------- GLSL

/**
 * Пролог вершинного шейдера. Атрибуты скининга объявляются руками: батч —
 * не `SkinnedMesh`, и `USE_SKINNING` three не поднимает, а буферы `skinIndex`
 * и `skinWeight` у геометрии модели те же самые (design D2).
 */
const VERTEX_PRELUDE = /* glsl */ `
attribute vec4 skinIndex;
attribute vec4 skinWeight;
/** Строка первой позы, строка второй, вес второй, слой скина (REND-6). */
attribute vec4 instancePose;
/** Доля проявленности записи [0, 1] (FOW-8) — множитель альфы фрагмента. */
attribute float instanceFade;
uniform highp sampler2D vatMap;
varying float vSkinLayer;
varying float vInstanceFade;

mat4 vatBoneMatrix( float row, float bone ) {
	int y = int( row );
	int x = int( bone ) * 4;
	return mat4(
		texelFetch( vatMap, ivec2( x, y ), 0 ),
		texelFetch( vatMap, ivec2( x + 1, y ), 0 ),
		texelFetch( vatMap, ivec2( x + 2, y ), 0 ),
		texelFetch( vatMap, ivec2( x + 3, y ), 0 ) );
}

mat4 vatSkinMatrix() {
	mat4 skin = mat4( 0.0 );
	for ( int k = 0; k < 4; k ++ ) {
		float weight = skinWeight[ k ];
		if ( weight <= 0.0 ) continue;
		float bone = skinIndex[ k ];
		mat4 a = vatBoneMatrix( instancePose.x, bone );
		mat4 b = vatBoneMatrix( instancePose.y, bone );
		skin += weight * ( a + ( b - a ) * instancePose.z );
	}
	return skin;
}
`;

/**
 * Место, где поза считается один раз на вершину: `skinbase_vertex` идёт до
 * `skinnormal_vertex` и до `skinning_vertex`, и обе замены пользуются готовой
 * матрицей — иначе выборок из VAT было бы вдвое больше.
 */
const VERTEX_BASE = /* glsl */ `
	mat4 vatSkin = vatSkinMatrix();
	vSkinLayer = instancePose.w;
	vInstanceFade = instanceFade;
`;

const VERTEX_NORMAL = /* glsl */ `
	objectNormal = ( vatSkin * vec4( objectNormal, 0.0 ) ).xyz;
	#ifdef USE_TANGENT
		objectTangent = ( vatSkin * vec4( objectTangent, 0.0 ) ).xyz;
	#endif
`;

// Матрицы VAT — это `boneWorld × inverseBind` (ASSET-12), то есть привязка уже
// в них: `bindMatrix` детального яруса здесь не нужен и его нет.
const VERTEX_SKINNING = /* glsl */ `
	transformed = ( vatSkin * vec4( transformed, 1.0 ) ).xyz;
`;

function patchVertex(source: string): string {
  return source
    .replace('#include <common>', `#include <common>\n${VERTEX_PRELUDE}`)
    .replace('#include <skinbase_vertex>', VERTEX_BASE)
    .replace('#include <skinnormal_vertex>', VERTEX_NORMAL)
    .replace('#include <skinning_vertex>', VERTEX_SKINNING);
}

/**
 * Выборка карт из массива вариантов. Заменяются ЦЕЛЫЕ chunk'и three (их
 * исходники берутся из `THREE.ShaderChunk` и правятся точечно), а не куски
 * готового кода: `onBeforeCompile` получает шейдер с ещё не раскрытыми
 * `#include`, и искать в нём тело chunk'а нечего.
 */
function patchFragment(source: string, maps: ReadonlySet<VatMapKind>): string {
  // Сэмплеры объявляются В ПРОЛОГЕ, а не на месте chunk'а: chunk'и раскрываются
  // внутри `main()`, а объявление uniform'а там — не GLSL.
  const declarations = ['varying float vSkinLayer;', 'varying float vInstanceFade;'];
  for (const kind of VAT_MAP_KINDS) {
    if (maps.has(kind)) declarations.push(`uniform highp sampler2DArray ${SKIN_UNIFORM[kind]};`);
  }
  let out = source.replace('#include <common>', `#include <common>\n${declarations.join('\n')}`);
  // Fade (FOW-8): альфа фрагмента умножается на долю проявленности записи до
  // альфа-теста — угасание прозрачностью, одинаковое с держателем детального
  // яруса (REND-20).
  out = out.replace(
    '#include <alphamap_fragment>',
    '\tdiffuseColor.a *= vInstanceFade;\n#include <alphamap_fragment>',
  );
  if (maps.has('base')) {
    out = out.replace(
      '#include <map_fragment>',
      arraySampled('map_fragment', 'texture2D( map, vMapUv )', 'vatSkinBase', 'vMapUv'),
    );
  }
  if (maps.has('normal')) {
    out = out.replace(
      '#include <normal_fragment_maps>',
      arraySampled(
        'normal_fragment_maps',
        'texture2D( normalMap, vNormalMapUv )',
        'vatSkinNormal',
        'vNormalMapUv',
      ),
    );
  }
  if (maps.has('emissive')) {
    out = out.replace(
      '#include <emissivemap_fragment>',
      arraySampled(
        'emissivemap_fragment',
        'texture2D( emissiveMap, vEmissiveMapUv )',
        'vatSkinEmissive',
        'vEmissiveMapUv',
      ),
    );
  }
  return out;
}

/** Тело chunk'а three с подменённой выборкой карты на выборку слоя массива. */
function arraySampled(chunk: string, call: string, uniform: string, uv: string): string {
  const body = (THREE.ShaderChunk as unknown as Record<string, string>)[chunk] ?? '';
  return body.split(call).join(`texture( ${uniform}, vec3( ${uv}, vSkinLayer ) )`);
}

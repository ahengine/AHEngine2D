# Skeleton، Bone، IK و Skinning

سیستم اسکلت AH2D بخشی از همان ECS و Scene Graph است؛ Boneها آبجکت موازی یا دادهٔ مخفی نیستند. هر Bone یک Entity با `Transform` محلی و Component از نوع `Bone` است، بنابراین Parent/Child، Prefab، Animation و Runtime همگی روی یک ساختار واحد کار می‌کنند.

## قرارداد Authoring

یک Rig معمولاً این ساختار را دارد:

```text
KnightRig                         Skeleton
└── Hip                          Bone + Transform
    └── UpperLeg                 Bone + Transform
        └── LowerLeg             Bone + Transform
IKFoot                           IK + Transform
KnightMesh                       Skin + Transform + Renderable
```

نمونهٔ فشردهٔ Universal Project نسخهٔ ۴:

```json
{
  "objects": [
    {
      "id": "knight-rig",
      "name": "Knight Rig",
      "components": {
        "Transform": { "x": 320, "y": 240, "rotation": 0, "scaleX": 1, "scaleY": 1 },
        "Skeleton": { "rootBoneId": "hip", "enabled": true, "solveIK": true, "debug": false }
      }
    },
    {
      "id": "hip",
      "name": "Hip",
      "parentId": "knight-rig",
      "components": {
        "Transform": { "x": 0, "y": 0, "rotation": 0, "scaleX": 1, "scaleY": 1 },
        "Bone": { "length": 48, "inheritRotation": true, "inheritScale": true }
      }
    },
    {
      "id": "lower-leg",
      "name": "Lower Leg",
      "parentId": "hip",
      "components": {
        "Transform": { "x": 48, "y": 0, "rotation": 0, "scaleX": 1, "scaleY": 1 },
        "Bone": { "length": 44 }
      }
    },
    {
      "id": "foot-target",
      "name": "Foot Target",
      "components": {
        "Transform": { "x": 378, "y": 315, "rotation": 0, "scaleX": 1, "scaleY": 1 },
        "IK": {
          "skeletonRootId": "knight-rig",
          "bones": ["hip", "lower-leg"],
          "mix": 1,
          "iterations": 16,
          "tolerance": 0.5,
          "enabled": true,
          "bendDirection": 1
        }
      }
    },
    {
      "id": "knight-skin",
      "name": "Knight Skin",
      "components": {
        "Transform": { "x": 320, "y": 240, "rotation": 0, "scaleX": 1, "scaleY": 1 },
        "Renderable": { "assetId": "knight-texture", "visible": true },
        "Skin": {
          "skeletonRootId": "knight-rig",
          "assetId": "knight-texture",
          "vertices": [
            { "x": 0, "y": -12, "weights": [{ "boneId": "hip", "weight": 1 }] },
            { "x": 48, "y": -12, "weights": [{ "boneId": "hip", "weight": 0.5 }, { "boneId": "lower-leg", "weight": 0.5 }] },
            { "x": 92, "y": 12, "weights": [{ "boneId": "lower-leg", "weight": 1 }] }
          ],
          "uvs": [0, 0, 0.5, 0, 1, 1],
          "indices": [0, 1, 2]
        }
      }
    }
  ]
}
```

قواعد مهم:

- `Skeleton.rootBoneId` در صورت وجود باید به یک Bone مستقیم زیر همان Skeleton اشاره کند. هر Skeleton فقط یک Root Bone دارد و traversal در Skeleton تو‌در‌تو متوقف می‌شود؛ هر Bone فقط متعلق به نزدیک‌ترین Skeleton ancestor است.
- Boneهای بعدی باید در Scene Graph به شکل Nested زیر Root Bone باشند. `Transform` هر Bone محلی به Parent است و نوک Bone روی محور محلی X و در فاصلهٔ `length` قرار دارد. `inheritRotation: false` جهت والد و `inheritScale: false` مقیاس والد را از ماتریس world همان Bone حذف می‌کند، اما مبدأ Bone همچنان همراه موقعیت والد حرکت می‌کند.
- `IK.bones` از Parent به Child مرتب است و باید یک زنجیرهٔ پیوسته و بدون تکرار در همان Skeleton باشد. خود Entity دارای IK، Target را با World Position خودش مشخص می‌کند.
- `mix` بین صفر و یک، `iterations` حداقل یک، `tolerance` غیرمنفی و `bendDirection` برابر `1` یا `-1` است.
- رأس‌های `Skin` در فضای محلی Entity دارای Skin ذخیره می‌شوند. هر Weight به Bone همان Skeleton اشاره می‌کند و مجموع Weightهای مثبت هر رأس نباید صفر باشد. Runtime مجموع را normalize می‌کند. اگر UV وجود دارد باید دقیقاً دو مقدار برای هر Vertex داشته باشد؛ Indexها باید داخل محدوده و تعدادشان مضرب سه باشد. Mesh کاملاً خالی معتبر است.
- `Skeleton.pose`، `Skeleton.boneMatrices` و `Skin.deformedVertices` وضعیت مشتق‌شدهٔ Runtime هستند و در Authoring ذخیره نمی‌شوند.

## Bind Pose و Linear Blend Skinning

`engine.load(project)` پس از ساخت کامل Scene Graph و پیش از نمونه‌برداری Animationهای autoplay، Bind Pose را ثبت می‌کند. برای هر Bone ماتریس معکوس Bind فقط در حافظهٔ Runtime نگه‌داری می‌شود. سپس در هر update ترتیب مؤثر چنین است:

```text
Animation sample → Transform update → CCD IK → Transform update
→ Physics → Transform update → CPU linear-blend skinning → Renderer
```

جابجایی Bone یا Target در Runtime، `Skin.deformedVertices` را به‌روز می‌کند. تغییر عمدی topology، Weightها یا Bind Pose باید با `engine.skeleton.rebind()` ثبت شود؛ این API برای «اعمال pose فعلی به‌عنوان bind جدید» است و نباید در حلقهٔ هر frame فراخوانی شود.

```js
engine.load(project);

const bones = engine.skeleton.listBones('knight-rig');
const pose = engine.skeleton.getPose('knight-rig');

engine.transform.setWorld('foot-target', { x: 410, y: 290 });
const result = engine.skeleton.solve('foot-target');
const vertices = engine.skeleton.deform('knight-skin');

engine.skeleton.rebind('knight-skin');
```

`solve()` از CCD دوبعدی استفاده می‌کند و نتیجه شامل Target، End Effector، فاصله، تعداد iteration و زنجیرهٔ واقعی حل‌شده است. `getPose()` یک snapshot قابل‌خواندن از Transform محلی/جهانی، طول و نوک هر Bone می‌دهد. `snapshot()` و `restore()` نیز Bind cache را همراه lifecycle Play/Stop نگه می‌دارند.

## Animation Trackهای Bone و IK

Timeline دو Track built-in جدید دارد:

```json
{
  "tracks": [
    {
      "id": "hip-pose",
      "type": "bone",
      "targetEntityId": "hip",
      "interpolation": "linear",
      "keyframes": [
        { "id": "hip-0", "frame": 0, "value": { "rotation": -12 } },
        { "id": "hip-8", "frame": 8, "value": { "x": 2, "y": -3, "rotation": 18, "scaleX": 1, "scaleY": 1 } }
      ]
    },
    {
      "id": "foot-ik",
      "type": "ik",
      "targetEntityId": "foot-target",
      "interpolation": "linear",
      "keyframes": [
        { "id": "foot-0", "frame": 0, "value": { "x": 360, "y": 310, "mix": 1 } },
        { "id": "foot-8", "frame": 8, "value": { "x": 405, "y": 270, "mix": 0.8 } }
      ]
    }
  ]
}
```

Bone Track می‌تواند هر زیرمجموعه‌ای از `x`، `y`، `rotation`، `scaleX` و `scaleY` را بنویسد. IK Track می‌تواند Position هدف و تنظیمات `mix`، `iterations`، `tolerance`، `enabled` و `bendDirection` را animate کند. هر دو به‌صورت پیش‌فرض linear هستند؛ فیلدهای گسسته در زمان نمونه‌برداری step می‌شوند.

## Editor

در Inspector با `Add Component` می‌توان `Skeleton`، `Bone`، `IK` و `Skin` را افزود. ابزارهای Skeleton Editor ساخت Bone فرزند، اتصال Root، تعریف زنجیرهٔ IK، تولید یک Skin چهاررأسی اولیه از ابعاد Renderable و انتخاب referenceها را روی Entityهای واقعی انجام می‌دهند. Inspector تعداد Vertex/Triangle/Weight را نشان می‌دهد؛ برای topology یا Weight painting پیشرفته، دادهٔ `Skin.vertices` همچنان از طریق قرارداد JSON/CLI قابل ویرایش است. Overlay Animator استخوان، Joint، Target و mesh تغییرشکل‌یافته را نمایش می‌دهد و انتخاب آن با Hierarchy مشترک است. Timeline نیز Bone/IK Track و Key واقعی می‌سازد، بنابراین Save/Undo/Redo و Export Animation همان دادهٔ Universal را استفاده می‌کنند.

## Prefab

Referenceهای داخل Prefab با Source Entity ID ذخیره می‌شوند، نه ID تصادفی یک Instance. هنگام Instantiate، Runtime و validation هر reference را فقط در گروه همان `prefabId + instanceRootId` resolve می‌کنند؛ در نتیجه چند Instance از یک Rig مستقل‌اند. Overrideهای Transform/Bone/IK/Skin از قرارداد عمومی Prefab پیروی می‌کنند. Duplicate/Clone یک Rig، فقط Clipهای وابسته را به‌صورت خصوصی clone و targetها را remap می‌کند؛ Unpack نیز referenceهای Rig را به IDهای concrete همان Instance تبدیل می‌کند، بدون اینکه Instanceهای خواهر یا Clip اصلی تغییر کنند. برای تغییر ساختاری زنجیره، ابتدا Instance را Unpack کنید یا خود Prefab Asset را ویرایش کنید.

## Rendererها

- PixiJS v8، `Skin.vertices/uvs/indices` و `deformedVertices` را به `PIXI.MeshGeometry` و `PIXI.Mesh` واقعی تبدیل و position buffer را همگام می‌کند.
- PhaserJS و Custom Runtime باید `Skin.deformedVertices` را به primitive بومی renderer خود نگاشت کنند. حل Skeleton/IK و CPU skinning همچنان داخل Engine انجام می‌شود و به renderer وابسته نیست.
- اگر Skin دادهٔ mesh کامل ندارد، Bone/IK همچنان کار می‌کند؛ renderer می‌تواند Spriteهای rigid متصل به Boneها را از Scene Graph معمولی نمایش دهد.

## CLI و Validation

Componentها از registry قابل کشف‌اند و برای mutation همان loop امن CLI استفاده می‌شود:

```powershell
npm run ah2d -- schema show --component Skeleton --pretty
npm run ah2d -- schema show --component Bone --pretty
npm run ah2d -- schema show --component IK --pretty
npm run ah2d -- schema show --component Skin --pretty
npm run ah2d -- inspect --file game.ah2d.json --pretty
npm run ah2d -- component put --file game.ah2d.json --scene main rig Skeleton --value '{"rootBoneId":"hip"}' --dry-run --include-document --pretty
npm run ah2d -- component put --file game.ah2d.json --scene main rig Skeleton --value '{"rootBoneId":"hip"}' --write --expect-sha256 <sha256>
npm run ah2d -- validate --file game.ah2d.json --strict --engine --pretty
```

برای چند Entity/Component مرتبط از یک فایل operation و فرمان `apply` استفاده کنید تا Rig ناقص بین writeها روی دیسک نماند. `validateSkeletonDocument()` و `assertSkeletonDocument()` همان invariantهای reference، hierarchy، chain و Weight را برای مصرف برنامه‌ای بررسی می‌کنند.

# Animation Clips and Timeline

Animation در AH2D یک preview نمایشی داخل Editor نیست. Clipهای قابل‌ذخیره در `animations[]` پروژهٔ Universal نسخهٔ ۴ قرار می‌گیرند، Timeline همان داده را ویرایش می‌کند و `AnimationSystem` آن را در Runtime نمونه‌برداری و روی Entityهای هدف اعمال می‌کند.

## قرارداد Authoring

هر Clip، Track و Keyframe یک ID پایدار دارد. زمان Authoring برحسب شمارهٔ frame است و مدت Clip از `frameCount / fps` محاسبه می‌شود:

```json
{
  "animations": [
    {
      "id": "knight-run",
      "name": "Knight Run",
      "fps": 12,
      "frameCount": 12,
      "loop": true,
      "speed": 1,
      "targetEntityId": "knight",
      "tracks": [
        {
          "id": "run-position",
          "type": "position",
          "interpolation": "linear",
          "keyframes": [
            { "id": "run-position-0", "frame": 0, "value": { "x": 0, "y": 0 } },
            { "id": "run-position-6", "frame": 6, "value": { "x": 24, "y": -5 }, "easing": "ease-in-out" }
          ]
        },
        {
          "id": "run-sprite",
          "type": "sprite",
          "interpolation": "step",
          "keyframes": [
            { "id": "run-sprite-0", "frame": 0, "value": { "assetId": "knight-sheet", "frame": 0, "sourceRect": { "x": 0, "y": 0, "width": 32, "height": 32 } } },
            { "id": "run-sprite-1", "frame": 1, "value": { "assetId": "knight-sheet", "frame": 1, "sourceRect": { "x": 32, "y": 0, "width": 32, "height": 32 } } }
          ]
        },
        {
          "id": "run-event",
          "type": "event",
          "interpolation": "step",
          "keyframes": [
            { "id": "run-footstep-4", "frame": 4, "value": { "name": "Footstep", "payload": { "foot": "left" } } }
          ]
        },
        {
          "id": "run-hitbox",
          "type": "hitbox",
          "interpolation": "step",
          "keyframes": [
            { "id": "run-hitbox-0", "frame": 0, "value": { "enabled": false, "colliderId": "attack" } },
            { "id": "run-hitbox-7", "frame": 7, "value": { "enabled": true, "colliderId": "attack", "x": 28, "y": 0, "width": 92, "height": 72 } }
          ]
        }
      ]
    }
  ]
}
```

فیلدهای اصلی Clip عبارت‌اند از:

- `id`: شناسهٔ پایدار برای reference از Component و ابزارها.
- `name`: نام نمایشی که تغییر آن نباید referenceها را بشکند.
- `fps`: تعداد frame در ثانیه و همیشه بزرگ‌تر از صفر.
- `frameCount`: تعداد frameهای Clip و همیشه حداقل یک.
- `loop`: تعیین رفتار انتهای Clip.
- `speed`: ضریب سرعت اختیاری؛ مقدار پیش‌فرض یک است.
- `targetEntityId`: هدف پیش‌فرض اختیاری برای Trackهایی که هدف مستقل ندارند.
- `tracks`: آرایهٔ مرتب Trackها.

هر Track می‌تواند `targetEntityId` خودش را داشته باشد؛ در غیر این صورت از هدف Clip استفاده می‌کند. نوع‌های built-in عبارت‌اند از `sprite`، `position`، `rotation`، `event` و `hitbox`. نوع سفارشی می‌تواند به شکل step نمونه‌برداری و توسط game/runtime host تفسیر شود.

`position` و `rotation` به‌صورت پیش‌فرض `linear` هستند. `sprite`، `event` و `hitbox` به‌صورت `step` ارزیابی می‌شوند. easingهای شناخته‌شده `ease-in`، `ease-out` و `ease-in-out` هستند؛ نبود easing به معنای linear است. Transformهای حاصل، local به `parentId` همان Entity باقی می‌مانند.

در Sprite Track، `keyframe.frame` محل Key روی Timeline است اما `keyframe.value.frame` شمارهٔ frame تصویر داخل Sprite Sheet است. `value.sourceRect` مستطیل دقیق pixel-space با `x`، `y`، `width` و `height` مثبت را مشخص می‌کند. `spriteFrame` فقط alias ورودی قدیمی است؛ داده و Export جدید باید `frame` بنویسند. PixiJS adapter وقتی `sourceRect` وجود دارد همان ناحیه را به‌صورت native در یک subtexture برش می‌دهد. `frame` به‌تنهایی مختصات برش را مشخص نمی‌کند؛ برای چنین Clipی Asset یا host باید متادیتای Sprite Sheet و نگاشت frame به rectangle را فراهم کند. PhaserJS و Runtime سفارشی نگاشت هر دو مقدار به primitive بومی renderer خود را انجام می‌دهند.

### چند Track هم‌نوع و تعیین هدف

قرارداد، چند Track هم‌نوع را تا زمانی که Track IDها یکتا باشند مجاز می‌داند. این قابلیت برای animate کردن چند Entity با یک Clip است:

```json
{
  "targetEntityId": "knight",
  "tracks": [
    { "id": "body-position", "type": "position", "targetEntityId": "body", "keyframes": [] },
    { "id": "weapon-position", "type": "position", "targetEntityId": "weapon", "keyframes": [] }
  ]
}
```

اولویت هدف برای هر sample برابر `track.targetEntityId`، سپس `clip.targetEntityId` و در Runtime در نهایت Entity دارای Component `Animation` است. همهٔ Trackها به ترتیب `tracks[]` نمونه‌برداری می‌شوند و نتیجه در `sample.tracks` باقی می‌ماند؛ `sample.values` نیز با Track ID کلیدگذاری می‌شود، بنابراین Trackهای هم‌نوع یکدیگر را در خروجی sample حذف نمی‌کنند.

اگر چند Position، Rotation یا Sprite Track دقیقاً یک property از یک Entity را بنویسند، Track آخر در آرایه برنده است. Hitbox Trackها تجمیع و Event Trackها همگی dispatch می‌شوند. برای نتیجهٔ قابل‌پیش‌بینی بهتر است برای هر جفت `type + targetEntityId` فقط یک Track نویسنده وجود داشته باشد، مگر این‌که ترتیب overwrite عمداً بخشی از طراحی Clip باشد.

ترتیب Clipها، Trackها و فیلدهای ناشناخته بخشی از دادهٔ پروژه‌اند. Editor، Engine، CLI و Studio bridge باید extensionهای JSON ناشناخته را نگه دارند. state موقت Timeline مانند Clip/Track/Key انتخاب‌شده، playhead و وضعیت Preview در Asset ذخیره نمی‌شود.

## سازگاری با داده‌های قدیمی

`AH2D.normalizeAnimationClip(raw, options)` یک clone canonical می‌سازد و دادهٔ قدیمی `frames` و `events` در ریشه را به `frameCount` و Event Track تبدیل می‌کند. نبود IDهای Clip، Track یا Keyframe نیز هنگام normalize با ID پایدار جایگزین می‌شود. برای پیدا کردن ناسازگاری پیش از write از validation استفاده کنید:

```js
const diagnostics = AH2D.DataModel.validateAnimationDocument(project);
AH2D.DataModel.assertAnimationDocument(project);
```

در validation معمولی، dialect قدیمی warning می‌دهد. validation سخت‌گیرانه legacy ID/referenceها را رد می‌کند:

```text
npm run ah2d -- validate --file game.ah2d.json --strict --engine --pretty
```

Component روی Entity باید با `clipId` به شناسهٔ Clip اشاره کند. `clip` فقط reference قدیمی بر اساس ID یا نام است:

```json
{
  "components": {
    "Animation": {
      "clipId": "knight-run",
      "autoplay": true,
      "speed": 1,
      "loop": true
    }
  }
}
```

فیلدهای Runtime مانند frame جاری، `sampledHitboxes` و `completed` دادهٔ authoring نیستند و در Universal Project به‌عنوان حقیقت ذخیره نمی‌شوند.

## Editor و Timeline

Animator آرایهٔ واقعی `animations[]` را Load می‌کند. انتخاب Clip از Project یا selector، Timeline و Inspector را روی همان Clip قرار می‌دهد. Timeline تعداد frame و Trackهای واقعی را نمایش می‌دهد و از این عملیات پشتیبانی می‌کند:

- ساخت، انتخاب و حذف Clip.
- انتخاب frame با ruler یا Previous/Next.
- Play/Pause بر اساس `fps`، `speed` و `loop` همان Clip.
- انتخاب Track و افزودن Key در playhead.
- انتخاب، جابه‌جایی و حذف Keyframe.
- Preview داده‌محور Position، Rotation، Sprite و Hitbox.
- Onion Skin از نمونهٔ frame قبلی و بعدی.
- Inspector واقعی برای `fps`، `frameCount`، `loop`، `speed` و Keyframe انتخاب‌شده.

API اتوماسیون Editor روی `window.AH2DEditorRuntime.animations` در دسترس است:

```js
const animations = window.AH2DEditorRuntime.animations;

animations.list();
animations.current();
animations.select('knight-run');
animations.setFrame(6);
animations.sample('knight-run', 6);
animations.play();
animations.pause();

const clip = animations.create({ name: 'Knight Attack', fps: 12, frameCount: 8 });
const position = animations.addTrack('position', 'knight');
const key = animations.addKey(position.id, { x: 12, y: 0 }, 3);
animations.removeKey(position.id, key.id);
animations.removeTrack(position.id);
animations.remove(clip.id);
```

تمام mutationهای این API از همان state و Save/Undo pipeline ادیتور استفاده می‌کنند. `Export Animation JSON` کل Clip انتخاب‌شده را با envelope زیر صادر می‌کند و دادهٔ ثابت یا Preview-only تولید نمی‌کند:

```json
{
  "format": "AH2D.Animation",
  "version": 1,
  "id": "knight-run",
  "name": "Knight Run",
  "fps": 12,
  "frameCount": 12,
  "loop": true,
  "tracks": []
}
```

### اتصال Clip به Game Object

ساخت Clip در Animator به‌تنهایی باعث اجرای آن روی Scene نمی‌شود. برای bind کردن:

1. Game Object را در Scene یا Hierarchy انتخاب کنید.
2. در Inspector روی `Add Component` و سپس `Animation` بزنید.
3. Clip را از فیلد `Clip` انتخاب کنید؛ مقدار ذخیره‌شده ID پایدار آن در `Animation.clipId` است.
4. `Autoplay`، `Speed` و `Loop` را برای همان Instance تنظیم کنید. مقدار Speed/Loop روی Component، مقدار Clip را برای آن Entity override می‌کند.
5. پروژه را Save کنید تا Component همراه Scene و Clip همراه `animations[]` ذخیره شود.

در انتخاب چند Game Object، افزودن Animation Component آن را به همهٔ هدف‌های قابل‌ویرایش اضافه می‌کند؛ سپس هر Entity Component مستقل خودش را دارد. تغییر نام Clip، اتصال را نمی‌شکند زیرا binding با `clipId` انجام می‌شود.

دکمهٔ Play داخل Animator فقط Preview همان Clip و Timeline است. برای اجرای واقعی Scene، Runtime را در نوار بالای Editor انتخاب و Play Mode اصلی را شروع کنید. Editor سند Authoring شامل `animations[]` و Componentها را به Engine می‌دهد؛ `autoplay` از اولین update پخش را شروع می‌کند. Pause/Resume ساعت Runtime را کنترل می‌کند و Stop، Transform، Renderable، Physics و state انیمیشن را به snapshot قبل از Play بازمی‌گرداند. تغییرات Runtime به فایل پروژه ذخیره نمی‌شوند.

## Engine API

نمونه‌برداری بدون اجرای clock برای preview، تست و Runtime سفارشی:

```js
const clip = AH2D.normalizeAnimationClip(project.animations[0]);
const atFrame = AH2D.sampleAnimationClip(clip, 6, { unit: 'frame' });
const atTime = AH2D.sampleAnimationClip(clip, 0.5, { unit: 'seconds' });

console.log(atFrame.frame, atFrame.duration, atFrame.tracks, atFrame.values);
```

`sampleAnimationClip` سند را mutate نمی‌کند و نتیجه شامل `clipId`، `time`، frame اعشاری، `frameIndex`، `duration`، نمونهٔ Trackها و map مقدارها بر اساس Track ID است.

برای اجرای واقعی، پروژه را Load و Component را روی Entity اضافه کنید:

```js
const engine = new AH2D.Engine();
engine.load(project);

// اگر Component از قبل clipId دارد:
engine.animation.play('knight');

// یا ساخت/bind و شروع مستقیم در Runtime:
engine.animation.play('enemy', 'knight-run', { fromStart: true });
engine.update(1 / 60);
engine.animation.seek('knight', 6, { unit: 'frame' });
engine.animation.pause('knight');
engine.animation.stop('knight');
```

AnimationSystem clock هر Entity را جداگانه جلو می‌برد، Clip را نمونه‌برداری می‌کند و Trackهای built-in را روی Componentهای Runtime هدف اعمال می‌کند. Position/Rotation روی Transform local، Sprite روی Renderable و Hitbox روی state نمونه‌برداری‌شدهٔ Animation قرار می‌گیرد. Event Track از Event Bus ارسال می‌شود:

```js
const offEvent = engine.events.on('animation:event', ({ entityId, clipId, name, payload, frame }) => {
  playSound(name, payload, frame);
});

const offComplete = engine.events.on('animation:complete', ({ entityId, clipId }) => {
  queueNextAnimation(entityId, clipId);
});
```

رویدادهای کنترل `animation:play`، `animation:pause`، `animation:stop` و `animation:seek` نیز برای مشاهدهٔ lifecycle منتشر می‌شوند. Seek صرفاً pose را ارزیابی می‌کند و eventهای ردشده را مثل playback اجرا نمی‌کند. Playback عادی eventهای عبورکرده را دقیقاً یک بار، از جمله هنگام wrap شدن loop، ارسال می‌کند.

AnimationSystem فیلدهای canonical Sprite را روی `Renderable.frame` و `Renderable.sourceRect` اعمال می‌کند. PixiJS adapter مقدار `sourceRect` را بدون کد اضافهٔ بازی به subtexture بومی تبدیل می‌کند؛ اگر فقط `frame` موجود باشد، Asset یا host باید متادیتای لازم برای تبدیل شمارهٔ frame به rectangle را بدهد. نگاشت Renderable در PhaserJS و Runtime سفارشی host-owned است و Runtime سفارشی می‌تواند Trackهای ناشناخته را نیز از sample مصرف کند. تعریف Clip Authoring نباید در هر frame توسط Runtime mutate شود.

## CLI و تغییر امن پروژه

در CLI فعلی Animation Clip یک resource در `animations` است. ابتدا schema را کشف و پروژه را inspect کنید، سپس mutation را با hash انجام دهید:

```text
npm run ah2d -- schema show --name animationClip --pretty
npm run ah2d -- inspect --file game.ah2d.json --pretty
npm run ah2d -- resource put --file game.ah2d.json animations @walk.clip.json --dry-run --include-document --pretty
npm run ah2d -- resource put --file game.ah2d.json animations @walk.clip.json --write --expect-sha256 <sha256>
npm run ah2d -- validate --file game.ah2d.json --strict --engine --pretty
```

برای چند تغییر مرتبط از فرمان `patch` یا operation `resource.put` در یک `apply` اتمیک استفاده کنید. CLI validation، referenceهای `Animation.clipId`، Entityهای هدف، IDهای تکراری، محدودهٔ frame و payloadهای built-in را بررسی می‌کند. `Engine.export()` snapshot فعال نسخهٔ ۳ است و نباید جای Universal Project نسخهٔ ۴ را بگیرد.

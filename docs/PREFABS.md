# Prefab Assets, Instances, Overrides, and Unpack

Prefab در AH2D یک کپی تصویری یا یک flag ساده نیست. تعریف قابل‌استفادهٔ مجدد در `prefabs[]` ذخیره می‌شود و هر Instance به‌صورت Entityهای واقعی و expandشده داخل Scene حضور دارد. به همین دلیل Renderer، Physics، Scene Graph و Runtimeهای مختلف بدون دسترسی به Asset definition نیز همان Scene فعال را اجرا می‌کنند.

## قرارداد Authoring

Universal Project نسخهٔ ۴ منبع حقیقت است:

```json
{
  "prefabs": [
    {
      "id": "crate-prefab",
      "name": "Crate",
      "rootEntityId": "crate-root",
      "revision": 3,
      "entities": [
        {
          "id": "crate-root",
          "name": "Crate",
          "parentId": null,
          "components": {
            "Transform": { "x": 0, "y": 0, "rotation": 0, "scaleX": 1, "scaleY": 1 }
          }
        },
        {
          "id": "crate-label",
          "name": "Label",
          "parentId": "crate-root",
          "components": {
            "Transform": { "x": 0, "y": -18, "rotation": 0, "scaleX": 1, "scaleY": 1 }
          }
        }
      ]
    }
  ]
}
```

`rootEntityId` باید یکی از Entityهای همان Asset باشد، root داخل definition نباید `parentId` داشته باشد و تمام Entityهای definition باید از آن root قابل‌دسترسی باشند. IDهای source درون Asset پایدارند و برای اتصال memberهای Instance استفاده می‌شوند. `revision` با تغییر definition یا Apply شدن Override افزایش پیدا می‌کند.

فیلد قدیمی top-level به نام `prefab` فقط آینهٔ workspace سازگار با Editorهای قبلی است و definition canonical محسوب نمی‌شود. ابزارهای جدید `prefabs` را authoritative می‌دانند و دادهٔ قدیمی یا فیلدهای ناشناخته را بدون migration صریح حذف نمی‌کنند.

## Instance expandشده

Instantiate تمام source Entityها را در Scene clone می‌کند، IDهای تازه می‌سازد و `parentId`های داخلی را remap می‌کند. هر member یک Component canonical دارد:

```json
{
  "components": {
    "PrefabInstance": {
      "prefabId": "crate-prefab",
      "sourceEntityId": "crate-label",
      "instanceRootId": "crate-2",
      "prefabRevision": 3,
      "overrides": {}
    }
  }
}
```

تمام memberهای یک Instance، `prefabId` و `instanceRootId` یکسان و `sourceEntityId` یکتا دارند. Instance ناقص، source گمشده، mapping تکراری، parent اشتباه و reference به Asset حذف‌شده در validation رد می‌شود.
`prefabRevision` برای هر member متصل اجباری است و همهٔ memberهای یک Instance باید مقدار یکسان داشته باشند. Instance قدیمی هنگام load به‌عنوان stale گزارش می‌شود و تا sync کامل، Applyهای Asset نباید بخشی از آن را به revision جدید ارتقا دهند.

Transform کامل root و `parentId` خارجی آن placement مربوط به همان Instance هستند؛ با sync شدن Asset بازنویسی نمی‌شوند و Override به حساب نمی‌آیند. Transform فرزندها بخشی از definition است و می‌تواند Override شود.

ساختار داخلی یک Instance متصل قابل‌تغییر نیست. برای add/remove/reparent کردن memberهای آن ابتدا Instance را Unpack کنید، یا definition را ویرایش و Asset را Update کنید. این نسخه از قرارداد structural override و nested Prefab Asset را پشتیبانی نمی‌کند.

## Override

کلید هر Override یک JSON Pointer استاندارد RFC 6901 نسبت به همان Entity است. مقدار، operation صریح دارد تا حذف property با مقدار واقعی `null` اشتباه نشود:

```json
{
  "overrides": {
    "/color": { "op": "replace", "value": "#ff8844" },
    "/components/Health/temporary": { "op": "remove" },
    "/components/Stats/armor": { "op": "add", "value": 12 }
  }
}
```

Operation مجاز `add`، `replace` و `remove` است. انتخاب `add` یا `replace` بر اساس وجود مسیر در source Asset انجام می‌شود، نه بر اساس وضعیت فعلی Instance. مسیرهای `id`، `parentId`، `prefab` و `components.PrefabInstance` محافظت‌شده‌اند. مسیر Transform روی root نیز placement است و به‌عنوان Override پذیرفته نمی‌شود.

رفتارهای lifecycle:

- **Revert** مقدار source را دوباره روی Instance می‌نویسد، یا propertyای را که در source وجود ندارد حذف می‌کند، سپس record را پاک می‌کند.
- **Apply** operation ذخیره‌شده را روی Asset اعمال می‌کند، revision را افزایش می‌دهد و Instanceهای دیگر را sync می‌کند؛ مسیرهایی که در آن Instance Override مستقل و هم‌پوشان دارند دست‌نخورده می‌مانند.
- **Unpack** فقط Component اتصال `PrefabInstance` را از تمام memberهای همان Instance حذف می‌کند. Entityها، hierarchy، Transform، Renderable، Collider و سایر داده‌های Scene عیناً باقی می‌مانند.
- **Delete Asset** در حضور Instance متصل به‌صورت پیش‌فرض رد می‌شود. حالت صریح unpack-and-delete ابتدا اتصال‌ها را حذف می‌کند و سپس definition را پاک می‌کند.

هنگام تغییر یک شاخهٔ والد، Override فرزند rebased می‌شود. اگر Asset والد لازم را حذف یا به نوع ناسازگار تبدیل کند، Editor/Engine شاخهٔ مؤثر قبلی را به یک Override معتبر روی همان والد ارتقا می‌دهد. در آرایه‌ها نیز حذف index، pointerهای indexهای بعدی را جابه‌جا می‌کند؛ Override روی خود element حذف‌شده به مالکیت یک شاخهٔ قابل‌بازسازی ارتقا پیدا می‌کند.

## Editor

در پنل Project، Prefab Asset را می‌توان باز کرد یا روی Scene انداخت. Inspector برای Instance متصل نام Asset، revision و تعداد Overrideها را نشان می‌دهد و Apply، Revert و Unpack را ارائه می‌کند. ساخت Prefab از یک Game Object، کل subtree آن را capture می‌کند و همان subtree موجود را به نخستین Instance متصل تبدیل می‌کند؛ ظاهر Scene تغییر نمی‌کند.

تغییر fieldهای قابل‌ویرایش Instance به‌صورت Override ثبت می‌شود. hierarchy یک Instance متصل تا قبل از Unpack ساختار definition را حفظ می‌کند. Save، Load، Multi-Scene و Studio bridge آرایهٔ `prefabs` و markerهای Scene را همراه فیلدهای ناشناخته نگه می‌دارند.

## Engine API

```js
const engine = new AH2D.Engine();
engine.load(project);

const asset = engine.prefabs.createAsset('crate', {
  id: 'crate-prefab',
  name: 'Crate'
});

const instance = engine.prefabs.instantiate(asset.id, {
  rootId: 'crate-2',
  parentId: 'props',
  transform: { x: 480, y: 240 }
});

engine.prefabs.setOverride('crate-2-label', '/color', '#ff8844');
console.log(engine.prefabs.getInstance('crate-2-label'));

engine.prefabs.revert('crate-2-label', '/color');
engine.prefabs.setOverride('crate-2-label', '/color', '#22cc88');
engine.prefabs.apply('crate-2-label', { paths: ['/color'] });
engine.prefabs.unpack(instance.instanceRootId);
```

APIهای read عبارت‌اند از `list()`، `get(prefabId)` و `getInstance(entityId)`. حذف definition با `deleteAsset(prefabId)` انجام می‌شود و `{ unpackInstances: true }` حالت صریح حفظ Entityهای Scene است. همهٔ mutationها سند Universal، آینهٔ Scene فعال و ECS Runtime را اتمیک sync و سپس validate می‌کنند.

رویدادهای lifecycle عبارت‌اند از `prefab:assetCreate`، `prefab:assetDelete`، `prefab:instantiate`، `prefab:override`، `prefab:revert`، `prefab:apply` و `prefab:unpack`.

## CLI

طبق قرارداد معمول CLI ابتدا hash را با `inspect` بخوانید، Dry Run کنید و هنگام write همان hash را با `--expect-sha256` برگردانید:

```text
npm run ah2d -- inspect --file game.ah2d.json --pretty
npm run ah2d -- prefab asset create --file game.ah2d.json --scene main --entity crate --id crate-prefab --name Crate --dry-run --include-document --pretty
npm run ah2d -- prefab asset create --file game.ah2d.json --scene main --entity crate --id crate-prefab --write --expect-sha256 <sha256>

npm run ah2d -- prefab instantiate --file game.ah2d.json --scene main crate-prefab --id crate-2 --x 480 --y 240 --write --expect-sha256 <sha256>
npm run ah2d -- prefab override set --file game.ah2d.json --scene main crate-2-label --path /color --value '"#ff8844"' --write --expect-sha256 <sha256>
npm run ah2d -- prefab override inspect --file game.ah2d.json --scene main crate-2 --all --pretty
npm run ah2d -- prefab override apply --file game.ah2d.json --scene main crate-2 --all --write --expect-sha256 <sha256>
npm run ah2d -- prefab unpack --file game.ah2d.json --scene main crate-2 --write --expect-sha256 <sha256>
```

برای چند تغییر مرتبط از operationهای `prefab.asset.create`، `prefab.asset.update`، `prefab.asset.delete`، `prefab.instantiate`، `prefab.override.set`، `prefab.override.apply`، `prefab.override.revert` و `prefab.unpack` در یک `apply` اتمیک استفاده کنید. فهرست دقیق optionها و مثال‌های update/delete در [`../engine/CLI.md`](../engine/CLI.md) قرار دارد.

## Validation و سازگاری

```text
npm run ah2d -- validate --file game.ah2d.json --strict --engine --pretty
```

Validation عادی legacy markerهای ناقص را برای read سازگار نگه می‌دارد، اما lifecycle marker متصل باید `prefabId`، `sourceEntityId`، `instanceRootId` و `prefabRevision` داشته باشد. Instance هم‌revision باید دقیقاً از Asset + Overrideها قابل‌بازسازی باشد؛ فقط Transform کامل root و parent خارجی از این مقایسه مستثنا هستند. Strict validation operation قدیمی `set` یا override خام بدون record canonical را رد می‌کند. برای اصلاح قرارداد از فرمان‌های Prefab استفاده کنید؛ نوشتن مستقیم `resource put` اتصال Instanceها و sync revision را انجام نمی‌دهد.

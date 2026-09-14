# پروژه‌های لوکال در AH2D Editor

صفحهٔ اصلی AH2D یک Editor تحت‌وب local-first است. هیچ launcher یا database برای فهرست پروژه‌های UI وجود ندارد: کاربر در شروع `Open Project` یا `New Project` را انتخاب می‌کند و بعد Editor تمام صفحه باز می‌شود.

## قرارداد پوشه

ساختار canonical پروژهٔ جدید:

```text
My-Game/
└── project.ah2d.json
```

`project.ah2d.json` همان Universal Project نسخهٔ ۴ و منبع حقیقت Authoring است. assetهای تصویری فعلی به‌صورت Data URL داخل همین سند قرار دارند. ابزارهای CLI می‌توانند روی همین فایل کار کنند؛ پیش از mutation از `inspect` و `--expect-sha256` استفاده کنید.

هنگام Open، Editor به این ترتیب فایل را پیدا می‌کند:

1. `project.ah2d.json`
2. `AH2D_Project.json` یا `AH2DProject.json`
3. `<نام پوشه>.ah2d.json`
4. تنها فایل `*.ah2d.json` موجود در ریشه
5. تنها JSON ریشه که واقعاً قرارداد AH2D را دارد

اگر چند manifest هم‌ارز وجود داشته باشد، عملیات متوقف می‌شود تا فایل اشتباهی overwrite نشود.

## Open Project

در مرورگرهای Chromium، `Open Project` از `showDirectoryPicker({ mode: "readwrite" })` استفاده می‌کند. handle فقط در حافظهٔ همان tab می‌ماند؛ path مطلق سیستم نه به سرور ارسال می‌شود و نه در JSON ذخیره می‌شود. بستن tab باعث می‌شود در اجرای بعد دوباره پوشه را انتخاب کنید.

فایل قبل از load از نظر JSON، `format: "AH2D"`، نسخهٔ پشتیبانی‌شده و وجود Scene بررسی می‌شود. validation کامل Scene Graph/Prefab داخل Editor sandboxed انجام می‌شود و تا دریافت ACK موفق، پروژهٔ فعلی عوض نمی‌شود.

## New Project

پس از واردکردن نام، کاربر پوشهٔ والد را انتخاب می‌کند. AH2D یک نام امن تک‌بخشی می‌سازد، پوشه را ایجاد می‌کند و template را از قرارداد رسمی `AH2DProject.createProject()` می‌گیرد. پروژهٔ جدید شامل Universal v4، descriptor واحد ECS، Scene اصلی، PixiJS، Box2D و Post Processهای پیش‌فرض قابل‌ویرایش است.

اگر پوشه‌ای با همان نام از قبل وجود داشته باشد، New Project آن را reuse یا overwrite نمی‌کند؛ باید از Open Project یا نام دیگری استفاده شود.

## Save و تغییر بیرونی

پیام‌های `AH2D_PROJECT_CHANGED` به مدت کوتاه debounce و writeها به‌ترتیب serialize می‌شوند. `Ctrl/Cmd + S`، App Menu → Save Project و Save Scene یک snapshot معتبر می‌گیرند و صف را فوراً flush می‌کنند. در حالت hosted این فرمان‌ها دیگر به storage داخلی iframe نمی‌روند.

پیش از هر write، متن فایل روی دیسک با آخرین متنی که Editor خوانده/نوشته مقایسه می‌شود. اگر CLI، Agent یا برنامهٔ دیگری فایل را عوض کرده باشد:

- `Reload disk`: تغییرات بیرونی را بارگذاری و draft ذخیره‌نشدهٔ فعلی را کنار می‌گذارد.
- `Overwrite`: با تصمیم صریح کاربر snapshot فعلی Editor را می‌نویسد.

هنگام وجود write حل‌نشده، خروج از صفحه هشدار مرورگر ایجاد می‌کند.

## پشتیبانی مرورگر

دسترسی مستقیم به پوشه به secure context و File System Access API نیاز دارد. `http://localhost` secure محسوب می‌شود؛ برای host شبکه‌ای از HTTPS استفاده کنید. Chrome و Edge جدید مسیر اصلی‌اند.

در مرورگر فاقد این API:

- Open از `<input type="file">` استفاده می‌کند.
- New و Save فایل `.ah2d.json` را دانلود می‌کنند.
- مرورگر اجازهٔ overwrite مستقیم فایل اولیه را نمی‌دهد و UI حالت `Download mode` را نمایش می‌دهد.

این fallback عمداً path یا permission جعلی شبیه‌سازی نمی‌کند.

## مرز امنیتی Editor

File picker فقط در parent Next.js اجرا می‌شود. خود Editor داخل iframe بدون `allow-same-origin` و با CSP محدود باقی می‌ماند. ارتباط با marker پروتکل، `event.source` دقیق و origin موردانتظار کنترل می‌شود؛ handle فایل هرگز وارد iframe یا API سرور نمی‌شود.

// پنل رو از src/web/panel.part*.html می‌سازه و به‌صورت ماژول JS در src/web/ui.generated.js می‌نویسه
// (تا هم Wrangler و هم Node بدون تنظیم اضافه ازش استفاده کنن). بعد از هر تغییر در panel.part*.html اجرا کن:
//   node scripts/build-ui.mjs
import fs from "node:fs";
const dir = new URL("../src/web/", import.meta.url);
const html = ["panel.part1.html", "panel.part2.html", "panel.part3.html"].map((f) => fs.readFileSync(new URL(f, dir), "utf8")).join("");
fs.writeFileSync(new URL("panel.html", dir), html);
fs.writeFileSync(new URL("ui.generated.js", dir), `// فایل خودکار — ویرایش نکن؛ از scripts/build-ui.mjs ساخته میشه\nexport default ${JSON.stringify(html)};\n`);
console.log("ui.generated.js:", (html.length / 1024).toFixed(1), "KB");

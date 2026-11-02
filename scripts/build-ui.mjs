// ساخت فایل‌های خودکار (بعد از هر تغییر در src/web/*.html یا schema.sql اجرا کن):
//   node scripts/build-ui.mjs
//  - src/web/ui.generated.js       ← پنل وب  (panel.part1/2/3.html)
//  - src/web/install.generated.js  ← ویزارد /install (panel.part1.html + install.part.html)
//  - src/web/schema.generated.js   ← دستورهای schema.sql (برای ساخت جدول‌ها توسط ویزارد روی D1)
import fs from "node:fs";
const dir = new URL("../src/web/", import.meta.url);
const read = (f) => fs.readFileSync(new URL(f, dir), "utf8");
const w = (f, s) => fs.writeFileSync(new URL(f, dir), s);
const head = "// فایل خودکار — ویرایش نکن؛ از scripts/build-ui.mjs ساخته میشه\n";

const panel = ["panel.part1.html", "panel.part2.html", "panel.part3.html"].map(read).join("");
w("ui.generated.js", `${head}export default ${JSON.stringify(panel)};\n`);

const install = read("install.part.html"); // ویزارد مستقل (طراحی و CSS خودش رو داره)
w("install.generated.js", `${head}export default ${JSON.stringify(install)};\n`);

const schema = fs.readFileSync(new URL("../schema.sql", import.meta.url), "utf8")
  .replace(/--[^\n]*/g, "")
  .split(";")
  .map((s) => s.trim())
  .filter(Boolean);
w("schema.generated.js", `${head}export default ${JSON.stringify(schema, null, 1)};\n`);
console.log(`ui ${(panel.length / 1024).toFixed(1)}KB · install ${(install.length / 1024).toFixed(1)}KB · schema ${schema.length} statements`);

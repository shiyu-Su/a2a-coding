import { readFileSync } from "node:fs";
const files = [
  "doc/v0.10.4/项目池手动刷新-需求确认单.md",
  "doc/v0.10.4/项目池手动刷新-改造文档.md",
  "doc/v0.10.4/板卡片呈现统一-需求确认单.md",
  "doc/v0.10.4/板卡片呈现统一-改造文档.md",
];
for (const f of files) {
  try {
    const s = readFileSync(f, "utf8");
    const head = s.split("\n").slice(0, 12).join("\n");
    console.log("=".repeat(20), f);
    console.log(head);
    console.log("---- 含 c35b4192/项目池 字样:", s.includes("c35b4192"), s.includes("项目池"));
    console.log();
  } catch (e) { console.log(f, "读取失败:", e.message); }
}

// ESLint flat config（REQ-v0.2.0-2026-09-13-06，machine 单元）。
//
// 仅启用 `@typescript-eslint/no-explicit-any`（error）作为「禁 any」的防回归基线；
// 末尾 `eslint-config-prettier` 关闭与 Prettier 冲突的格式类规则。
// 范围：本单元 `.ts` 与 `.mjs`（scripts 下 4 个验证脚本）；忽略 node_modules / dist /
// agents / .a2a / data（后三者为运行态产物或生成目录）。
import tseslint from "typescript-eslint";
import eslintConfigPrettier from "eslint-config-prettier";

export default tseslint.config(
  {
    ignores: [
      "node_modules/**",
      "dist/**",
      "agents/**",
      ".a2a/**",
      "data/**",
      ".omo/**",
      ".codegraph/**",
      "reports/**",
    ],
  },
  {
    files: ["**/*.ts"],
    extends: [...tseslint.configs.recommended],
    rules: {
      "@typescript-eslint/no-explicit-any": "error",
      // 允许以 `_` 前缀标记「有意未使用」（如 Express 错误处理签名 `(_req, _res, next)`）
      "@typescript-eslint/no-unused-vars": [
        "error",
        { argsIgnorePattern: "^_", varsIgnorePattern: "^_" },
      ],
    },
  },
  {
    files: ["**/*.mjs"],
    languageOptions: {
      ecmaVersion: "latest",
      sourceType: "module",
    },
  },
  eslintConfigPrettier,
);

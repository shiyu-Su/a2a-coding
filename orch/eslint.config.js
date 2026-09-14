// ESLint flat config（orch 单元）。
//
// 依赖：eslint + typescript-eslint（recommended 规则集）+ eslint-config-prettier（消除与
// Prettier 的规则冲突）。核心约束规则 `@typescript-eslint/no-explicit-any` 显式置为 error。
// 仅本单元配置，不使用仓库根共享基线。
import tseslint from "typescript-eslint";
import eslintConfigPrettier from "eslint-config-prettier";

export default tseslint.config(
  {
    // 非源码目录（依赖 / 构建产物 / 运行态产物 / 工具缓存）不参与 lint
    ignores: ["node_modules/**", "dist/**", "data/**", ".a2a/**", ".codegraph/**", ".omo/**"],
  },
  ...tseslint.configs.recommended,
  eslintConfigPrettier,
  {
    rules: {
      "@typescript-eslint/no-explicit-any": "error",
    },
  },
);

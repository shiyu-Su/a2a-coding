# Changelog — {ORG_NAME}

> **模板来源**：a2a-coding 板侧资产 `board/templates/org/CHANGELOG.template.md` → 生成到组织目录根的 `CHANGELOG.md`。
> **本文件只在发版流程中写**（`flow/spec/需求流程.md` §8）；需求进行中不动它 —— 过程记录归 `doc/{版本}/` 与 `planlog.md`。

本项目的所有重要变更都记录在此文件。格式参考 [Keep a Changelog](https://keepachangelog.com/zh-CN/1.1.0/)，版本号遵循 [语义化版本](https://semver.org/lang/zh-CN/)。

---

## [v{版本号}] - {YYYY-MM-DD}

> 主题：**{本版一句话主题}**（{N} 条需求：`REQ-v{版本号}-{YYYY-MM-DD}-01` …；均经用户 Step 3 验收、改造文档标 final）。

### Added

- **{新增能力}**（{涉及成员项目 / 模块}）：{做了什么、给谁用}。

### Changed

- **{行为或口径变更}**：{变更前 → 变更后，以及为什么}。

### Removed

- 无退役面。（或：**{退役项}** —— {替代方案}。）

### 版本待办收口

| 需求 | REQ-ID | 结论 |
|---|---|---|
| {需求一句话} | `REQ-v{版本号}-{YYYY-MM-DD}-XX` | ✅ 通过（{验收要点}） |

> 遗留与未覆盖验证项见发版时的 `planlog.md`；各需求的完整方案与修订历史见 `doc/v{版本号}/`。

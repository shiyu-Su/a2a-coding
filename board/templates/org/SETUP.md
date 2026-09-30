# SETUP —— 组织目录手工铺设（V1）

> **适用**：板上建组织（V2）**尚未交付**时的备法。V2 交付后由板按**同一份清单**（`README.md` §2）渲染复制，本文档退役为参考。
> **前提认知**：本步骤全程**只影响你新建的那一个目录 + 一份 orch 配置的 `projectGroups` 段**，不动任何代码仓、不动 `flow/` 本体。
> **命令形态**：以下用 Git Bash（Windows）。PowerShell 版把 `cp` 换 `Copy-Item`、`mkdir -p` 换 `New-Item -Force`，语义一致。

---

## 0. 前置条件（全部满足才开始）

| # | 条件 | 怎么验 |
|---|---|---|
| 0.1 | 编排桥常驻在跑，MCP 端口 **8787** 与只读工作台 **3300** 可达 | `curl -s http://127.0.0.1:3300/health` 返回 JSON（含 `version`） |
| 0.2 | 目标宿主 CLI（`{HOST_KIND}`，缺省 `claude`）已装且**凭据可用** | 直接跑一次该 CLI 的最小非交互调用能出结果 |
| 0.3 | 能读到 a2a-coding 仓（模板来源 `board/templates/org/`、规范来源 `flow/`、脚本来源 `scripts/` 三样都在里面）；**跨机场景见 `README.md` §5 疑点 1** | `ls <repo>/flow/spec` |
| 0.4 | 成员项目已在**执行机**登记（machine 配置的 `projects[]`）且其 `machineId` 在 orch 配置的 `machines[]` 里 | 查两份配置；**新增 project 需重启 Launcher**，且重启会把该机在飞任务判失败 ⇒ 择时做 |

---

## 1. 定组织名与成员项目

- **做什么**：选定 `{ORG_NAME}`（= 组名 = MCP URL 首段 = 目录名，一名三用）与 `{ORG_MEMBER_PROJECTS}`。
- **命令**（把 `V` 换成你选的名字后校验，不是校验 `{ORG_NAME}` 这个占位符本身）：
  ```bash
  V=<候选组织名>; echo "$V" | grep -Eq '^[A-Za-z0-9_-]+$' && echo "字符集 OK" || echo "字符集非法"
  echo "$V" | grep -Eq '^(health|shutdown|runner)$' && echo "撞保留首段，换一个" || echo "首段 OK"
  ```
- **预期结果 / 硬判据**：两行都出 `OK` 分支；
  - 不与 `orch/config/config.json` 里**已有组名重名**（重名 = 同一身份，视野混叠）；
  - 每个成员项都是 `<machineId>/<projectId>` 且**未被其它组占用**（组间成员互斥）；
  - **组织名一旦定了不要改**：改名要动 `features.owner_group`，历史需求会在新旧两个身份下都推不动（`README.md` §5、改造文档 §2.2-2「不改名」）。

## 2. 建目录

- **前置**：路径无空格（避免 Windows quoting 坑）、不在任何代码仓工作树内。
- **命令**：`ORG=/c/orgs/{ORG_NAME}; mkdir -p "$ORG" && cd "$ORG" && pwd`
- **预期结果**：空目录已存在，`pwd` 打印的绝对路径记下来 —— 它就是后续板/宿主配置里的 `workspace`。

## 3. 复制 `flow/`（10 文件，规范单一事实源）

- **前置**：0.3。
- **命令**：
  ```bash
  REPO=<a2a-coding 仓根>
  git -C "$REPO" ls-files flow > /tmp/flow-list.txt && wc -l < /tmp/flow-list.txt   # 必须是 10
  ( cd "$REPO" && while IFS= read -r f; do mkdir -p "$ORG/$(dirname "$f")"; cp "$f" "$ORG/$f"; done < /tmp/flow-list.txt )
  ```
- **为什么按清单拷、不整目录拷**：工作树里的 `flow/` 除 10 个包文件外，还混有 `.a2a/` `.codegraph/` `.omo/` 等**开发副产物**，整目录拷会一起带进组织。
- **预期结果**：`find "$ORG/flow" -type f | wc -l` = **10**；`head -3 "$ORG/flow/README.md"` 打出**规范版本戳**（形如 `v0.9.0（2026-09-24）`）—— 把这个字符串原样用于下一步的 `{FLOW_SPEC_STAMP}`，**不要凭记忆填**。
- **`flow/spec/` 三份规范**（`需求流程.md` / `引擎映射.md` / `文档模板.md`）都在这 10 个文件里：板上建组织（V2）由 `src/org-seed.ts` 只把**这三份**快照落 `<组织目录>/flow/spec/`（`hosts/` `install/` 不播），本步是 V1 人工全量口径。

## 4. 从模板生成四份文档

- **前置**：第 3 步已拿到版本戳字符串。
- **命令**：
  ```bash
  TPL="$REPO/board/templates/org"
  cp "$TPL/AGENTS.template.md"    "$ORG/AGENTS.md"
  cp "$TPL/CLAUDE.template.md"    "$ORG/CLAUDE.md"
  cp "$TPL/planlog.template.md"   "$ORG/planlog.md"
  cp "$TPL/CHANGELOG.template.md" "$ORG/CHANGELOG.md"

  ORG_ID=<第 1 步定下的组织名>
  MEMBERS='<machineId>/<projectId>'        # 多成员自行拼（如用「 · 」分隔）
  HOST=<claude|opencode|qoder-cn|codex>    # 缺省 claude
  STAMP=$(grep -m1 '规范版本戳' "$ORG/flow/README.md" | sed 's/.*：//')   # 从副本读，不凭记忆
  cd "$ORG"
  sed -i "s|{ORG_NAME}|$ORG_ID|g"                        AGENTS.md CLAUDE.md planlog.md CHANGELOG.md
  sed -i "s|{ORG_MEMBER_PROJECTS}|$MEMBERS|g"            AGENTS.md CLAUDE.md
  sed -i "s|{HOST_KIND}|$HOST|g"                         AGENTS.md CLAUDE.md
  sed -i "s|{FLOW_SPEC_STAMP}|$STAMP|g"                  AGENTS.md
  sed -i "s|{CURRENT_VERSION}|0.1.0|g; s|{CREATED_AT}|$(date +%F)|g" planlog.md
  ```
- **预期结果**：`echo "$STAMP"` 打出与 `flow/README.md` 顶部一致的版本戳；四文件存在；**渲染键零残留**：
  ```bash
  grep -rn "{ORG_NAME}\|{ORG_MEMBER_PROJECTS}\|{HOST_KIND}\|{FLOW_SPEC_STAMP}\|{CURRENT_VERSION}\|{CREATED_AT}" . | grep -v '^\./\.git/'
  ```
  → **无输出**（退出码 1 = 正常）。残留的其它 `{...}`（如 `{topic}`、`{YYYY-MM-DD}`）是**使用期占位**，留着，不是漏替换。
- **禁止**：拿 a2a-coding 仓根的 `AGENTS.md` / `CLAUDE.md` 当模板复制 —— 那份含**本仓开发纪律**（单元路径守卫 / 版本号同升 / 宿主角色），会误导组织宿主（`README.md` §2「明确不放」）。

## 5. 建 `doc/`

- **命令**：`mkdir -p "$ORG/doc"`
- **预期结果**：空目录。内容**不在铺设阶段生成** —— Step 0/1 才由 agent 写 `doc/{版本}/{topic}-需求确认单.md` / `-改造文档.md`（**先读组织内第 3 步拷入的 `flow/spec/文档模板.md` 对应节、按模板骨架成文**）。
- 注：本清单**不含** `doc/_templates/`（§2.2-8 无此项；`README.md` §5 疑点 2 已 closed —— 模板权威源就是 `flow/spec/文档模板.md`，组织内已可达）。

## 6. 拷等待脚本

- **命令**：
  ```bash
  mkdir -p "$ORG/scripts"
  cp "$REPO/scripts/watch-feature.mjs" "$REPO/scripts/watch-task.mjs" "$ORG/scripts/"
  node "$ORG/scripts/watch-task.mjs" --help >/dev/null; echo "exit=$?"
  ```
- **预期结果**：`exit=0`。**只要这两个脚本**（仓根的 `watch-feature-loud.mjs` 是排障变体，不属清单）。
- **承重口径**：两脚本缺省打 **`http://127.0.0.1:3300`**（可 `--base` / `WATCH_BASE_URL` 覆盖）⇒ **3300 必须保持可用**，否则组织的等待纪律整条失效。跨机时须显式指到桥所在机 reachable 的地址。

## 7. 在编排桥配置登记项目组

- **前置**：第 1 步的校验结论；改配置前**先备份**。
- **命令 / 改法**：在 `$REPO/orch/config/config.json` 的 `projectGroups` 数组**追加一项**（结构 = `{ name, members: [{ machineId, projectId }] }`，`members` 非空，`name` = 第 4 步的 `$ORG_ID`）：
  ```bash
  cp "$REPO/orch/config/config.json" "$REPO/orch/config/config.json.bak-$(date +%F)"
  # 手工编辑那一项后校验：
  node -e "JSON.parse(require('fs').readFileSync(process.argv[1],'utf8')); console.log('json ok')" "$REPO/orch/config/config.json"
  ```
- **预期结果**：`json ok`；**无需重启桥** —— `projectGroups` / `machines` 每请求现读（改组即时生效）。生效探针见第 9 步。
- **失败回滚**：校验不过 ⇒ 立刻 `cp` 回 `.bak`，别带着坏 JSON 起服务。

## 8. `git init` + `.gitignore` + 首提交（一组织一仓）

- **命令**：
  ```bash
  cd "$ORG" && git init -b main
  printf '.a2a/\nnode_modules/\n*.log\n.DS_Store\nThumbs.db\n' > .gitignore
  git add -A && git -c user.name="<who>" -c user.email="<who@example>" commit -m "init org workspace: $ORG_ID"
  ```
- **预期结果**：`git log --oneline` 一行初始提交；`git status` 干净；**`.a2a/` 未被跟踪**（运行时自动落、须可写、已在 ignore）。
- 说明：`.gitignore` **没有模板文件**（§2.2-8 无此项，`README.md` §5 疑点 3），故内容在此内联给出。

## 9. 宿主接 MCP（V1 手工；V2 由板注入）

- **做什么**：把本组织的 MCP 端点注册进**宿主自己的配置**（宿主配置文件因 `agentKind` 而异，形态见 `flow/hosts/*.md`）：`http://<编排桥地址>:8787/$ORG_ID/mcp`
- **硬要求**：**URL 必须带组名首段** —— 写成 `/mcp` 在无组环境下是「全量入口」，在配组环境下被 **403** 拒；写成别的组名 = 以别组身份工作。
- **⚠ 这份配置不写进组织目录**（不进 `$ORG`、不进 `AGENTS.md`）—— 由板注入，落在这里就是第二份真相。
- **cwd 恒为该组织目录**：宿主会话的工作目录必须就是 `$ORG`，否则 `AGENTS.md` 不加载、`flow/` 与 `scripts/` 相对路径全断。
- **预期结果**：宿主里 `a2a_projects()` 返回**恰好等于**第 1 步的成员项目集合（多一个或少一个都是配置错）。

## 10. 铺设验收（五条探针，全过才算铺完）

| # | 探针 | 预期 |
|---|---|---|
| 1 | 目录内容清点：`ls -1 "$ORG"` | `AGENTS.md` `CLAUDE.md` `CHANGELOG.md` `planlog.md` `doc` `flow` `scripts` `.gitignore`（**不多不少**；无代码仓、无 MCP 配置） |
| 2 | `grep -c "flow/spec/需求流程.md" "$ORG/AGENTS.md"` | ≥ 1（规范是**指向** `flow/`，不是复制全文） |
| 3 | `find "$ORG/flow" -type f \| wc -l` | `10` |
| 4 | 宿主内 `a2a_projects()` | 只列成员项目 |
| 5 | 端到端一轮：板上（或手工以该组身份）`a2a_feature_create` 一条测试需求 → `a2a_feature_status` 看到 `owner_group = {ORG_NAME}` → `a2a_feature_cancel` 收掉 | 三步全通 ⇒ 身份链与写口都通 |

## 11. 常见坑（都实际踩过或在规范里被点名）

- **组织目录里放了代码仓** → 违背 §2.2-8 与 S7「组织目录 = 编排工作区」；代码改动只能经派落在成员项目落地。
- **拿本仓 `AGENTS.md` 当模板** → 把单元路径守卫、版本同升等**本仓开发纪律**带进组织，宿主会照做而误伤。
- **改了 `{ORG_NAME}` 里的一处在别处没改** → 一名三用 ⇒ 目录名 / 组名 / MCP 首段任一不一致都会 fail-closed（`project_not_a_member` / `feature_unowned`）。
- **`{FLOW_SPEC_STAMP}` 凭记忆填** → 该值必须与拷来的 `flow/README.md` 顶部一致，否则副本过期不可见。
- **3300 没在跑就交付** → 等待脚本全部退 `1`，宿主会退回手工轮询（规范明令禁止的形态）。
- **新增成员项目随手重启 Launcher** → 重启会把该执行机在飞任务判失败（0.4 已提示择时）。

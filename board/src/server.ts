/**
 * board HTTP 服务（BD1 骨架 + BD3 只读视图 + BD7 写面 + BD8 宿主面 + BD9 确认/回答入口 + v0.9.2 M3 排期写）—— **只绑 loopback**、零框架（`node:http`）。
 *
 * 路由：
 * - `GET /health`          —— 板自身健康（保留 BD1 行为）；
 * - `GET /`                —— **组织门户首页**（v0.9.4 §9-b · 首页形态 B→A）：
 *   组织卡列表（口径 = 台账未停用 ∪ 需求归属 ownerGroup，与顶栏切换器共用同一纯函数
 *   `orgs-view.portalOrgNames`）· 每卡 = 组织名 + 排期中/需求/任务计数摘要（`getFeatures()` 派生，
 *   **零新触桥面**）+ 卡头链进 `/org/<名>/` 空间；建组织 = 页头「＋ 建组织」按钮（服务端 `hidden`，
 *   无 JS 不显死按钮）+ `<dialog id="new-org-dialog">` 弹窗（§9.5：写口仍 `POST /orgs`，服务端零改动；
 *   无 JS 回退 = 正文 `#new-org-inline` 内联表单）；旧首页（排期看板）深链者落本页为可接受代价，不做 303；
 * - `GET /requirements`    —— **303 重定向回 `/`**（REQ-2026-09-26-04 Q2：需求列表页退役，旧地址深链兼容；
 *   与下 `POST /requirements` **同路径双义已终结** —— GET 恒重定向、不触桥，POST 仍建需求）；
 * - `GET /schedule`        —— **303 重定向回门户**（v0.9.6 B5a：全局排期看板整页退役，旧地址深链兼容；
 *   非 GET ⇒ 405）。看板正文单点 {@link renderScheduleBoard} 保留，唯一调用方 = 组织空间排期页
 *   `/org/<名>/schedule`（列并集 / 需求池末列 / 四枚白名单脚本 / 页头「＋ 新增需求」「＋ 新版本」都在那一页）；
 * - `GET /features/:id`    —— 需求详情 + 任务 + trace 三面 + 「触发一轮」+「阶段产出」（BD11；
 *   REQ-v0.9.2 按需求归约：该区由本需求 `decisions` 登记驱动，与旧「产出登记」合并为单区，版本目录清单作废）；
 * - `GET /features/:id/docs?file=<name>[&src=A|B][&mode=render|raw]` —— **单文档内容**（BD11 读文档面）：
 *   `text/plain` 原文直出，
 *   浏览器 `Accept: text/html` ⇒ 整页；**BD14 双档**：缺省 `render`（markdown 子集渲染 + mermaid 占位），
 *   `mode=raw` ⇒ 现行 `<pre>` 原文视图原样保留；版本 / 归属取自桥侧详情（不接受调用方传版本），
 *   守卫全在 `docs-read.ts`（四件套），失败 404 / 400 **不泄根路径**；
 *   **BD13 补源 B**：`src` 未指定（缺省源 A）且源 A 未命中 ⇒ 自动回落源 B（回落同样逐守卫过一遍，
 *   命中即停；两源同名 ⇒ 源 A 优先，实际来源经响应头 `X-Docs-Source` 与页面标注透出，不歧义）；
 * - `GET /static/<名>`      —— **vendored 静态资产**（BD14，mermaid.min.js）：文件名 = 白名单闭集
 *   （`docs-render.VENDORED_ASSETS`），白名单外 / 缺文件 ⇒ 404，不做目录遍历；同源脚本加载经
 *   CSP `script-src 'self'` 放行（板 CSP 首次放宽，理由见 layout.ts 注释）；
 * - `GET /tasks`           —— **已退役（v0.9.6 C1 · B5c：全局任务裸页下架）⇒ 303 回门户**；
 *   **深链存活例外**：`GET /tasks?project=X`（X 非空）⇒ 200 任务表（退役判据 = pathname ∧ query，
 *   `views.ts` 的 `org===null ∧ 带 project` 渲染分支保留）；非 GET ⇒ 405（同退役先例）；
 *   空间任务页 `/org/<名>/tasks`（含其选单档）不受影响；
 *   **C3 补（v0.9.6）**：深链任务表页头加「所属组织：X」标注（声明面 `GET /api/groups` 命中；
 *   未命中 ⇒「无归属组织」；声明面不可判定 ⇒ 不渲该行；不臆造默认组）；
 * - `GET /projects`        —— 项目 / 机器视图（桥 `/api/projects`）；
 * - `GET /orgs`            —— **已退役（v0.9.4 §9-c · REQ-2026-09-27-06 N3）⇒ 303 回门户 `/`**：
 *   原 REQ-v0.9.2 N6 只读「组织视角」页 + v0.9.4 A5/BD2 管理页整体下架 —— 看 = 门户 `/` 与空间三页
 *   （`/org/<名>/` · `/features` · `/tasks`），管理 = **`GET /org/<名>/manage`**（成员清单 + 增删表单 +
 *   停用操作 + 本组需求 / 项目表）。**写口一条都没动**：`POST /orgs`（建 / 停用）与 `POST /orgs/:org/members`
 *   仍按原契约服务，表单 action 用全局路径（归一层不扩写路由变体）；
 * - `GET /agents`          —— **Agent View（机器与在飞）**（REQ-2026-09-26-02 B-T3，只读）：
 *   ① 机器表 = 桥 `/api/projects` 的 `runners` ∪ `machines` 归并（online/lastHeartbeatAt，无 runner 登记 ⇒ 未知）；
 *   ② 在飞任务区 = **逐 project 并发** `GET /api/tasks`（照 N6 模式：单项超时 `AGENT_QUERY_TIMEOUT_MS`、
 *   失败该项目灰化「不可达 ≠ 没有在飞」不炸页），按 `claimedAt` 升序、缺键沉底；
 *   ③ 页头 = **3300 页面退役后桥 identity/version 的唯一承载位**（`GET <mcpBaseUrl>/health` 的
 *   status/role/pid/startedAt/version，逐键容错、来源如实标注）；
 *   ④ 页脚口径行 = `AGENT_VIEW_CALIBRATION_NOTE`（闸内排队 orch 不可见、两个时钟不得相加）。
 *   零写、零缓存、零新增存储；
 * - `GET /host`            —— **宿主桥状态页**（本板进程托管的桥：五态 + 结构化错误 + 轮队列）；
 * - `POST /requirements`            —— 提需求（BD7 接线 · BD11 组织名进表单 · v0.9.2 M6 `version` 去必填，留空 = 未排期 ·
 *   **v0.9.2 增补 ⑤ N2**：`form.version` 命中**版本台账 released 条目**（已发版锁版）⇒ **409 `board_version_released`**
 *   零出网 + 表单字段回填；空 version（未排期）不参与锁判；
 *   **v0.9.4 N4 semver 收口（§2.5）**：非空 `version` 必须命中 `x.y.z`（可带 `v` 前缀，复用 `parseVersion`），
 *   否则封装抛 `RequirementConfigError` ⇒ **400 `requirement_form_invalid`** 零出网 + 回填；空 version 照旧放行）；
 *   **REQ-2026-09-26-04 Q2 起为提需求的唯一入口**（契约不变）：表单宿主 = `/schedule` 弹窗（§9-b 起首页是门户，
 *   不再承载提需求；`NEW_REQUIREMENT_DIALOG_SCRIPT` fetch 提交），
 *   无 JS / fetch 失效时弹窗内表单仍走原生整页 POST；成功 303 跳详情页的既有口径原样保留；
 * - `POST /features/:id/turn`       —— 触发一轮（BD8，起桥 + 发轮，**不等排队轮**；该需求已有在飞 /
 *   排队轮 ⇒ **409 `board_turn_busy`** 不重复入队 —— 收口轨 14 服务端防重，confirm / answer 同；
 *   需求已入**引擎终态** ⇒ **409 `board_feature_terminal`** 直接拒单不烧轮 —— 收口轨 16 ③，三入口同）；
 * - `POST /host/:org/stop`          —— 停桥（BD8，与上两条同规格受写面守卫）；
 * - `POST /features/:id/confirm`    —— 人工确认指令（BD9，**投消息给 agent**：由 agent 核对后自行执行 approve，板不批准）；
 * - `POST /features/:id/answer`     —— 澄清回答（BD9，仅当最新轮 `awaiting_answer` ⇒ 同 `contextId` 续推）；
 * - `POST /features/:id/schedule`   —— 排期写（v0.9.2 M3，唯一放开的登记字段 `version` 写）：表单 `version` **必须显式传**
 *   （空串 = 删除排期；服务端发送前 `trim()`；**v0.9.4 N4 semver 收口**：非空必须 `x.y.z`，
 *   否则封装抛 `FeatureScheduleConfigError` ⇒ **400 `schedule_request_invalid`** 零出网），
 *   身份 = 该 Feature 的 `ownerGroup`（**null ⇒ 结构化 503，绝不回落板级默认组**），
 *   `to` = 先 `getFeature` 取当前态再经 `feature-schedule.ts` 封装走 advance「`to` = 当前态」特例；
 *   **已发版锁（v0.9.2 增补 ⑤ N3）**：现版本 ∉ 锁版 ∧ 目标 ∈ 锁版（入锁）或 现 ∈ 锁版 ∧ 目标 ≠ 现（出锁，含清空）
 *   ⇒ 409 `board_version_released` 零出网；同锁版无变化 ⇒ 幂等放行；
 *   **双条件状态闸（v0.9.3 B-T5）**：排期改动仅 `stage=需求分析 ∧ approval=未发起`（想法挪版）可写
 *   ⇒ 否则 409 `board_schedule_state_locked` 零出网（与已发版锁**叠加、互不替代**；同版重提两闸均豁免）；
 *   **改版自动善后（v0.9.3 B-T6）**：version 确实改动 ∧ decisions 含 `doc/{旧版}/` 登记 ⇒ 服务端受限 mv
 *   搬文档至 `doc/{新版}/` + 第二跳 advance 追加 decisions 新路径（仅源 A、仅登记路径、幂等；见 `docs-move.ts`）；
 *   读-写窗口态漂移被桥拒 ⇒ 如实弹错误浮层 + 表单值回填，**不自动重试**；
 * - `POST /orgs`                    —— **组织写（v0.9.4 A 档 · BD1 建 + BD3 停用，一条路由靠 `action` 分流）**：
 *   板侧组织台账 `.data/orgs.json` 的本地写（**不触桥、不写状态机、不写 machine 配置**；ownerGroup 不是板可写数据）；
 *   · **建（缺省 / `action=create`）**：CSRF 同规格 → 组织名单一纯函数校验（`write-guard.validateOrgName`，字符集闭集）
 *     → `diagnoseOrgsDir` 根存在性前置闸（**根不代建**，未配置/不可用 ⇒ 503）→ 三源重名闸（盘枚举 ∪ 在用台账 ∪ 需求
 *     ownerGroup，命中 ⇒ 409 `board_org_exists`；桥不可读 ⇒ fail-closed 502 不建；**已停用名豁免**⇒同名重建 = 复活）
 *     → 台账原子写 → **建组织即建目录** `<orgsDir>/<组织>`（v0.9.4 §9-a：幂等单级、根不代建；建不出来 ⇒ 503
 *     `board_org_dir_create_failed`）；成功 = PRG 303 回 `/orgs` / JSON 档 201；
 *   · **停用（`action=disable` · A3「删除」）**：CSRF → 同名校验 → **前置闸：名下有活跃宿主桥 ⇒ 409 `board_org_has_active_bridge`
 *     + 引导「先逐桥 stop 再删」（绝不隐式连带停桥）**→ 台账 `disabledAt` 标记（**不物理删目录**，幂等）；成功 = PRG 303 / JSON 200；
 *     停用组织随后不起桥（`orgBridgeConfig` A4 闸）、不可提新需求（`handleWriteRequirement` 409 `board_org_disabled`）；
 *   · 动作值不在闭集 ⇒ 400 `board_org_action_invalid`（不猜动作）；
 * - `POST /orgs/:org/members`      —— **成员写（v0.9.4 B 档 · BD4，一条路由靠 `action` 分「增 / 删」）**：
 *   唯一通路 = 板第三个 MCP 写封装 `group-admin.ts` 以组身份调 O1 的受控写工具（配置面组写）
 *   （**板绝不直写 orch/config.json**；桥不可达 ⇒ 502 结构化报错 + 引导，不降级本地直写）；
 *   CSRF 同规格 → URL 段组织名单一纯函数校验 → `action` **必须显式**（闭集 add/remove，越界 400
 *   `board_member_action_invalid`）+ 成员对非空（否则 400 `board_member_pair_missing`）；
 *   错误映射：闭集六元 → 422/409/500（`config_write_group_not_found` 走保守文案），非闭集码 → 502；
 *   **§9-a 兜底**：`add` 撞组不存在 ⇒ 封装内自动改发一次 `group.add`（建组带同一成员条目），成功即当成功
 *   （回执 `groupCreated: true`）；`remove` 不兜底（仍 409 保守文案），兜底自身失败 ⇒ 如实上报、不级联；
 *   `config_write_concurrent_modification` ⇒ 封装内**单次自动重读重试**；成功回执带 `backedUpTo`（仅展示）
 *   与加成员的 G11 驻留引导（新 project 仍须人工重启 Launcher）；
 * - `POST /shutdown`                —— **优雅停机（BD13″，仅 loopback 来源）**：200 仅代表「受理」；
 *   不经 CSRF 写面守卫（它是运维停机口，不是业务写面），来源门 = `socket.remoteAddress` 必须 loopback，
 *   非 loopback 一律 403 `loopback_only`（负向用例钉住）。
 *
 * **方法门**：读面仅 GET；写面只放开上面十条业务路径（白名单 = `write-guard.parseWriteRoute`）+
 * `/shutdown` 一条运维路径（本文件内处理），其余路径的非 GET 一律 405。写端点另受 CSRF 守卫（自定义头或同源 Origin/Referer，见 `write-guard.ts`）。
 * 板**不写状态机迁移**：approve / cancel 与「advance 到非当前态」的主链推进均无路径（确认与回答都只是给宿主 agent 的一轮消息，推进归 agent）；唯一放开的是 `version` 排期写（经 `feature-schedule.ts` 用 advance「`to` = 当前态」特例，M3 已接线 `POST /features/:id/schedule`）。
 *
 * **组织名（BD11）**：由**提需求表单**给出（= MCP URL 首段 = 组织目录名，身份链 S1）；配置文件
 * `config.json` 的 `group` 只是**可选默认**（表单未填才生效，BD12″ 起无 argv/env 通道）。两者皆空 ⇒
 * **请求期**结构化 400 `board_group_required`（**启动期不报错、不猜、不回落兜底组名**）。
 *
 * 读面对桥只发起 GET（经 `bridge-client`）；不推事件游标、不写配置。**BD11 起读面另有一条本地读路径**
 * （`/features/:id/docs` → `docs-read.ts`，纯读、守卫四件套、失败不泄根）。
 * 桥不可达 ⇒ 页面如实显示读取失败（502），**不得静默**。
 * 宿主桥故障（起不来 / 连不上 / 中途消失）⇒ 状态页与触发响应一律显示「宿主桥已断」+ 结构化错误码。
 *
 * **错误呈现（REQ-v0.9.1-2026-09-25-03 弹窗化）**：结构化错误出口按 `wantsJson` 分流 ——
 * `Accept: application/json` ⇒ JSON 形状 `{ok:false,code,error}` 逐字节不变；表单档（浏览器提交）⇒
 * 同状态码渲染整页 + 错误浮层（`errorPage`：族名标题中文映射 + error 正文 + mono 错误码 +「知道了」）。
 * `/shutdown`（运维口，板 UI 无表单）与既有 HTML 出口（宿主轮结果页 / 停桥提示 / 桥宕整页）不在分流范围。
 */
import { createServer, type Server, type IncomingMessage, type ServerResponse } from "node:http";
import { mkdirSync, readFileSync } from "node:fs";
import { join } from "node:path";
import {
  createBridgeClient,
  createEngineVersionsFetcher,
  DEFAULT_BRIDGE_BASE_URL,
  type AcceptanceView,
  type BridgeClient,
  type BridgeClientOptions,
  type EngineVersionsFetcher,
  type EngineVersionsProjection,
  type FeatureListItem,
  type ProjectVersionsField,
  type ProjectsView,
  projectVersionsOf,
} from "./bridge-client.js";
import { dispositionHttpStatus, terminalTurnRejection, diagnoseOrgsDir, ORGS_DIR_NOT_CONFIGURED, ORG_DISABLED, type BoardHostFace, type TriggerTurnOutcome } from "./host-face.js";
import {
  deriveChainStateLine,
  deriveTurnProgress,
  isTerminalFeatureState,
  type ChainStateSnapshot,
  type NextStepInput,
  type NextStepTaskCounts,
} from "./derive.js";
import {
  createRequirement,
  DEFAULT_MCP_BASE_URL,
  RequirementConfigError,
  type CreateRequirementOptions,
  type CreateRequirementOutcome,
} from "./requirement.js";
import {
  scheduleFeature,
  type ScheduleAdvanceInput,
  type ScheduleFeatureOptions,
  type ScheduleOutcome,
  FeatureScheduleConfigError,
} from "./feature-schedule.js";
import {
  checkWriteAuth,
  findOrgNameConflict,
  parseOrgForm,
  parseMemberForm,
  parseRequirementForm,
  parseScheduleForm,
  parseTurnForm,
  parseVersionActionForm,
  parseSuspendForm,
  parseWriteRoute,
  validateOrgName,
  WRITE_ROUTES,
  MAX_REQUIREMENT_BODY_BYTES,
  ORG_EXISTS_CODE,
  ORG_ACTION_DISABLE,
  ORG_ACTION_SET_HOST_AGENT,
  parseOrgHostAgentForm,
  MEMBER_ACTION_ADD,
  VERSION_ACTION_CREATE,
  VERSION_ACTION_REMOVE,
  VERSION_ACTION_SET_STATUS,
  VERSION_FORM_INVALID_CODE,
  SUSPEND_TURN_MISMATCH_CODE,
  ScheduleFormProgrammingError,
  type OrgNameConflictSource,
} from "./write-guard.js";
import {
  writeGroupMembersWithRetry,
  releaseOrgGroup,
  describeMemberWriteFailure,
  describeMemberGroupConflict,
  ownerOrgOfProject,
  DUPLICATE_MEMBER_CODE,
  memberActionToOp,
  removesLastGroupMember,
  LAST_MEMBER_REMOVE_CODE,
  LAST_MEMBER_REMOVE_DISPLAY,
  MEMBER_ADD_RESIDENCY_NOTE,
  type MemberConflictDisplay,
  type MemberWriteAttempt,
  type GroupMemberWriteInput,
  type GroupMemberWriteOutcome,
  type GroupMemberWriteOptions,
} from "./group-admin.js";
import { OrgsLedgerStore, defaultOrgsLedgerFile, enabledOrgNames, findOrgRecord, ledgerOrgNames, disabledOrgNames, isOrgDisabled } from "./orgs-ledger.js";
import { VersionsLedgerStore, defaultVersionsLedgerFile, ledgerVersionNames, releasedVersionNames, type VersionsLedger } from "./versions-ledger.js";
import { createVersionsWriteClient, describeVersionWriteError, type VersionsWriteClient } from "./versions-write.js";
import { SuspendLedgerStore, defaultSuspendLedgerFile, type SuspendedEntry } from "./suspend-ledger.js";
import { statDirKind } from "./host-runtime.js";
import { readVersion } from "./version.js";
import { isVersionLocked } from "./version-status.js";
import { normalizeVersion } from "./version-order.js";
import { defaultRepoRoot, readDoc, type DocsSource } from "./docs-read.js";
import { docsMoveRegistrations, executeDocsMove, planDocsMove, type DocsMoveResult } from "./docs-move.js";
import { defaultStaticRoot, findVendoredAsset, VENDORED_ASSETS, MERMAID_ASSET, mermaidAssetScriptTag, mermaidRenderScript, vendoredAssetExists } from "./docs-render.js";
import { renderDependencyGraphSection } from "./graph-view.js";
import {
  computeProjectPool,
  createOrgGroupsFetcher,
  createOrgProjectsFetcher,
  featuresOfOrg,
  listOrgDirs,
  portalOrgNames,
  poolRowsFromSnapshot,
  type GroupRow,
  type OrgGroupsFetcher,
  type OrgGroupsOutcome,
  type OrgProjectsFetcher,
  type OrgProjectsOutcome,
  type ProjectSnapshotOutcome,
} from "./orgs-view.js";
import {
  ORG_SPACE_GONE_CODE,
  ORG_SPACE_NOT_FOUND_CODE,
  resolveOrgSpaceRoute,
  orgSpaceLink,
  orgSpaceUniverseOf,
  type OrgSpaceRoute,
  type OrgSpaceView,
} from "./org-space.js";
import {
  backfillOrgWorkspaces,
  resolveOrgSeedOptions,
  seedOrgWorkspace,
  summarizeSeedResults,
  type OrgSeedOptions,
  type OrgSeedWarning,
  type ResolvedOrgSeedOptions,
} from "./org-seed.js";
import type { AgentsPageInput, OrgsDirStatus } from "./web/views.js";
import { deriveScheduleGateOpen } from "./derive.js";
import {
  buildInflightModel,
  buildMachineRows,
  createAgentTasksFetcher,
  createBridgeIdentityFetcher,
  type AgentTasksFetcher,
  type AgentTasksOutcome,
  type BridgeIdentityFetcher,
} from "./agent-view.js";
import { timestampPrefix } from "./log.js";
import {
  BOARD_CSP,
  BOARD_REFERRER_POLICY,
  escapeHtml,
  renderPage,
  FEATURE_DETAIL_OVERLAY_SCRIPT,
  NEW_REQUIREMENT_DIALOG_SCRIPT,
  DRAG_SCHEDULE_SCRIPT,
  MEMBER_DRAG_SCRIPT,
  type ErrorOverlayField,
  type ErrorOverlayParams,
  type NavKey,
  type PageOrgNav,
} from "./web/layout.js";
import {
  BRIDGE_UNREACHABLE_CODE,
  VIEW_NOTES,
  buildOrgPortalCards,
  errorFamilyLabel,
  groupFeaturesByVersion,
  projectionLedgerOf,
  projectionVersionNames,
  renderAcceptanceSection,
  renderActionArea,
  renderAgentsPage,
  renderAnswerForm,
  renderFeatureDetail,
  renderHostNotice,
  renderChainStateLine,
  renderMemberWriteCard,
  renderHostPage,
  renderNewRequirementDialog,
  renderNewVersionDialog,
  renderOrgPortal,
  renderNextStepGuide,
  renderOrgSpaceManagePage,
  renderProjects,
  renderDocPage,
  renderProjectVersionsBlock,
  renderSchedule,
  renderTasks,
  renderTasksPick,
  renderTurnOutcome,
  renderTurnProgress,
  renderTurnTrace,
  registeredDecisionDocFiles,
  selectRequirementPool,
  stopBridgeErrorOverlay,
  type TasksPreviewInput,
  turnOutcomeErrorOverlay,
} from "./web/views.js";

export interface BoardServerHandle {
  readonly host: string;
  readonly port: number;
  close(): Promise<void>;
  /**
   * **v0.9.5 C8 · T8**：本服务持有的 suspended 台账实例（内存为事实源）。
   * 装配层（`index.ts`）用它驱动心跳的挂起条目扫描与去重位写入 —— **单进程单实例**，不另建第二份。
   */
  readonly suspendLedger: SuspendLedgerStore;
}

export interface CreateBoardServerOptions {
  host: string;
  port: number;
  /** 桥客户端注入（测试用）；缺省按 `bridge` 选项建只读客户端 */
  client?: BridgeClient;
  /** 缺省客户端的桥基址等参数 */
  bridge?: BridgeClientOptions;
  /** 渲染时刻源（测试可固定，用于「已等待」单时钟计算） */
  now?: () => number;
  /**
   * **板级默认组织**（可选默认，BD11 起降级）：仅在**提需求表单未填组织名**时生效。
   * `undefined` / `null` / 空白 = 未配置 ⇒ **不是错误**，板照常起、写面照常可用；
   * 此时表单的组织名成为必填（缺失 ⇒ 请求期结构化 400 `board_group_required`，**不猜不回落**）。
   * 它同时是宿主面「桥侧无 `ownerGroup`」时的回退组织名（S1 身份链）。
   */
  defaultGroup?: string | null;
  /** 写面 MCP 端点基址，缺省 {@link DEFAULT_MCP_BASE_URL} */
  mcpBaseUrl?: string;
  /** `createRequirement` 注入（测试离线自证）；缺省用 `requirement.js` 的实现 */
  createRequirementImpl?: (
    input: Parameters<typeof createRequirement>[0],
    options: CreateRequirementOptions,
  ) => Promise<CreateRequirementOutcome>;
  /**
   * `scheduleFeature` 注入（测试离线自证，v0.9.2 M3）；缺省用 `feature-schedule.js` 的实现。
   * 排期写 = 板唯一放开的登记字段写，仍**只经该单一封装**触达 MCP advance 特例。
   */
  scheduleFeatureImpl?: (
    input: ScheduleAdvanceInput,
    options: ScheduleFeatureOptions,
  ) => Promise<ScheduleOutcome>;
  /**
   * **成员写注入**（测试离线自证，v0.9.4 B 档 / BD4）；缺省用 `group-admin.js` 的实现
   * （含 `config_write_concurrent_modification` 的**单次**自动重读重试）。
   * 成员写的唯一通路 = 经该封装调 O1 受控写工具；板**没有**任何「直写 orch/config.json」的实现，
   * 故本注入点不可省略、也不可回落 —— 桥不可达时写口如实结构化报错。
   */
  groupMemberWriteImpl?: (
    input: GroupMemberWriteInput,
    options: GroupMemberWriteOptions,
  ) => Promise<MemberWriteAttempt>;
  /**
   * **停用释放成员写注入**（v0.9.4 增补五 §9.4-①）：缺省用 `group-admin.js` 的 {@link releaseOrgGroup}
   * （`group.remove` + 组段本不存在的幂等放行）。停用与成员写同源：唯一通路 = 经该封装调 O1 受控写工具，
   * 板**没有**「直写 orch/config.json」的实现，本注入点不可省略、也不可回落（桥不可达 ⇒ 停用整体失败）。
   */
  releaseOrgGroupImpl?: (
    input: { groupName: string },
    options: GroupMemberWriteOptions,
  ) => Promise<GroupMemberWriteOutcome>;
  /**
   * **版本台账写口注入**（v0.10.0 B2 · 改造文档 §2.1(2) / §2.3(2)）。缺省用 `versions-write.js` 的
   * {@link createVersionsWriteClient}（打 `mcpBaseUrl` = 引擎可写面 `/api/versions*`）。
   * 三处写面（建 / 删 / 设状态）**只经本客户端向引擎发意图**；板**无本地下沉兜底写** ——
   * 引擎不可达即硬失败，注入点不可省略、也不可回落。
   */
  versionsWriteImpl?: VersionsWriteClient;
  /**
   * **版本台账读投影注入**（v0.10.0 B4 · 改造文档 §2.3(1)）：已发版锁的**唯一数据源**。
   * 缺省 = 按 `mcpBaseUrl`（引擎可写面）打 `GET /api/versions`；测试注入假端点。
   * 读不到投影 ⇒ 写口 **fail-closed 挡排期写**（503），**不回落本地台账、绝不当作「零个已发版」**；
   * 读面（版本列 / 详情页锁样式）用**本进程最后一次成功投影**（锁只紧不松）。
   */
  engineVersionsFetcher?: EngineVersionsFetcher;
  /**
   * **宿主面**（BD8）：触发一轮 / 桥状态 / 停桥的唯一入口，缺省 `null` ⇒ 宿主面不可用
   * （`GET /host` 如实显示「未装配」，写端点结构化 503 `host_face_disabled`，**不假数据**）。
   * 名字与 `host`（绑定地址）区分 —— 绑定地址仍是 `host: string`。
   */
  hostFace?: BoardHostFace | null;
  /**
   * **优雅停机回调**（BD13″）：`POST /shutdown` 命中 loopback 来源时，先回 200（= 仅「受理」），
   * 再经 `setImmediate` 调用本回调（响应不被停机路径的 close 截断）。未注入 ⇒ 返回 501
   * `shutdown_unsupported`（服务未接停机链，不假装受理）。
   */
  onShutdown?: () => void;
  /**
   * **读文档面根**（BD11 · REQ-v0.9.1-2026-09-25-04）：`repoRoot` = 主仓根（源 A），
   * `orgsDir` = 组织目录根（源 B，`<orgsDir>/<org>/doc/`；未配置 ⇒ `null` ⇒ 只剩源 A）。
   * 缺省 = 按模块位置推导的板根上一级 + 无 orgsDir（目录不存在时按空清单降级，不报错）。
   */
  docs?: { repoRoot: string; orgsDir: string | null };
  /**
   * **vendored 静态资产目录**（BD14）：`GET /static/<名>` 的文件名闭集见 `docs-render.VENDORED_ASSETS`。
   * 缺省 = 模块旁 `src/web/static/`（仅服务白名单文件，不做目录遍历）。
   */
  staticRoot?: string;
  /**
   * **组织空间管理页的逐组项目查询器**（REQ-v0.9.2 N6 · §9-c 起宿主页 = manage）：只读 MCP 调用
   * （`a2a_projects`，组身份 = 组织名）。缺省 = 按写面同基址（`mcpBaseUrl`）经 `mcp-client.ts` 真查；
   * 测试注入假桥。`null` ⇒ 不查询，项目区如实显示「未查询」（不编造数据）。
   */
  orgProjectsFetcher?: OrgProjectsFetcher | null;
  /**
   * **组织空间管理页的全组枚举查询器**（v0.9.4 C 档 · BD5）：只读 `GET <3300>/api/groups`
   * （orch 组结构**声明面** = manage 页成员清单的事实源）。缺省 = 按读面桥基址（config
   * `bridgeUrl`）真查；测试注入假端点。`null` ⇒ 不查询，成员区如实显示「未查询」。
   */
  orgGroupsFetcher?: OrgGroupsFetcher | null;
  /**
   * **Agent View 页的逐项目在飞任务查询器**（v0.9.3 B-T3）：只读桥单查 `GET /api/tasks?project=…`
   * （并发 + 单项超时，失败该项目灰化）。缺省 = 按板侧桥客户端同基址真查；测试注入假桥。
   * `null` ⇒ 不查询，全部项目按「不可达」灰化（如实降级，不编造「没有在飞」）。
   */
  agentTasksFetcher?: AgentTasksFetcher | null;
  /**
   * **Agent View 页头桥身份查询器**（v0.9.3 B-T3 · G3 收编）：只读 `GET <mcpBaseUrl>/health`
   * 取 role / pid / startedAt / version（3300 页面退役后的唯一承载位）。缺省 = 按写面同基址真查；
   * 测试注入假端点。`null` ⇒ 不查询，页头如实标「未查询」（不编造身份）。
   */
  bridgeIdentityFetcher?: BridgeIdentityFetcher | null;
  /**
   * **组织台账文件**（v0.9.4 A1）：缺省 `<板 cwd>/.data/orgs.json`（`.data/` 已 gitignore）；
   * 测试注入 tmp 路径离线自证。建组织写口只动本文件（原子写），不写任何配置。
   */
  orgsLedgerFile?: string;
  /**
   * **版本台账文件**（v0.9.4 N1 · REQ-2026-09-27-05）：缺省 `<板 cwd>/.data/versions.json`
   * （`.data/` 已 gitignore）；测试注入 tmp 路径离线自证。`POST /versions` 写口只动本文件。
   */
  versionsLedgerFile?: string;
  /**
   * **suspended 台账文件**（v0.9.5 C7 · T7）：缺省 `<板 cwd>/.data/suspended.json`（`.data/` 已 gitignore）；
   * 测试注入 tmp 路径离线自证。⚠ **内存为事实源、启动即清空重写**，本文件仅供崩溃取证。
   */
  suspendLedgerFile?: string;
  /**
   * **suspended 台账实例注入**（v0.9.5 C8 · T8）：提供 ⇒ 直接复用该实例（**单进程单实例**），
   * 使装配层（`index.ts` 的心跳）与服务共用**同一份**内存台账；缺省 ⇒ 按 `suspendLedgerFile` 新建。
   */
  suspendLedgerStore?: SuspendLedgerStore;
  /**
   * **组织种子化注入面**（v0.9.5 C10 · REQ-2026-09-28-09）：建组织链（`POST /orgs`）落 `AGENTS.md`
   * + `flow/spec` 快照，并在 **listen 前**做幂等回填。
   * - **省略 / null ⇒ 不种子化**（既有行为逐字节不变；既有测试默认即此档）；
   * - 传对象 ⇒ 启用，字段皆可注入（fixture 模板 / 规范根 / 版本 / kind / 文件清单），
   *   缺省按板内真实资产推导（`templates/org` + `<repoRoot>/flow/spec`）。
   * `index.ts`（唯一生产入口）显式传 `{}` 启用。
   */
  orgSeed?: OrgSeedOptions | null;
}

/** 仅接受 loopback（127.0.0.1 / ::1 / localhost）；否则抛错，拒绝绑定非本机地址 */
export function assertLoopbackHost(host: string): void {
  const ok = host === "127.0.0.1" || host === "::1" || host === "localhost";
  if (!ok) {
    throw new Error(`board 服务只允许绑定 loopback，拒绝非本机地址：${host}`);
  }
}

/**
 * **来源**地址是否 loopback（BD13″ `/shutdown` 的来源门；照 orch `http.ts#isLoopbackHostOrAddress`
 * 同语义、异实现）：覆盖 `::1` / `127.x` / IPv4-mapped IPv6（`::ffff:127.x`，双栈监听下对端常见形态）。
 */
export function isLoopbackAddress(value: string): boolean {
  const v = value.toLowerCase();
  return (
    v === "localhost" ||
    v === "::1" ||
    v === "[::1]" ||
    v.startsWith("127.") ||
    v === "::ffff:127.0.0.1" ||
    v.startsWith("::ffff:127.")
  );
}

/**
 * `/shutdown` 的判定（纯函数，来源门的唯一事实源）：
 * 返回 `"accept"` ⇒ 放行（调用方回 200 并触发停机链）；否则返回要原样回的结构化响应。
 * 板恒绑 loopback，非 loopback 对端无法在真机出现 ⇒ 该负向分支由本函数钉住（而非靠连真 socket）。
 */
export function decideShutdown(input: {
  method: string | undefined;
  remoteAddress: string;
  chainWired: boolean;
}): "accept" | { status: number; body: { ok: false; code: string; error: string } } {
  if (input.method !== "POST") {
    return { status: 405, body: { ok: false, code: "method_not_allowed", error: "POST /shutdown 只接受 POST" } };
  }
  if (!isLoopbackAddress(input.remoteAddress)) {
    return { status: 403, body: { ok: false, code: "loopback_only", error: "仅 loopback 来源可触发优雅停机" } };
  }
  if (!input.chainWired) {
    return {
      status: 501,
      body: { ok: false, code: "shutdown_unsupported", error: "本服务未接停机链（onShutdown 未注入），不假装受理" },
    };
  }
  return "accept";
}

function respondJson(res: ServerResponse, status: number, payload: unknown): void {
  res.writeHead(status, {
    "content-type": "application/json; charset=utf-8",
    "cache-control": "no-store",
  });
  res.end(JSON.stringify(payload));
}

function respondHtml(res: ServerResponse, status: number, html: string): void {
  res.writeHead(status, {
    "content-type": "text/html; charset=utf-8",
    "cache-control": "no-store",
    "content-security-policy": BOARD_CSP,
    // BD17：与页面内 `<meta name=referrer>` 同值 —— 同源表单必须带得上 Referer（写面守卫的第二档兜底）。
    "referrer-policy": BOARD_REFERRER_POLICY,
  });
  res.end(html);
}

/**
 * 单文档内容出口（BD11）：`text/plain; charset=utf-8` + `no-store`（头口径同 {@link respondJson}）。
 * 原文直出（不做 markdown 渲染 = B4），CSP 不适用（非 HTML）；`escapeHtml` 由视图层负责整页包装。
 */
function respondText(res: ServerResponse, status: number, text: string): void {
  res.writeHead(status, {
    "content-type": "text/plain; charset=utf-8",
    "cache-control": "no-store",
  });
  res.end(text);
}

interface PageCtx {
  client: BridgeClient;
  now: () => number;
}

/** 写面配置（**可选默认**组织名 + MCP 基址 + 两个 MCP 写封装）；生效序 = 表单组织名 > `defaultGroup`（仅提需求；排期**不回落**）。 */
interface Ctx extends PageCtx {
  write: {
    defaultGroup: string | null;
    mcpBaseUrl: string;
    createRequirement: NonNullable<CreateBoardServerOptions["createRequirementImpl"]>;
    scheduleFeature: NonNullable<CreateBoardServerOptions["scheduleFeatureImpl"]>;
    groupMemberWrite: NonNullable<CreateBoardServerOptions["groupMemberWriteImpl"]>;
    /** 停用释放成员写（§9.4-①）：`group.remove` 唯一通路，停用 handler 专享（不经成员表单）。 */
    releaseOrgGroup: NonNullable<CreateBoardServerOptions["releaseOrgGroupImpl"]>;
    /**
     * 版本台账写口（v0.10.0 B2）：建 / 删 / 设状态三支的**唯一出口**，打引擎 `/api/versions*`；
     * 板不判闸、不本地兜底（引擎不可达 ⇒ 硬失败）。
     */
    versions: VersionsWriteClient;
  };
  /** BD8 宿主面（`null` ⇒ 未装配，写端点结构化 503、状态页如实显示）。 */
  host: BoardHostFace | null;
  /** BD13″ 优雅停机回调（`null` ⇒ 未接停机链，`POST /shutdown` 返回 501）。 */
  shutdown: (() => void) | null;
  /** BD11 读文档面根（源 A / 可选源 B）；BD14 增 vendored 静态资产根。 */
  docs: { repoRoot: string; orgsDir: string | null; staticRoot: string };
  /** v0.9.4 C 档/BD5 全组枚举查询器（3300 `GET /api/groups`；§9-c 起 = manage 页成员清单事实源；`null` ⇒ 不查询，如实显示「未查询」）。 */
  orgGroups: OrgGroupsFetcher | null;
  /** N6 逐组项目查询器（只读 `a2a_projects`，组身份 = 组织名；§9-c 起落在 manage 页；`null` ⇒ 不查询，项目区显示「未查询」）。 */
  orgProjects: OrgProjectsFetcher | null;
  /** B-T3 Agent View 页的逐项目在飞任务查询器（`null` ⇒ 不查询，项目全灰化）。 */
  agentTasks: AgentTasksFetcher | null;
  /** B-T3 Agent View 页头桥身份查询器（`null` ⇒ 不查询，页头如实标「未查询」）。 */
  bridgeIdentity: BridgeIdentityFetcher | null;
  /** v0.9.4 A1：板侧组织台账存取（`.data/orgs.json`；建组织写口的唯一落点，单进程单写手）。 */
  orgsLedger: OrgsLedgerStore;
  /**
   * v0.9.4 N1：板侧版本台账存取（`.data/versions.json`）。
   * **v0.10.0 起角色翻转**（B2 写面改道引擎 / B4 锁改读引擎投影）：本文件**不再是版本锁事实源**，
   * 降为读缓存/降级投影 + 列并集的派生版号读面（B5）。
   */
  versionsLedger: VersionsLedgerStore;
  /** v0.10.0 B4：引擎版本台账读面（`GET /api/versions`，已发版锁的唯一数据源）。 */
  engineVersions: EngineVersionsFetcher;
  /** v0.10.0 B4：本进程**最后一次成功**的引擎台账投影（桥不可达时读面按它显示；写面不回落）。 */
  engineVersionsLastGood: EngineVersionsProjection | null;
  /** v0.10.0 B4：最近一次读不到的根因文案（`null` = 最近一次读到了）；写口 503 文案的事实源。 */
  engineVersionsFailure: string | null;
  /** v0.10.0 B4：在途读取（页面一次渲染只打一次 `/api/versions`，多个读面共用同一份结果）。 */
  engineVersionsInFlight: Promise<EngineVersionsProjection | null> | null;
  /**
   * v0.9.5 C7 · T7：板侧 **suspended 台账**（内存为事实源；`.data/suspended.json` 仅供崩溃取证、启动清空重写）。
   * 挂起口写、停链口清；心跳监视（C8）读本实例。
   */
  suspendLedger: SuspendLedgerStore;
  /**
   * v0.9.5 C10：组织种子化配置（`null` ⇒ 不种子化）。建组织链与启动回填共用同一份解析结果。
   */
  orgSeed: ResolvedOrgSeedOptions | null;
}

interface Page {
  title: string;
  active: NavKey;
  bodyHtml: string;
  status?: number;
  /** 页头动作区（随标题渲染的字面量按钮；REQ-2026-09-26-04「＋ 新增需求」，§9-b 起宿主 = /schedule）。 */
  headerActions?: string;
  /** 表单档错误浮层（errorPage 专用；renderPage 内逐字段转义）。 */
  errorOverlay?: ErrorOverlayParams;
  /** BD14：页面级追加脚本（仅白名单字面量，如 mermaid 资产引用 + 渲染脚本；不承载文档内容）。 */
  extraScripts?: string;
  /** REQ-2026-09-30-04 件1：组织上下文 = 侧栏二级菜单（项目组清单 + 当前空间高亮）数据源；`undefined` ⇒ 侧栏不出该块。 */
  orgNav?: PageOrgNav;
  /**
   * REQ-2026-10-02-02 件B / REQ-2026-10-02-03 件B / REQ-2026-10-02-04 件B：门户、排期、空间管理页不收全站口径说明（`ul.notes`）。
   * `true` ⇒ 本页 notes 置空（layout 侧空数组不渲染该块）；其余页不传 ⇒ 照旧渲染 `VIEW_NOTES`。
   */
  noNotes?: boolean;
}

function sendPage(res: ServerResponse, page: Page): void {
  respondHtml(
    res,
    page.status ?? 200,
    renderPage({
      title: page.title,
      active: page.active,
      bodyHtml: page.bodyHtml + (page.extraScripts ?? ""),
      notes: page.noNotes === true ? [] : VIEW_NOTES,
      headerActions: page.headerActions,
      errorOverlay: page.errorOverlay,
      orgNav: page.orgNav,
    }),
  );
}

function errText(err: unknown): string {
  return err instanceof Error ? err.message : String(err);
}

/**
 * 组织种子化的结构化告警出口（v0.9.5 C10）：**fail-open 可见** —— 落盘失败 / 模板 / 规范缺失
 * 一律打一行结构化 stderr（含码 + 组织 + 目标 + 根因），但**绝不因此改状态码或回滚**。
 */
function logOrgSeedWarnings(warnings: readonly OrgSeedWarning[]): void {
  for (const w of warnings) {
    process.stderr.write(`[org-seed] ${w.code} org=${w.org} target=${w.target} :: ${w.message}\n`);
  }
}

function wantsJson(accept: string | undefined): boolean {
  return (accept ?? "").includes("application/json");
}

/**
 * 表单档错误页（REQ-v0.9.1-2026-09-25-03）：整页 = 正常页 + errorOverlay 浮层（族名标题 / error 正文 / mono code）。
 * 只服务 **!wantsJson** 分流；JSON 档仍走 {@link respondJson}，形状逐字节不变。
 * `fields`（REQ-v0.9.2 N1）：表单写路径失败时的回填字段回显；`active`：错误页导航高亮（缺省 features）。
 * `link`（v0.9.4 增补五 §9.4-③④）：卡内**出路链接**（跨组织互斥 ⇒ 所属组织管理页 / 停用空间 410 ⇒ 回门户）；
 * **同时打在浮层卡与页面上**（无 JS 时卡随整页出现，关掉浮层后页面仍留出路）。JSON 档不承载（形状不变）。
 */
function errorPage(
  status: number,
  code: string,
  error: string,
  hint?: string,
  fields?: readonly ErrorOverlayField[],
  active: NavKey = "features",
  orgNav?: PageOrgNav,
  link?: { href: string; label: string },
): Page {
  return {
    title: "操作未成功",
    active,
    status,
    orgNav,
    bodyHtml:
      `<h2>操作未成功（${status}）</h2>` +
      `<p class="hint">错误浮层已给出原因；关闭浮层后刷新或回到上方导航重试。</p>` +
      (link === undefined
        ? ""
        : `<p class="hint"><a class="fl" href="${escapeHtml(link.href)}">${escapeHtml(link.label)}</a></p>`),
    errorOverlay: { family: errorFamilyLabel(code), error, code, hint, fields, ...(link === undefined ? {} : { link }) },
  };
}

/** 结构化错误的统一应答出口：JSON 档逐字节不变，表单档（!wantsJson）改走 {@link errorPage}。 */
function respondError(
  res: ServerResponse,
  accept: string | undefined,
  status: number,
  code: string,
  error: string,
  hint?: string,
  fields?: readonly ErrorOverlayField[],
  active: NavKey = "features",
  orgNav?: PageOrgNav,
  link?: { href: string; label: string },
): void {
  if (wantsJson(accept)) {
    respondJson(res, status, { ok: false, code, error });
    return;
  }
  sendPage(res, errorPage(status, code, error, hint, fields, active, orgNav, link));
}

/**
 * 桥不可达整页（REQ-v0.9.2 N2）：改走 {@link errorPage} ⇒ 与其它结构化错误同一 BD2 浮层版式
 * （标题 = 族名「桥不可达」、正文 = 错误消息、mono = `bridge_unreachable`、「知道了」）。
 * 原「刷新重试」口径保留为 hint；`active` 随发起页，保证导航高亮不跳（缺省「排期」= /schedule 发起）。
 */
function bridgeDownPage(
  hint: string,
  err: unknown,
  active: NavKey = "schedule",
  orgNav?: PageOrgNav,
): Page {
  return errorPage(
    502,
    BRIDGE_UNREACHABLE_CODE,
    errText(err),
    `${hint} —— 板只读视图不缓存旧数据，恢复后刷新本页即可。`,
    undefined,
    active,
    orgNav,
  );
}

/**
 * 提需求 / 建组织表单旁的 orgsDir 三档结论（REQ-v0.9.2 N3 · 纯呈现）：
 * 未装配宿主面 / 装配了但根未配置或目录不可用（code 沿用 host-face 闭集）/ 就绪。
 */
function orgsStatusOf(host: BoardHostFace | null): OrgsDirStatus {
  if (host === null) return { tier: "not_configured" };
  const configured = host.configView().orgsDir;
  if (configured === null) return { tier: "not_configured" };
  const problem = host.orgsDirProblem();
  if (problem !== null) return { tier: "problem", code: problem.code, message: problem.message };
  return { tier: "ready", orgsDir: configured };
}

// ---------------------------------------------------------------------------
// v0.10.0 B4：已发版锁的引擎读投影（事实源 = 引擎版本台账，板只投影）
// v0.10.1 B2：同一份投影按**两档分立**消费 —— Group 档（本区：版本列 / 排期锁 / 门户摘要 /
// 启动日志）语义零变化；project 档（{@link projectVersionTierOf}）只在 project 区块出降级条，
// **绝不进排期写门**（并档 = 引擎 project 出口上线前整板排期写停摆）。
// ---------------------------------------------------------------------------

/** 引擎台账投影读不到时的**写口**错误码（fail-closed：挡排期写，不回落本地台账）。 */
const VERSION_PROJECTION_UNAVAILABLE_CODE = "board_version_projection_unavailable";

/**
 * v0.10.1 B2：Group 投影**本进程从未读到过**时，project 档降级条的根因码。
 * 与解析层的 `project_versions_field_missing`（= 引擎 project 面未上线）**分档**：
 * 前者是「整面读不到」、后者是「混跑期老引擎不带该字段」，两种显示不得混一。
 */
const PROJECT_GROUP_READ_NEVER_CODE = "project_versions_group_projection_unreadable";

/** 投影不可达时的统一文案（写口 503 与读面降级提示同源，不各写一套）。 */
function versionProjectionUnreadableText(reason: string): string {
  return `引擎版本台账投影不可读（${reason}）`;
}

/**
 * 投影 → 台账形状：**只取 `status = released` 的条目**并落 `released`（其余两态 `notstart`/`active`
 * 不入锁 —— 把「进行中的版本」当已发版锁住是反语义）。**锁的 org 切片与去重继续走
 * {@link releasedVersionNames} 单点**，本模块不再立第二套「已发版集」判据。
 * `null` ⇒ 空集（只用于读面「无锁可显示」档；写面不得用此档放行，见 {@link versionProjectionOf}）。
 */
function versionProjectionLedgerOf(
  projection: EngineVersionsProjection | null,
): VersionsLedger {
  if (projection === null) return { version: 0, versions: [] };
  return {
    version: 0,
    versions: projection.entries
      .filter((entry) => entry.status === "released")
      .map((entry) => ({
        org: entry.org,
        version: entry.version,
        status: "released" as const,
        createdAt: projection.capturedAt,
        updatedAt: projection.capturedAt,
        note: null,
      })),
  };
}

/**
 * 取引擎版本台账投影（**一次渲染只打一次** `/api/versions`：同请求内的多个消费点共用同一在途结果）。
 * 口径（改造文档 §2.3(1)）：
 * - 读到 ⇒ 刷新进程内「最后一次投影」并返回；
 * - 读不到 ⇒ 返回**最后一次投影**（读面「锁只紧不松」）；进程内从未读到过 ⇒ `null`
 *   —— 由写面按 **fail-closed 挡排期写**、读面按「无锁可显示」降级，两侧都**绝不**把
 *   「拿不到台账」当成「零个已发版」放行。读不到的根因留在 {@link Ctx.engineVersionsFailure}
 *   供写口如实点出。
 */
async function versionProjectionOf(ctx: Ctx): Promise<EngineVersionsProjection | null> {
  if (ctx.engineVersionsInFlight !== null) return ctx.engineVersionsInFlight;
  const pending = (async (): Promise<EngineVersionsProjection | null> => {
    try {
      const outcome = await ctx.engineVersions();
      if (outcome.kind === "projection") {
        ctx.engineVersionsLastGood = outcome.projection;
        ctx.engineVersionsFailure = null;
        return outcome.projection;
      }
      ctx.engineVersionsFailure = versionProjectionUnreadableText(`${outcome.code} · ${outcome.error}`);
      return ctx.engineVersionsLastGood;
    } catch (err) {
      // 注入面按契约不抛；本兜底同样不放开写口（根因进文案，不静默）。
      ctx.engineVersionsFailure = versionProjectionUnreadableText(errText(err));
      return ctx.engineVersionsLastGood;
    }
  })();
  ctx.engineVersionsInFlight = pending;
  try {
    return await pending;
  } finally {
    ctx.engineVersionsInFlight = null;
  }
}

/**
 * **project 档**的取数单点（v0.10.1 B2 · T2；改造文档 §2 C-7 / C-12「投影消费两档分立」）。
 * 入参 = {@link versionProjectionOf} 的结果 ⇒ 与 Group 面**共用同一次上游读取**
 * （project 面**没有独立 fetcher**，一次渲染仍只打一次 `/api/versions`、在途共用；
 * 也不接 `?owner_group=` ⇒ 板照旧全表拉、org 切片留板侧单点，两者都不在本函数）。
 *
 * 三档语义（**逐档都不牵动排期写门**，project 面无本地读缓存）：
 * - 投影在场 ∧ 带合法 `projectVersions[]` ⇒ `live`；
 * - 投影在场 ∧ 字段在场零条目 ⇒ `empty`（**合法事实**，非降级）；
 * - 投影在场 ∧ 字段缺位 / 形状不合法 ⇒ `absent`（老引擎档，经 {@link projectVersionsOf} 归一，
 *   **绝不当成「零条目」的 `empty`**）；
 * - 投影为 `null`（本进程从未读到过）⇒ 合成 `absent` 带根因码 ⇒ **只有 project 区块出降级条**，
 *   Group 面（版本列 / 已发版锁 / 门户摘要 / 启动日志）与排期写门各按**自己的档**处理、不受牵连。
 */
export function projectVersionTierOf(projection: EngineVersionsProjection | null): ProjectVersionsField {
  if (projection !== null) return projectVersionsOf(projection);
  return {
    status: "absent",
    code: PROJECT_GROUP_READ_NEVER_CODE,
    error: "本进程从未读到引擎版本台账投影 ⇒ project 档无从判定（Group 面按各自档降级，project 面单列降级条）",
  };
}

/**
 * project 档**三态显示闭集**里「读不到」那一档的降级条正文单点（v0.10.1 B2 · C-7：
 * 在场有行 / 在场无行 / 读不到）：`live` 与 `empty` ⇒ `null`（**无降级条** —— `empty` 是
 * **合法事实**「未登记，本版本起生效」，由 project 区块自己渲文案，不是降级），
 * `absent` ⇒ 一行含**根因码**的提示。T3 的 project 区块只准经本函数取降级文案（不各写一套）。
 */
export function projectVersionDegradationText(field: ProjectVersionsField): string | null {
  if (field.status !== "absent") return null;
  return `引擎 project 版本面降级（${field.code} · ${field.error}）—— 仅本区块不可读，` +
    "**不影响 Group 面**（版本列 / 已发版锁 / 门户摘要照常），也不挡排期写";
}

/**
 * 门户「版本摘要行」的喂入台账（v0.10.0 尾段 N2 · 摘要换源）：
 * 事实源 = **引擎版本台账投影**（含三态 ⇒ 台账登记的「进行中」不退化成卡派生 `*`）；
 * **只在从未读到过投影时**（{@link versionProjectionOf} 返 `null`）退板本地台账**读缓存** ——
 * 与 N1 版本列的降级档同一口径（读面不挡；写口的 fail-closed 不经此路径，见
 * {@link respondVersionProjectionClosed}）。纯读、零写。
 */
async function portalSummaryLedgerOf(ctx: Ctx): Promise<VersionsLedger> {
  const projection = await versionProjectionOf(ctx);
  return projection === null ? ctx.versionsLedger.load().ledger : projectionLedgerOf(projection);
}

/**
 * 写口的 fail-closed 出口：拿不到投影 ⇒ 结构化 503 拒写（零出网，不触引擎写口）。
 * **本出口只由 Group 档（`versions[]`）触发**（v0.10.1 B2 · C-12）：project 档缺位 / 形状不合法
 * 只在 project 区块出降级条（见 {@link projectVersionTierOf} / {@link projectVersionDegradationText}），**不得**并进来 —— 否则引擎
 * project 出口上线前排期写会被全部挡死（自造停摆）。
 */
function respondVersionProjectionClosed(
  res: ServerResponse,
  ctx: Ctx,
  accept: string | undefined,
  fields: readonly ErrorOverlayField[],
  active: NavKey = "features",
): void {
  respondError(
    res,
    accept,
    503,
    VERSION_PROJECTION_UNAVAILABLE_CODE,
    `${ctx.engineVersionsFailure ?? versionProjectionUnreadableText("原因未知")} ⇒ 已发版锁无法判定，本板拒绝排期写` +
      `（**fail-closed**：拿不到引擎版本台账投影时绝不当作「零个已发版」放行）。请稍后重试；` +
      `锁的判定恢复 = 引擎版本台账读端点可达。`,
    undefined,
    fields,
    active,
  );
}

/**
 * 排期看板正文单点（v0.9.6 B5a 起唯一调用方 = D 档组织空间排期页；全局 `/schedule` 页已退役）：
 * 数据源由调用方给定（空间 = 先过 {@link featuresOfOrg} 按 ownerGroup 过滤）。
 * 弹窗表单的组织上下文（BD8）：`spaceOrg` 非空 ⇒ 免选形态（只读展示 + hidden 值必发 + action 带前缀）。
 * **v0.10.0 B4 数据源分家**：`lockedVersions` = **引擎投影喂入**的已发版名单（调用方经
 * {@link versionProjectionOf} 取，按 `spaceOrg` 切片）；`ledger` = 本地台账，**不再参与锁判定**。
 * **版本列并集（v0.10.0 尾段 N1）**：列源 = **引擎版本台账清单 ∪ 卡派生版号**（并集留板，见
 * {@link projectionVersionNames} / {@link groupFeaturesByVersion}）—— **绝不只渲染引擎清单**
 * （引擎无条目 ∧ 卡有 `version` ⇒ 该卡仍须成列，否则它在版本面失去清单读面）；本地台账只在
 * **投影从未读到过**的降级档贡献版号，正常档不喂（事实源在引擎）。
 * **增补八 §9.3**：全局页（`spaceOrg` 为 null）另挂「＋ 新版本」弹窗骨架（入口按钮只在全局页头）。
 * **版本切片读面（v0.9.6 B3 · 口径 3 / 29）**：台账唯一键 = `(org, version)` ⇒ 本页的三张读面
 * （已发版锁名单 / 版本列并集 / 列头徽标与删除 ×）全部按 `spaceOrg` 切片 —— 空间页他组织的同版号
 * **既不出空列、也不加锁**（验收④「两组织同版号互不可见互不锁」）；`spaceOrg` 为 null 时传
 * `undefined` = **不限组织**（跨组织并集档自 B5a 全局页退役起不再有页级调用方，仅留作口径完整）。
 * 切片只在这一处发生，
 * `isVersionLocked` / `deriveVersionStatus` / 台账纯函数签名一律不动（口径 3）。
 * **列序归渲染侧（REQ-2026-09-30-04 件3）**：需求池最左 + 版本列由大到小由 {@link renderSchedule}
 * 内部按 `compareVersionOrder` 反向排序完成 —— 本单点仍按升序入参喂 {@link groupFeaturesByVersion}
 * （该纯函数与版本台账读面零改动），服务端不引入第二套列序事实源。
 * **建版本入口归空间页（v0.9.6 B4 · 口径 4 / 9）**：「＋ 新版本」弹窗骨架的渲染门由「只全局页」
 * **反转**为「只空间页」—— 台账按 `(org, version)` 成域后，全局页**没有组织上下文**（建版本表单零
 * org 字段、org 只从路径取，见 {@link handleWriteVersions}），挂在那儿只会把新版本写进**未归属空串桶**
 * ⇒ 门户与各空间页都读不到 = 静默黑洞。故入口随本节点整体迁进空间排期页（全局页头按钮同批撤除；
 * `POST /versions` 全局路由与写闸**零改动**留作纯 HTTP 兜底口，口径同 §9.2「UI 撤、写口留」）。
 * **project 版本区块接线（v0.10.1 B4 · C-18①）**：区块由 {@link renderProjectVersionsBlock} 渲染，
 * **串在 {@link renderSchedule} 的整段返回之后** ⇒ 容器恒在 `#schedule-board` 之外（同级 section）。
 * 落点必须是这里而非看板内部：`DRAG_SCHEDULE_SCRIPT` 的入口守卫只认 `getElementById("schedule-board")`，
 * 区块若嵌进看板会被既有拖拽脚本当成看板的一部分、在新块上误触发拖拽 POST。**本函数不动 `#schedule-board`
 * 内部结构、不改排期列渲染逻辑**（`renderSchedule` 签名与列序归渲染侧的口径零改动）。
 * project 档取数**共用上面同一次 Group 投影**（{@link projectVersionTierOf} 是纯函数，零新增上游读取），
 * org 切片沿用同一 `org`（`spaceOrg === null` ⇒ `undefined` = 不限组织），降级文案单点
 * {@link projectVersionDegradationText} —— project 档 `absent` **只出本区块降级条**，
 * 不牵连版本列 / 已发版锁 / 排期写门（C-12 两档分立）。
 */
async function renderScheduleBoard(
  ctx: Ctx,
  features: readonly FeatureListItem[],
  ledger: VersionsLedger,
  spaceOrg: string | null,
): Promise<string> {
  const org = spaceOrg === null ? undefined : spaceOrg.trim();
  // B4：已发版锁名单改由引擎投影喂入（判据 `isVersionLocked` 零改动）；投影不可达 ⇒ 退到
  // 最后一次投影（读面只紧不松），仍拿不到 ⇒ 空名单 = 不显示锁样式（执法在写口 fail-closed）。
  const projection = await versionProjectionOf(ctx);
  const lockedVersions = releasedVersionNames(versionProjectionLedgerOf(projection), org);
  // N1：版本列的台账侧版号 = 引擎清单（事实源）；投影从未读到过 ⇒ 退到本地台账读缓存
  // （降级档，正常档空数组）。并集（∪ 卡派生版号）在视图侧完成，此处不预裁。
  const engineColumnVersions = projectionVersionNames(projection, org);
  const ledgerColumnVersions = projection === null ? ledgerVersionNames(ledger, org) : [];
  // v0.10.1 B4：project 档与上面 Group 面**共用这份投影**（不另打上游），三态显示归视图单点。
  const projectVersions = projectVersionTierOf(projection);
  return (
    renderSchedule(groupFeaturesByVersion(features, ledgerColumnVersions, engineColumnVersions), selectRequirementPool(features), lockedVersions, ledger, org) +
    // v0.10.1 B4（C-18①）：project 版本区块 = `#schedule-board` 的**同级 section**，串在看板整段之后
    renderProjectVersionsBlock(projectVersions, org, projectVersionDegradationText(projectVersions)) +
    // 提需求弹窗骨架（表单原样复用；orgsDir 三档提示与锁版警示随表单呈现）
    renderNewRequirementDialog(ctx.write.defaultGroup, orgsStatusOf(ctx.host), lockedVersions, spaceOrg) +
    (spaceOrg !== null ? renderNewVersionDialog(spaceOrg) : "")
  );
}

/**
 * 排期看板页脚本单点（v0.9.6 B5a 起唯一宿主 = D 档组织空间排期页 ⇒ 浮层 / 拖拽两枚常量各保持唯一注入点，N3-⑧ 纪律锚）。
 * REQ-v0.9.2 增补 ④：详情浮层脚本随本页（= schedule kind）注入，
 * 单点常量；其它 kind 无 dialog 骨架，脚本自身空转 ⇒ 不注入。卡片 <a> 回退不依赖它。
 * REQ-2026-09-26-04 Q1：新增需求弹窗脚本同页、同 extraScripts 通路注入（两枚各管各的 dialog）。
 * v0.9.3 B-T5：排期拖拽脚本同页、同通路（第三枚，常量分立不可共置；无 #schedule-board 的页面自然空转）。
 * v0.9.4 增补六 §9.5：弹窗脚本已泛化为两枚 dialog 共用 ⇒ 门户 `/` 亦注入**同一枚**
 * `NEW_REQUIREMENT_DIALOG_SCRIPT`（那边接 `#new-org-dialog`），故本常量注入点由一处变两处；闭集枚数不扩。
 * v0.9.3 增补 ②：浮层换入的详情页依赖图/文档 mermaid 不经脚本执行（搬运节点不跑 `<script>`）⇒
 * 本页同挂 vendored 库 + 渲染脚本，浮层经 window.a2aRenderMermaid 钩子补渲（缺资产 ⇒ 不挂，源文本降级）。
 */
function schedulePageScripts(ctx: Ctx): string {
  return (
    FEATURE_DETAIL_OVERLAY_SCRIPT +
    NEW_REQUIREMENT_DIALOG_SCRIPT +
    DRAG_SCHEDULE_SCRIPT +
    (vendoredAssetExists(ctx.docs.staticRoot, MERMAID_ASSET.file)
      ? mermaidAssetScriptTag() + mermaidRenderScript()
      : "")
  );
}

/**
 * `GET /` 组织门户页（v0.9.4 §9-b · 首页形态 B→A；§9.5 增补六：建组织改「＋ 建项目组」按钮 + 弹窗；
 * v0.9.7 增补 · REQ-2026-10-02-01 件A：页签标题可见文案改「项目组门户」，与侧栏一级菜单同源）：
 * 卡清单 = 顶栏切换器同一纯函数 {@link portalOrgNames} 的口径（台账未停用 ∪ 需求归属），
 * 计数摘要 = `getFeatures()` 既有数据派生（**零新桥接口、零新触桥面**）；卡头链进
 * `/org/<名>/`（D 档空间），点卡即达；建组织 = 页头按钮（**服务端 `hidden`**，无 JS 不显死按钮）
 * + {@link renderCreateOrgDialog} 骨架（正文另留 `#new-org-inline` 内联回退表单）；
 * 写口仍 `POST /orgs` **零改动**。开/关 = `NEW_REQUIREMENT_DIALOG_SCRIPT`（§9.5 已泛化为两枚
 * dialog 共用，闭集枚数不扩）。
 * **v0.9.4 W6（§2.6）→ 增补七 a（§9.1-a）**：「＋ 新版本」按钮曾挂在本页页头，现**迁往排期看板**
 * （`/schedule` 页头，全站唯一入口）—— 本页不再渲染该按钮（弹窗脚本内的 `wireNewVersion` 因无此 id 空转）。
 * **不注入**排期看板的浮层 / 拖拽 / mermaid 三枚脚本（它们随 `/schedule` 走）。
 * **B6**：门户不另挂组清单（件1 起全站唯一处 = 侧栏二级菜单）；卡增「已发版 / 进行中」版本摘要行
 * （**v0.10.0 尾段 N2 起 = 引擎版本台账投影只读喂入**，纯读面不做自动点亮，派生档带 `*`）。
 * 内联脚本闭集保持**七元**（N3-⑦/⑧ 纪律锚；门户新增的这点脚本是既有第五枚内的泛化，非新枚）。
 * **件B（REQ-2026-10-02-02）**：门户不收全站口径说明（页底 `ul.notes`）—— 经 `noNotes` 单点开关摘除
 * （`VIEW_NOTES` 常量与数据源不动，其余 `sendPage` 调用点照旧渲染；增补三 件B 起排期页同挂本开关）。
 */
async function pageOrgPortal(ctx: Ctx): Promise<Page> {
  const view = await ctx.client.getFeatures();
  const orgNav = orgNavOf(ctx, undefined, featureOrgGroups(view.features));
  // B6（N2 换源）：版本摘要行的台账侧数据 = **引擎版本台账投影**（门户为纯读面 —— 显示派生不执法、零写）。
  // 降级档沿用 B4 / N1 同一套投影失败语义：读不到 ⇒ 退本进程最后一次投影；从未读到过 ⇒ 退板本地台账
  // **读缓存**（读面不挡；写口的 fail-closed 不经此路径）。
  const summaryLedger = await portalSummaryLedgerOf(ctx);
  return {
    title: "项目组门户",
    active: "home",
    orgNav,
    // B6 的「顶栏切换器摘除」随件1 外壳退役：全站只有一处侧栏项目组菜单，门户页不再单独摘挂。
    // orgNav 装配照旧保留 —— 门户卡数据源就是 orgNav.orgs。
    headerActions: '<button type="button" id="new-org-open" class="header-actions" hidden>＋ 建项目组</button>',
    bodyHtml: renderOrgPortal(buildOrgPortalCards(orgNav.orgs, view.features, summaryLedger), orgsStatusOf(ctx.host)),
    extraScripts: NEW_REQUIREMENT_DIALOG_SCRIPT,
    noNotes: true,
  };
}

/**
 * 需求详情页（整页与 `#feat-dialog` 浮层共用同一正文）。
 * `spaceOrg`（件2）= 空间路由带进来的组织名；全局档传 `null` / 不传 ⇒ 回落该卡 `ownerGroup`
 * （见 {@link detailSpaceOrg}），两者皆不可得 ⇒ 正文不带空间 tab 行。
 */
async function pageFeatureDetail(ctx: Ctx, featureId: string, spaceOrg: string | null = null): Promise<Page> {
  const detail = await ctx.client.getFeature(featureId);
  let trace = null;
  let traceError: string | null = null;
  try {
    trace = await ctx.client.getFeatureTrace(featureId);
  } catch (err) {
    traceError = errText(err);
  }
  // BD9：宿主面装配了才显示动作区；回答框**仅在存在 `awaiting_answer` 轮时出现**。
  // v0.9.5 C1/C5：引导行与动作区**共用同一份事实**（`nextStepInput`）—— 档位规则源在 `derive.ts`，
  // 服务端只归一输入，不在这里判档（收口轨 16 ①/② 的终态优先口径不变：终态不渲染回答框）。
  const f = detail.feature;
  const terminal = isTerminalFeatureState(f.state);
  const awaiting = ctx.host === null || terminal ? null : ctx.host.awaitingTurnOf(f.featureId);
  const busy = ctx.host === null ? null : ctx.host.busyTurnOf(f.featureId);
  // C6：最近一轮留痕（宿主面未装配 ⇒ 缺席不渲染、不带崩；`at` = 该轮最近一次时刻）。
  // v0.9.6 N4：`receipt` 必须在此**显式透传** —— 本处是逐字段重构（与台账 parseTurnRecord 同构的
  // 静默丢失点）：漏一行 ⇒ 详情页回执卡永不出现且无任何告警。
  const latest = ctx.host === null ? null : ctx.host.latestTurnOf(f.featureId);
  const latestTurn =
    latest === null
      ? null
      : {
          turnId: latest.turnId,
          state: latest.state,
          summary: latest.summary,
          at: latest.finishedAt ?? latest.updatedAt,
          errorCode: latest.error?.code ?? null,
          receipt: latest.receipt ?? null,
        };
  // REQ-v0.9.2 N7：轮次进度行 —— 排队位次取该桥队列可见面（在飞不查、查不到 ⇒ 不显示位次，
  // 队列面异常也不该把详情页带崩 ⇒ 兜成 null）。
  const queuePosition =
    busy !== null && busy.state === "queued" ? hostQueuePositionOf(ctx, busy.org, busy.turnId) : null;
  // v0.9.5 增补二 · D2 + REQ-2026-09-30-04：链状态快照**单点派生一次**（零二次触桥）——
  // 同一份 `chainLine` 既喂档位判据（`chainMonitoring` / `chainPendingCount`，判据复用闭集校验、
  // 不在原始快照上另开第二条链态判据），又喂详情页的链状态行（含停链表单入口）。
  // 快照缺席（宿主面未装配 / 假面未实现该方法 / 取值抛错）⇒ `null` ⇒ 判据 fail-open 取 false、
  // 整行不渲染，绝不带崩详情页。
  const chainLine = deriveChainStateLine(hostChainSnapshotOf(ctx, f.featureId));
  const nextStepInput: NextStepInput = {
    hostFaceAssembled: ctx.host !== null,
    awaitingAnswer: awaiting !== null,
    approval: f.approval,
    state: f.state,
    registeredDocs: registeredDecisionDocFiles(f.decisions),
    taskCounts: taskCountsOf(detail.acceptance),
    latestTurn: latest === null ? null : { state: latest.state, summary: latest.summary, at: latest.finishedAt ?? latest.updatedAt },
    turnBusy: busy !== null,
    busyTurn: busy,
    nowMs: ctx.now(),
    // v0.9.6 N5：回执卡在场判据 = 最新轮带结构化 receipt（与 views 渲染回执卡同一条件）。
    receiptPresent: latest !== null && (latest.receipt ?? null) !== null,
    chainMonitoring: chainLine?.state === "monitoring",
    chainPendingCount: chainLine?.pendingCount ?? null,
  };
  const turnProgress = renderTurnProgress(deriveTurnProgress(busy, queuePosition));
  const chainState = renderChainStateLine(chainLine, f.featureId, awaiting !== null);
  const answerForm = awaiting === null ? "" : renderAnswerForm(f.featureId, awaiting.question);
  // T2 依赖图：mermaid 源经 application/json 数据通道注入（非可执行脚本、不入 n3 闭集）；
  // 渲染脚本只在区块存在且 vendored 资产在盘时挂（缺资产 ⇒ 源文本降级可见，不 404 静默）。
  const graph = renderDependencyGraphSection(detail.tasks);
  const extraScripts =
    graph.needsMermaid && vendoredAssetExists(ctx.docs.staticRoot, MERMAID_ASSET.file)
      ? mermaidAssetScriptTag() + mermaidRenderScript()
      : "";
  // 版本切片读面（v0.9.6 B3）：详情页的排期锁 = **该卡归属组织**的 released 切片
  // （归属缺失 ⇒ 空串桶 `""`，与 `migrateLedgerOrgs` 的未归属桶同构）—— 他组织的同版号不锁本卡。
  // **v0.10.0 B4**：切片的数据源由本地台账换成**引擎版本台账投影**（锁判据 `isVersionLocked` 零改动）。
  const detailProjection = await versionProjectionOf(ctx);
  const lockedVersions = releasedVersionNames(
    versionProjectionLedgerOf(detailProjection),
    (f.ownerGroup ?? "").trim(),
  );
  // 件2：空间 tab 行（详情页**无激活态**，作空间上下文与返回口）；归属不可得 ⇒ 空串不渲。
  const spaceOrgOfCard = detailSpaceOrg(ctx, spaceOrg, f.ownerGroup);
  const spaceNavHtml = spaceOrgOfCard === null ? "" : renderSpaceNav(spaceOrgOfCard, null);
  return {
    title: `需求 ${featureId.slice(0, 8)}`,
    active: "features",
    bodyHtml: renderFeatureDetail(
      detail,
      trace,
      traceError,
      ctx.now(),
      true,
      lockedVersions,
      {
        spaceNavHtml,
        nextStepHtml: renderNextStepGuide(nextStepInput),
        actionAreaHtml: renderActionArea(f.featureId, nextStepInput),
        turnTraceHtml: renderTurnTrace(latestTurn),
        turnProgressHtml: turnProgress,
        chainStateHtml: chainState,
        answerFormHtml: answerForm,
        graphHtml: graph.html,
        acceptanceHtml: renderAcceptanceSection(detail.acceptance),
      },
    ),
    extraScripts,
  };
}

/** C1 引导行的任务计数事实（取自桥详情顶层 `acceptance.stateCounts`，板不重算；老桥 / 缺块 ⇒ 不说）。 */
function taskCountsOf(acceptance: AcceptanceView | null | undefined): NextStepTaskCounts | undefined {
  if (acceptance === null || acceptance === undefined) return undefined;
  const counts = acceptance.stateCounts;
  return {
    total: Object.values(counts).reduce((a, b) => a + b, 0),
    completed: counts["completed"] ?? 0,
    failed: counts["failed"] ?? 0,
  };
}

/** 该桥队列里这条排队轮的位次（1 起）；队列面里没有它 / 取不到 ⇒ `null`（不臆造位次）。 */
function hostQueuePositionOf(ctx: Ctx, org: string, turnId: string): number | null {
  const face = ctx.host;
  if (face === null) return null;
  try {
    const index = face.queueView(org).waiting.findIndex((w) => w.turnId === turnId);
    return index < 0 ? null : index + 1;
  } catch {
    return null;
  }
}

/**
 * 详情页链状态快照（v0.9.5 增补二 · D2）：**只读取**宿主面的内存态；宿主面未装配 /
 * 未提供该口 / 取值抛错 ⇒ `null`（该行不渲染，口径同上「队列面异常也不该把详情页带崩」）。
 */
function hostChainSnapshotOf(ctx: Ctx, featureId: string): ChainStateSnapshot | null {
  const face = ctx.host;
  if (face === null) return null;
  try {
    return face.chainSnapshotOf(featureId) ?? null;
  } catch {
    return null;
  }
}

/**
 * `GET /features/:id/docs?file=<name>[&src=A|B]`（BD11 a 案 HTTP 面）：
 * 版本与归属组织从桥侧详情取（**不接受调用方传 version** ⇒ 无从绕开白名单），
 * 落盘读取全权交 docs-read 的四件套守卫。读面恒 GET、不过 CSRF（既有口径）。
 *
 * 两档呈现（同 `wantsJson` 分流先例）：`Accept: text/html`（浏览器点开）⇒ 整页；
 * 其余 ⇒ `text/plain; charset=utf-8`（原文，头口径同 `respondJson`）。失败一律纯文本 404 / 400
 * （docs-read 的文案不携带根路径 = B3「不泄根」）。
 *
 * **BD14 渲染/原文双档**（仅 html 档内再分流）：`mode=render`（缺省）⇒ markdown 子集渲染 +
 * mermaid 占位；`mode=raw` ⇒ 现行 `<pre>` 原文视图**原样保留**；`text/plain` 档不受 mode 影响。
 *
 * **BD13 补源 B（b 案·服务端回落）**：`src` 显式指定 ⇒ 只查该源（现状不变）；`src` 缺省 ⇒ 先查源 A，
 * `not_found` 时回落源 B —— 回落是**换参重走 readDoc**，四件套守卫逐源各自过一遍（只加通路不开口子）。
 * 实际来源经响应头 `X-Docs-Source: A|B` 透出，html 档另在页头标注 —— 两源同名时源 A 优先、不歧义。
 */
async function handleFeatureDoc(
  ctx: Ctx,
  res: ServerResponse,
  req: IncomingMessage,
  featureId: string,
  params: URLSearchParams,
): Promise<void> {
  const file = params.get("file") ?? "";
  const srcParam = params.get("src");
  const srcExplicit = srcParam === "A" || srcParam === "B";
  let version: string | null;
  let org: string | null;
  try {
    const detail = await ctx.client.getFeature(featureId);
    version = detail.feature.version;
    org = detail.feature.ownerGroup;
  } catch (err) {
    respondText(res, 502, `需求数据读取失败，无法定位文档：${errText(err)}`);
    return;
  }
  const dirs = { repoRoot: ctx.docs.repoRoot, orgsDir: ctx.docs.orgsDir, org };
  const read = (source: DocsSource) => readDoc(dirs, source, version ?? "", file);
  let src: DocsSource = srcExplicit ? (srcParam as DocsSource) : "A";
  let result = read(src);
  if (!srcExplicit && !result.ok && result.code === "docs_read_not_found") {
    const fallback = read("B");
    if (fallback.ok) {
      src = "B";
      result = fallback;
    }
  }
  res.setHeader("X-Docs-Source", src);
  if (!result.ok) {
    respondText(res, result.code === "docs_read_not_found" ? 404 : 400, result.error);
    return;
  }
  if ((req.headers.accept ?? "").includes("text/html")) {
    const mode = params.get("mode") === "raw" ? "raw" : "render";
    const view = renderDocPage(featureId, file, src, result.content, result.truncated, mode, ctx.docs.staticRoot);
    sendPage(res, {
      title: `文档 ${file}`,
      active: "features",
      orgNav: orgNavOf(ctx),
      bodyHtml: view.bodyHtml,
      extraScripts: view.extraScripts,
    });
    return;
  }
  respondText(res, 200, result.truncated ? `${result.content}\n\n…（超过读取上限，已截断）` : result.content);
}

/** 宿主桥状态页（BD8）：本板进程的桥事实 + 轮队列；**不触桥**（宿主面故障与编排桥故障分开显示）。 */
async function pageHost(ctx: Ctx, notice: string | null): Promise<Page> {
  if (ctx.host === null) {
    return {
      title: "宿主桥",
      active: "host",
      bodyHtml: renderHostPage({
        entries: [],
        config: { orgsDir: null, defaultOrg: null, kind: "（宿主面未装配）" },
        notice: HOST_FACE_DISABLED_DISPLAY,
      }),
      // REQ-v0.9.2 N2：503 降级档整页套 BD2 浮层版式（与写门 POST 的 errorPage 同码同文案；只加样式面，不动信息架构）。
      errorOverlay: {
        family: errorFamilyLabel(HOST_FACE_DISABLED_CODE),
        error: HOST_FACE_DISABLED_DISPLAY,
        code: HOST_FACE_DISABLED_CODE,
      },
    };
  }
  const entries = await ctx.host.statusView();
  return {
    title: "宿主桥",
    active: "host",
    // BD14：组织目录根坏了是**根因**，要在还没有任何桥的时候就能看见（否则本页只会一片「无桥可显示」）。
    bodyHtml: renderHostPage({
      entries,
      config: ctx.host.configView(),
      notice,
      orgsDirProblem: ctx.host.orgsDirProblem(),
    }),
  };
}

/**
 * 本组织**声明面**成员 projectId 集（v0.9.6 C2 · §4 口径 6）：数据源 = 3300 `GET /api/groups`
 * （{@link Ctx.orgGroups}，组结构声明面），**不用**逐组 `a2a_projects` 运行态（桥抖动 ⇒ 清单抖动）。
 * 返回值三态：
 * - `Set<string>`（可判定）= 该组声明成员的 projectId 集；组未声明（盘/台账可先于 orch 组存在）⇒ **空集 = 真空**（本组织无项目，非缺位）；
 * - `null`（不可判定）= 查询器未装配（`orgGroups === null`）或声明面读失败（`ok=false` / 抛异常）⇒
 *   调用方**不得**据此外泄他组项目，也不得谎报「本组织无项目」。
 */
async function orgDeclaredProjectIds(ctx: Ctx, org: string): Promise<Set<string> | null> {
  if (ctx.orgGroups === null) return null;
  const outcome: OrgGroupsOutcome = await ctx.orgGroups().catch(
    (err: unknown): OrgGroupsOutcome => ({
      ok: false,
      code: "groups_query_failed",
      error: err instanceof Error ? err.message : String(err),
    }),
  );
  if (!outcome.ok) return null;
  const row = outcome.groups.find((g) => g.name === org);
  if (row === undefined) return new Set<string>();
  return new Set(row.members.map((m) => m.projectId));
}

/** 交集过滤：保留 `projects` 快照中 projectId ∈ `ids` 的机器项（`renderTasksPick` 只读 `machines[].projects`）。 */
function filterProjectsToIds(projects: ProjectsView, ids: ReadonlySet<string>): ProjectsView {
  return {
    ...projects,
    machines: projects.machines.map((m) => ({ ...m, projects: m.projects.filter((p) => ids.has(p.projectId)) })),
  };
}

/**
 * 深链任务页头「所属组织」标注（v0.9.6 C3 · §4 口径 34）：projectId → 声明面命中组名。
 * 三态：命中 ⇒ 组名；未命中 ⇒「无归属组织」；查询器未装配 / 声明面读失败 ⇒ `null`（不可判定，
 * 页头不渲该行）。**不臆造默认组**（`ctx.write.defaultGroup` 不参与本判定）。
 */
async function deepLinkHomeOrg(ctx: Ctx, projectId: string): Promise<string | null> {
  if (ctx.orgGroups === null) return null;
  const outcome: OrgGroupsOutcome = await ctx.orgGroups().catch(
    (err: unknown): OrgGroupsOutcome => ({
      ok: false,
      code: "groups_query_failed",
      error: err instanceof Error ? err.message : String(err),
    }),
  );
  if (!outcome.ok) return null;
  // machineId 传空串 ⇒ pair 档必不命中，落 projectId 档（真实 machineId 恒非空，O1 写口要求成对）
  return ownerOrgOfProject(outcome.groups, { machineId: "", projectId }) ?? "无归属组织";
}

async function pageTasks(
  ctx: Ctx,
  url: URL,
  res: ServerResponse,
  accept: string | undefined,
  org: string | null = null,
  orgNav: PageOrgNav,
): Promise<void> {
  const project = url.searchParams.get("project");
  if (project === null || project.length === 0) {
    let projects = null;
    let projectsError: string | null = null;
    try {
      projects = await ctx.client.getProjects();
    } catch (err) {
      projectsError = errText(err);
    }
    // v0.9.6 C2（§4 · 口径 6）：空间任务页项目清单 = **交集式真过滤**
    // = getProjects() 快照的 projectId ∩ 本组织声明面（3300 `GET /api/groups`）该组 `members[].projectId`。
    // 数据源用**声明面**（orgGroups），**不用**逐组 `a2a_projects` 运行态（桥抖动 ⇒ 清单抖动）；
    // 组织存在性 / 停用校验已由 `resolveOrgSpaceRoute` 承担，此处不新增触桥。全局档（org===null）不滤。
    let membershipError: string | null = null;
    if (org !== null && projects !== null) {
      const ids = await orgDeclaredProjectIds(ctx, org);
      if (ids === null) {
        // 声明面不可判定（查询器未装配 / 3300 读失败）⇒ 不猜、不外泄他组：清空清单 + 如实标注
        membershipError = "本组织项目集合暂不可判定（声明面 GET /api/groups 读取失败）⇒ 不呈现项目清单（仍可手工输入项目名查询）";
        projects = { ...projects, machines: [], runners: [] };
      } else {
        projects = filterProjectsToIds(projects, ids);
      }
    }
    // 件5（REQ-2026-09-30-04 · 样张④「查询前默认带出近 N 条，不再空屏」）：
    // 仅**空间档 ∧ 声明面可判定 ∧ 过滤后清单非空**时，对过滤后首个项目做一次只读 `getTasks`。
    // 全局档到不了本分支（C1 起裸 `/tasks` 已收 303，`/tasks?project=` 走下方深链档）；
    // 读失败 / 抛错 ⇒ `preview = null`（降级为旧「先选项目」形态，不炸页、不编造空清单）。
    let preview: TasksPreviewInput | null = null;
    if (org !== null && membershipError === null && projects !== null) {
      const candidates = [
        ...new Set(projects.machines.flatMap((m) => m.projects.map((p) => p.projectId))),
      ].sort();
      const first = candidates[0];
      if (first !== undefined) {
        try {
          preview = { view: await ctx.client.getTasks(first, { limit: TASKS_PREVIEW_LIMIT }), limit: TASKS_PREVIEW_LIMIT };
        } catch {
          preview = null;
        }
      }
    }
    sendPage(res, {
      title: org === null ? "任务视图" : `空间 · ${org} · 任务`,
      // v0.9.6 B5a（口径 37/38）：全局 /tasks* 的 NAV 高亮归「项目」（NAV 摘「任务」条后不空置）；
      // 空间任务页不套用（空间侧导航归 B5b 处置）。
      active: org === null ? "projects" : "tasks",
      orgNav,
      // 增补四 件A（REQ-2026-10-02-04）：选单档不收全站口径说明（口径折叠已删，notes 一并摘除）
      noNotes: true,
      // B5b ④：空间档补二级导航行（全局档不渲）；件1 起组清单归侧栏，本行只留三枚 tab
      bodyHtml:
        (org === null ? "" : renderSpaceNav(org, "tasks")) +
        renderTasksPick(projects, projectsError, org, membershipError, preview),
    });
    return;
  }
  // REQ-v0.9.2 N4：`state`/`limit` 接进桥（客户端已具备并真发 query，bridge-client `getTasks`）——
  // 纯服务端接线。`limit` 非法 ⇒ 结构化 400（不静默吞）；`state` 不校验值域（桥侧过滤，如实回显）。
  const state = (url.searchParams.get("state") ?? "").trim();
  const limitRaw = (url.searchParams.get("limit") ?? "").trim();
  let limit: number | undefined;
  if (limitRaw !== "") {
    const parsed = /^([1-9]\d*)$/.exec(limitRaw);
    if (parsed === null || Number(parsed[1]) > MAX_TASKS_LIMIT) {
      respondError(
        res,
        accept,
        400,
        "invalid_limit",
        `limit 参数非法：${limitRaw.slice(0, 40)}（须为 1–${MAX_TASKS_LIMIT} 的整数）`,
        undefined,
        undefined,
        "tasks",
        orgNav,
      );
      return;
    }
    limit = Number(parsed[1]);
  }
  const filter = { ...(state === "" ? {} : { state }), ...(limit === undefined ? {} : { limit }) };
  const view = await ctx.client.getTasks(project, filter);
  // v0.9.6 C3：全局深链页头加「所属组织」标注（空间档 org 非 null ⇒ 不重复查、不渲该行）
  const homeOrg = org === null ? await deepLinkHomeOrg(ctx, project) : null;
  sendPage(res, {
    title: `任务 · ${project}`,
    // v0.9.6 B5a：全局 `?project=` 详情页同款归「项目」高亮（口径 37/38）；空间档不套用
    active: org === null ? "projects" : "tasks",
    orgNav: org !== null ? { org, orgs: orgNav?.orgs ?? [] } : orgNav,
    // 增补四 件A（REQ-2026-10-02-04）：全局深链档同款不收全站口径说明（两档全摘）
    noNotes: true,
    bodyHtml: renderTasks(view, filter, org, homeOrg),
  });
}

async function pageProjects(ctx: PageCtx): Promise<Page> {
  const view = await ctx.client.getProjects();
  return { title: "项目 / 机器", active: "projects", bodyHtml: renderProjects(view) };
}

/**
 * `GET /agents` Agent View 页（v0.9.3 B-T3 · 只读）：
 * 机器表 = `/api/projects` 的 `runners` ∪ `machines` 归并；在飞任务区 = **逐 project 并发**
 * `GET /api/tasks`（照 N6 模式：单项超时、失败该项目灰化「不可达 ≠ 没有在飞」，**不炸页**）；
 * 页头 = 3300 页面退役后桥 identity/version 的唯一承载位（`GET <mcpBaseUrl>/health`，取不到 ⇒ 灰化）。
 * 零写、零缓存、零新增存储。
 */
async function pageAgents(ctx: Ctx): Promise<Page> {
  const view = await ctx.client.getProjects();
  const projectIds = [...new Set(view.machines.flatMap((m) => m.projects.map((p) => p.projectId)))];
  const settled = await Promise.all(
    projectIds.map(async (projectId): Promise<AgentTasksOutcome> =>
      ctx.agentTasks === null
        ? { ok: false, code: "agent_tasks_not_queried", error: "在飞任务查询器未装配" }
        : ctx.agentTasks(projectId).catch((err: unknown): AgentTasksOutcome => ({
            ok: false,
            code: "tasks_query_failed",
            error: err instanceof Error ? err.message : String(err),
          })),
    ),
  );
  const tasks = new Map<string, AgentTasksOutcome>();
  projectIds.forEach((projectId, i) => {
    if (!tasks.has(projectId)) tasks.set(projectId, settled[i] as AgentTasksOutcome);
  });
  let identity: AgentsPageInput["identity"] = null;
  if (ctx.bridgeIdentity !== null) {
    try {
      identity = await ctx.bridgeIdentity();
    } catch (err) {
      identity = { ok: false, code: "health_query_failed", error: err instanceof Error ? err.message : String(err) };
    }
  }
  const input: AgentsPageInput = {
    identity,
    identitySource: ctx.write.mcpBaseUrl,
    machineRows: buildMachineRows(view),
    inflight: buildInflightModel(view, tasks),
    observedAt: view.observedAt,
    ...(ctx.agentTasks === null
      ? { queryDisabledNote: "逐项目在飞任务查询器未装配 ⇒ 本页不查询任何项目的在飞任务（全部项目标为不可达）。" }
      : {}),
  };
  return { title: "Agent View", active: "agents", bodyHtml: renderAgentsPage(input) };
}

export function createBoardServer(options: CreateBoardServerOptions): Promise<BoardServerHandle> {
  assertLoopbackHost(options.host);
  const ctx: Ctx = {
    client: options.client ?? createBridgeClient(options.bridge ?? {}),
    now: options.now ?? Date.now,
    write: {
      defaultGroup: options.defaultGroup ?? null,
      mcpBaseUrl: options.mcpBaseUrl ?? DEFAULT_MCP_BASE_URL,
      createRequirement: options.createRequirementImpl ?? createRequirement,
      scheduleFeature: options.scheduleFeatureImpl ?? scheduleFeature,
      groupMemberWrite: options.groupMemberWriteImpl ?? writeGroupMembersWithRetry,
      releaseOrgGroup: options.releaseOrgGroupImpl ?? releaseOrgGroup,
      // v0.10.0 B2：版本写面改道引擎（`/api/versions*`，同 `mcpBaseUrl` = 可写面 8787）；无本地兜底。
      versions: options.versionsWriteImpl ?? createVersionsWriteClient({ baseUrl: options.mcpBaseUrl ?? DEFAULT_MCP_BASE_URL }),
    },
    host: options.hostFace ?? null,
    shutdown: options.onShutdown ?? null,
    docs: {
      repoRoot: options.docs?.repoRoot ?? defaultRepoRoot(),
      orgsDir: options.docs?.orgsDir ?? null,
      staticRoot: options.staticRoot ?? defaultStaticRoot(),
    },
    // v0.9.4 C 档/BD5：全组枚举走 3300 读面桥基址（与 `/api/projects` 同一面），非 MCP 单组连接。
    orgGroups:
      options.orgGroupsFetcher === undefined
        ? createOrgGroupsFetcher({ baseUrl: options.bridge?.baseUrl ?? DEFAULT_BRIDGE_BASE_URL })
        : options.orgGroupsFetcher,
    // N6 逐组项目查询器走 MCP 写面同基址（组身份 = 组织名 ⇒ `a2a_projects` 只看得见该组项目）。
    orgProjects:
      options.orgProjectsFetcher === undefined
        ? createOrgProjectsFetcher({ baseUrl: options.mcpBaseUrl ?? DEFAULT_MCP_BASE_URL })
        : options.orgProjectsFetcher,
    agentTasks:
      options.agentTasksFetcher === undefined
        ? createAgentTasksFetcher(options.client ?? createBridgeClient(options.bridge ?? {}))
        : options.agentTasksFetcher,
    bridgeIdentity:
      options.bridgeIdentityFetcher === undefined
        ? createBridgeIdentityFetcher({ baseUrl: options.mcpBaseUrl ?? DEFAULT_MCP_BASE_URL })
        : options.bridgeIdentityFetcher,
    orgsLedger: new OrgsLedgerStore(options.orgsLedgerFile ?? defaultOrgsLedgerFile()),
    versionsLedger: new VersionsLedgerStore(options.versionsLedgerFile ?? defaultVersionsLedgerFile()),
    // v0.10.0 B4：已发版锁的数据源 = 引擎版本台账投影（与写面同端 8787）；本地台账降为读缓存。
    engineVersions:
      options.engineVersionsFetcher ??
      createEngineVersionsFetcher({ baseUrl: options.mcpBaseUrl ?? DEFAULT_MCP_BASE_URL }),
    engineVersionsLastGood: null,
    engineVersionsFailure: null,
    engineVersionsInFlight: null,
    suspendLedger: options.suspendLedgerStore ?? new SuspendLedgerStore(options.suspendLedgerFile ?? defaultSuspendLedgerFile()),
    orgSeed: options.orgSeed === undefined || options.orgSeed === null
      ? null
      : resolveOrgSeedOptions(options.orgSeed, { repoRoot: options.docs?.repoRoot }),
  };
  // v0.9.5 C10：启动幂等回填 —— **listen 前** best-effort（只补缺不覆盖、逐组织 fail-open、
  // 跳过已停用组织）。任何异常都不得阻断板启动；`orgSeed === null` ⇒ 整段跳过（既有行为不变）。
  if (ctx.orgSeed !== null) {
    try {
      const { ledger } = ctx.orgsLedger.load();
      const backfill = backfillOrgWorkspaces({
        orgsDir: ctx.docs.orgsDir,
        disk: listOrgDirs(ctx.docs.orgsDir),
        ledger: enabledOrgNames(ledger),
        disabled: disabledOrgNames(ledger),
        options: ctx.orgSeed,
      });
      logOrgSeedWarnings(backfill.warnings);
      if (backfill.orgs.length > 0) {
        const stats = summarizeSeedResults(backfill.results);
        process.stdout.write(
          `组织种子化回填（v0.9.5 C10）：扫描 ${String(backfill.orgs.length)} 个在用组织，` +
            `补建 ${String(stats.created)} 个文件、跳过 ${String(stats.skipped)} 个已存在文件` +
            `（只补缺不覆盖；逐组织 fail-open）\n`,
        );
      }
    } catch (err) {
      // backfillOrgWorkspaces 自身零抛；本条为最后兜底 —— 绝不因回填把板挡在 listen 之前。
      process.stderr.write(`[org-seed] 启动回填意外失败（已忽略，不阻断板启动）：${errText(err)}\n`);
    }
  }
  const server: Server = createServer((req, res) => {
    void handle(req, res, server, ctx).catch((err: unknown) => {
      if (res.headersSent) {
        res.end();
        return;
      }
      respondError(res, req.headers.accept, 500, "internal_error", errText(err));
    });
  });
  return new Promise<BoardServerHandle>((resolve, reject) => {
    server.once("error", reject);
    server.listen(options.port, options.host, () => {
      const addr = server.address();
      const boundPort = addr !== null && typeof addr === "object" ? addr.port : options.port;
      resolve({
        host: options.host,
        port: boundPort,
        close: () => closeServer(server),
        suspendLedger: ctx.suspendLedger,
      });
    });
  });
}

const TRACE_SUFFIX = "/trace";
/** `?limit=` 上界（REQ-v0.9.2 N4）：越界与格式错误同样落结构化 400，防超大值直传桥。 */
const MAX_TASKS_LIMIT = 500;
/**
 * 空间任务页「查询前默认带出」的条数（REQ-2026-09-30-04 件5 · 原型 v2.3 样张④：不再空屏）。
 * 只作用于选单档的首屏预览那**一次**只读 `getTasks`，与用户手填 `?limit=` 无关。
 */
const TASKS_PREVIEW_LIMIT = 10;
/** 单文档子路径（BD11）：`GET /features/:id/docs?file=<name>`。 */
const DOCS_SUFFIX = "/docs";

/** `/static/` 名字段解码（异常编码 ⇒ null，不抛）。 */
function decodeURIComponentSafe(value: string): string | null {
  try {
    return decodeURIComponent(value);
  } catch {
    return null;
  }
}

/** `/static/` 段卫生（BD14）：单段、无分隔符 / 点段 / 冒号 / 百分号（白名单精确匹配前的第一道）。 */
function isSafeStaticName(name: string): boolean {
  return (
    name !== "" &&
    !name.includes("/") &&
    !name.includes("\\") &&
    !name.includes(":") &&
    !name.includes("%") &&
    !name.includes("..")
  );
}

/** 宿主面未装配（板进程未接 BD4a / BD4b）时的统一码与文案。 */
const HOST_FACE_DISABLED_CODE = "host_face_disabled";
const HOST_FACE_DISABLED_DISPLAY =
  "宿主面未装配：本板进程未接上「组织目录根」（config.json 的 orgsDir 未配置，无缺省值）⇒ 不起桥、详情页动作区不可用";

type PageRoute = { kind: "feature" | "feature-docs"; id: string } | { kind: Exclude<NavKey, "features"> } | null;

function matchPage(pathname: string): PageRoute {
  // v0.9.4 §9-b（首页形态 B→A）：`/` = 组织门户（REQ-v0.9.2 N1 的「`/` ∪ `/schedule` 同 kind」别名关系就此拆返）。
  if (pathname === "/") return { kind: "home" };
  // v0.9.6 B5a：`/schedule` 全局排期看板退役 ⇒ 不再注册读面路由（GET 303 回门户在 handle 先行处理；
  // 排期面唯一承载位 = 组织空间 `/org/<名>/schedule`，建版本入口自 B4 起亦只在那一页）。
  // REQ-2026-09-26-04 Q2：`/requirements` 列表页退役 ⇒ 不再注册读面路由（GET 重定向在 handle 先行处理）。
  // v0.9.6 C1：全局 `/tasks` 裸页退役 ⇒ 不再注册读面路由（GET 无/空 project ⇒ 303 回门户、非 GET ⇒ 405，
  // 均在 handle 退役块先行处理；`?project=X` 深链例外存活 ⇒ 走 handle 的 C1 显式分派，不在此注册）。
  if (pathname === "/projects") return { kind: "projects" };
  // REQ-2026-09-27-06 §9-c：`/orgs` 组织管理页同款退役 ⇒ 不再注册读面路由
  //（GET 303 回门户在 handle 先行处理；POST /orgs 写口照旧 = parseWriteRoute 白名单）。
  // REQ-2026-09-26-02 B-T3：Agent View（机器表 + 逐项目在飞任务 + 3300 收编的桥身份头）。
  if (pathname === "/agents") return { kind: "agents" };
  if (pathname === "/host") return { kind: "host" };
  if (pathname.startsWith("/features/")) {
    const raw = pathname.slice("/features/".length);
    const isDocs = raw.endsWith(DOCS_SUFFIX);
    const idPart = isDocs ? raw.slice(0, -DOCS_SUFFIX.length) : raw;
    if (idPart.length > 0 && !idPart.includes("/") && !idPart.endsWith(TRACE_SUFFIX)) {
      try {
        const id = decodeURIComponent(idPart);
        return isDocs ? { kind: "feature-docs", id } : { kind: "feature", id };
      } catch {
        return null;
      }
    }
  }
  return null;
}

/**
 * **已退役页面闭集（v0.9.6 B5a 起表驱动）**：路径 → 405 文案里的「退役说明」。
 * 命中即先于路由匹配处理：GET ⇒ 303 回门户（重定向不触桥；板惯例用 303，R1 裁决替代 301 留反悔余地）；
 * 非 GET ⇒ 405（写面白名单在更前面已分流，落到此处的非 GET 一律不放开 ⇒ `PUT /orgs` 的
 * 「405 文案列全写面」锚由此保留）。
 * - `GET /requirements` —— REQ-2026-09-26-04 Q2 需求列表页退役 ⇒ 回首页（§9-b 起 = 组织门户）；
 * - `GET /orgs`         —— REQ-2026-09-27-06 §9-c 组织管理页退役 ⇒ 回门户（管理职能迁 `/org/<名>/manage`）；
 * - `GET /schedule`     —— v0.9.6 B5a 全局排期看板退役 ⇒ 回门户（排期面唯一承载位 = 组织空间 `/org/<名>/schedule`）；
 * - `GET /tasks`        —— v0.9.6 C1 全局任务裸页退役 ⇒ 回门户（任务深链 `?project=X` 存活，见下表注）。
 */
const RETIRED_PAGES: ReadonlyMap<string, string> = new Map([
  ["/requirements", "GET /requirements 已改 303 回首页"],
  ["/orgs", "GET /orgs 已改 303 回门户（管理职能迁 /org/<名>/manage）"],
  ["/schedule", "GET /schedule 已改 303 回门户（排期面迁 /org/<名>/schedule）"],
  // C1 深链存活例外：`/tasks` 的退役判据 = pathname ∧ query —— GET 且 `project` 非空 ⇒ 不进本表判定
  // （任务表读面保留，判据执法点在 handle 退役块；非 GET 不带例外 —— 同退役先例 405）。
  ["/tasks", "GET /tasks 已改 303 回门户（任务深链 /tasks?project=X 保留）"],
]);

async function handle(
  req: IncomingMessage,
  res: ServerResponse,
  server: Server,
  ctx: Ctx,
): Promise<void> {
  let url: URL;
  try {
    url = new URL(req.url ?? "/", "http://board.invalid");
  } catch {
    respondError(res, req.headers.accept, 400, "bad_url", "无法解析请求 URL");
    return;
  }
  if (url.pathname === "/health" && req.method === "GET") {
    const addr = server.address();
    const port = addr !== null && typeof addr === "object" ? addr.port : 0;
    respondJson(res, 200, { status: "ok", version: readVersion(), port });
    return;
  }
  /**
   * BD13″ 优雅停机（运维路径，先于业务写面方法门）：仅 POST、仅 loopback 来源；
   * 200 = 受理（≠ 已停），停机经回调在响应发出后触发（`setImmediate`，不截断响应）。
   */
  if (url.pathname === "/shutdown") {
    const remote = req.socket.remoteAddress ?? "";
    const decision = decideShutdown({ method: req.method, remoteAddress: remote, chainWired: ctx.shutdown !== null });
    if (decision !== "accept") {
      if (decision.body.code === "loopback_only") {
        process.stderr.write(`${timestampPrefix("shutdown")}/shutdown 拒绝非 loopback 来源：${remote === "" ? "?" : remote}\n`);
      }
      respondJson(res, decision.status, decision.body);
      return;
    }
    respondJson(res, 200, { ok: true, message: "shutting_down" });
    const onShutdown = ctx.shutdown;
    setImmediate(() => {
      onShutdown?.();
    });
    return;
  }
  /** 方法门 = 读面白名单 ∪ 写面白名单（十条 POST，见 `write-guard.parseWriteRoute`）；其余非 GET 一律 405 */
  // v0.9.4 D 档（BD6）归一层：`/org/<名>/…` 前缀在方法门**之前**识别、剥离并校验
  // （组织不存在 404 / 已停用 410）；写路由保持全局唯一集合 —— 剥前缀后原样过
  // parseWriteRoute，空间组织经 spaceOrg 注入 handler（提需求的 mismatch 409 见 handleWriteRequirement）。
  let spaceOrg: string | null = null;
  if (url.pathname === "/org" || url.pathname.startsWith("/org/")) {
    const resolved = await readOrgSpaceRoute(ctx, url.pathname, req.method);
    if (resolved.status === "bridge_down") {
      spaceUniverseBridgeDown(res, req.headers.accept);
      return;
    }
    const spaceRoute = resolved.route;
    if (spaceRoute.kind === "failure") {
      respondSpaceFailure(res, req.headers.accept, spaceRoute);
      return;
    }
    // BD7：空间上下文（NAV 组织感知 + 顶栏切换器标当前组织）随本分支所有页面走
    // （resolve 对 `/org/` 前缀恒不返回 `unknown`，此处 `unknown` 仅作 TS 兜底 ⇒ 无组织可标）
    const spaceNav: PageOrgNav =
      spaceRoute.kind === "unknown"
        ? orgNavOf(ctx)
        : orgNavOf(ctx, spaceRoute.org, featureOrgGroups(resolved.features));
    if (req.method === "POST") {
      if (spaceRoute.kind !== "write") {
        respondError(
          res,
          req.headers.accept,
          405,
          "method_not_allowed",
          `组织空间读面族仅支持 GET（写面 = ${WRITE_ROUTES.join(" · ")}，表单 action 用全局路径；收到 ${req.method ?? "?"} ${url.pathname}）`,
          undefined,
          undefined,
          "schedule",
          spaceNav,
        );
        return;
      }
      spaceOrg = spaceRoute.org;
      url = new URL(spaceRoute.remainder, "http://board.invalid");
    } else if (
      spaceRoute.kind === "view" ||
      spaceRoute.kind === "feature_detail" ||
      spaceRoute.kind === "retired"
    ) {
      // 空间已知读面族（含 F2 退役形态）= GET-only（与全局方法门同口径：已知页面非 GET ⇒ 405）
      if (req.method !== "GET") {
        respondError(
          res,
          req.headers.accept,
          405,
          "method_not_allowed",
          `组织空间读面族仅支持 GET（写面 = ${WRITE_ROUTES.join(" · ")}，表单 action 用全局路径；收到 ${req.method ?? "?"} ${url.pathname}）`,
          undefined,
          undefined,
          "schedule",
          spaceNav,
        );
        return;
      }
      // F2（B5b · 口径 15）：`/org/<名>/features` 整页退役 ⇒ 303 落**同空间排期页**（非门户），不留 404 死面
      if (spaceRoute.kind === "retired") {
        res.writeHead(303, { location: orgSpaceLink(spaceRoute.org, "schedule"), "cache-control": "no-store" });
        res.end();
        return;
      }
      if (spaceRoute.kind === "feature_detail") {
        try {
          sendPage(res, { ...(await pageFeatureDetail(ctx, spaceRoute.featureId, spaceRoute.org)), orgNav: spaceNav });
        } catch (err) {
          sendPage(res, bridgeDownPage(`目标 = ${url.pathname}`, err, "features", spaceNav));
        }
        return;
      }
      try {
        if (spaceRoute.view === "schedule") {
          sendPage(res, await pageOrgSpaceSchedule(ctx, spaceRoute.org, resolved.features, spaceNav));
        } else if (spaceRoute.view === "manage") {
          sendPage(res, await pageOrgSpaceManage(ctx, spaceRoute.org, resolved.features, spaceNav));
        } else {
          await pageTasks(ctx, url, res, req.headers.accept, spaceRoute.org, spaceNav);
        }
      } catch (err) {
        sendPage(res, bridgeDownPage(`目标 = ${url.pathname}`, err, SPACE_ACTIVE, spaceNav));
      }
      return;
    } else {
      // 前缀下其余形态（/org/<名>/projects、/org/<名>/requirements 等）= 未知路径（空间外页面无归一语义）
      respondError(res, req.headers.accept, 404, "not_found", `未知路径 ${url.pathname}`);
      return;
    }
  }
  const writeRoute = parseWriteRoute(req.method, url.pathname);
  if (writeRoute !== null) {
    if (writeRoute.kind === "requirement") {
      await handleWriteRequirement(req, res, ctx, spaceOrg, spaceOrg !== null ? orgNavOf(ctx, spaceOrg) : undefined);
    } else if (writeRoute.kind === "turn") {
      await handleWriteTurn(req, res, ctx, writeRoute.featureId, "trigger");
    } else if (writeRoute.kind === "confirm") {
      await handleWriteTurn(req, res, ctx, writeRoute.featureId, "confirm");
    } else if (writeRoute.kind === "answer") {
      await handleWriteAnswer(req, res, ctx, writeRoute.featureId);
    } else if (writeRoute.kind === "stop_chain") {
      await handleWriteStopChain(req, res, ctx, writeRoute.featureId);
    } else if (writeRoute.kind === "suspend") {
      await handleWriteSuspend(req, res, ctx, writeRoute.featureId);
    } else if (writeRoute.kind === "schedule") {
      await handleWriteSchedule(req, res, ctx, writeRoute.featureId);
    } else if (writeRoute.kind === "orgs") {
      await handleWriteOrg(req, res, ctx);
    } else if (writeRoute.kind === "org_members") {
      await handleWriteOrgMembers(req, res, ctx, writeRoute.org);
    } else if (writeRoute.kind === "versions") {
      await handleWriteVersions(req, res, ctx, spaceOrg);
    } else {
      await handleWriteHostStop(req, res, ctx, writeRoute.org);
    }
    return;
  }
  const route = matchPage(url.pathname);
  /**
   * BD14 `/static/<名>`：vendored 资产端点（读面，恒 GET）。文件名 = `VENDORED_ASSETS` 白名单闭集
   * （`findVendoredAsset` 精确匹配，路径段卫生在拼接前完成）；缺文件 ⇒ 404，不列目录。
   * 响应带同源 CSP（页面以 `<script src>` 加载须 `script-src 'self'` 放行，见 layout.ts 放宽说明）。
   */
  if (url.pathname.startsWith("/static/")) {
    if (req.method !== "GET") {
      respondError(res, req.headers.accept, 405, "method_not_allowed", "/static 仅支持 GET");
      return;
    }
    const name = decodeURIComponentSafe(url.pathname.slice("/static/".length));
    const found = name !== null && isSafeStaticName(name) ? findVendoredAsset(ctx.docs.staticRoot, name) : null;
    if (found === null) {
      respondError(res, req.headers.accept, 404, "not_found", "静态资产不在白名单");
      return;
    }
    let buf: Buffer;
    try {
      buf = readFileSync(found.absPath);
    } catch {
      respondError(res, req.headers.accept, 404, "not_found", "静态资产文件缺失（见 README vendored 资产节）");
      return;
    }
    res.writeHead(200, {
      "content-type": found.asset.contentType,
      "cache-control": "no-store",
      "content-security-policy": BOARD_CSP,
    });
    res.end(buf);
    return;
  }
  /**
   * 已退役页面的 303 / 405 档（闭集与文案见 {@link RETIRED_PAGES}；重定向不触桥）。
   * C1 唯一的路径级例外：`/tasks?project=X`（X 非空）⇒ 深链存活 200（退役判据 = pathname ∧ query；
   * 例外仅认 GET —— 非 GET 一律走退役 405 档，带 project 也不放开。其余退役路径不受此支影响。
   * `project` 空值 = 无项目可列 ⇒ 与裸页同档退役）。
   */
  const retired = RETIRED_PAGES.get(url.pathname);
  if (
    retired !== undefined &&
    !(url.pathname === "/tasks" && req.method === "GET" && (url.searchParams.get("project") ?? "") !== "")
  ) {
    if (req.method === "GET") {
      res.writeHead(303, { location: "/", "cache-control": "no-store" });
      res.end();
      return;
    }
    respondError(
      res,
      req.headers.accept,
      405,
      "method_not_allowed",
      `${retired}；本路径仅支持 GET（写面 = ${WRITE_ROUTES.join(" · ")}，表单 action 用全局路径；收到 ${req.method ?? "?"} ${url.pathname}）`,
    );
    return;
  }
  // BD7：全局页面的组织上下文（org = null ⇒ NAV 落全局路径；切换器清单台账 ∪ 默认，不触桥）
  const globalNav = orgNavOf(ctx);
  /**
   * C1 深链存活通路（退役例外的正半支）：`GET /tasks?project=X`（X 非空）⇒ 任务表 200。
   * 不复经 matchPage 路由（`/tasks` 已摘 ⇒ route=null）—— 判据落在 pathname ∧ query 的**显式分派**。
   * 非 GET 到不了此处（上方退役块已按退役先例收 405）；pageTasks 的 `org===null ∧ 带 project`
   * 渲染分支（views.ts renderTasks）照常复用，不整删。
   */
  if (url.pathname === "/tasks" && (url.searchParams.get("project") ?? "") !== "") {
    try {
      await pageTasks(ctx, url, res, req.headers.accept, null, globalNav);
    } catch (err) {
      sendPage(res, bridgeDownPage(`目标 = ${url.pathname}`, err, "projects", globalNav));
    }
    return;
  }
  if (route === null) {
    respondError(res, req.headers.accept, 404, "not_found", `未知路径 ${url.pathname}`);
    return;
  }
  if (req.method !== "GET") {
    respondError(
      res,
      req.headers.accept,
      405,
      "method_not_allowed",
      `除已放开的写路径外仅支持 GET（写面 = ${WRITE_ROUTES.join(" · ")}；收到 ${req.method ?? "?"} ${url.pathname}）`,
    );
    return;
  }
  try {
    if (route.kind === "feature") {
      sendPage(res, { ...(await pageFeatureDetail(ctx, route.id)), orgNav: globalNav });
    } else if (route.kind === "feature-docs") {
      await handleFeatureDoc(ctx, res, req, route.id, url.searchParams);
    } else if (route.kind === "host") {
      sendPage(res, { ...(await pageHost(ctx, null)), orgNav: globalNav });
    } else if (route.kind === "home") {
      sendPage(res, await pageOrgPortal(ctx));
    } else if (route.kind === "agents") {
      // 口径 42 的「摘顶栏切换器」随件1 外壳退役：本页不单独摘挂，组清单统一在侧栏
      sendPage(res, { ...(await pageAgents(ctx)), orgNav: globalNav });
    } else {
      sendPage(res, { ...(await pageProjects(ctx)), orgNav: globalNav });
    }
  } catch (err) {
    sendPage(res, bridgeDownPage(`目标 = ${url.pathname}`, err, pageActiveOf(route), globalNav));
  }
}

/** 页面路由 → 导航高亮键（桥宕页随发起页高亮，REQ-v0.9.2 N2）。 */
function pageActiveOf(route: NonNullable<PageRoute>): NavKey {
  return route.kind === "feature" || route.kind === "feature-docs" ? "features" : route.kind;
}

// ---------------------------------------------------------------------------
// v0.9.4 D 档（BD6）：组织空间归一层的 server 侧装配
// ---------------------------------------------------------------------------

/** 空间归属与表单/路径组织不一致的结构化错误码（A4 预留；族名见 `views.ERROR_FAMILY_LABELS`）。 */
const ORG_MISMATCH = "board_org_mismatch";

/** 存在性 universe 读取失败（桥不可达）的统一结构化应答（写档 fail-closed，与建组织查重同规格）。 */
function spaceUniverseBridgeDown(res: ServerResponse, accept: string | undefined): void {
  respondError(
    res,
    accept,
    502,
    BRIDGE_UNREACHABLE_CODE,
    "组织空间归属判定需读既有需求的 ownerGroup 源 ⇒ 桥读不到即不放行（fail-closed）",
  );
}

/**
 * 归一层的 universe 装配（四源：盘枚举 ∪ 台账（在用）∪ 需求归属 ∪ 板级默认；§9-c 起 `/orgs` 页退役，
 * 读档与写档共用；写档同样先过桥（写口本就先判空间存在性，桥坏 fail-closed 不降级）。
 */
async function readOrgSpaceRoute(
  ctx: Ctx,
  pathname: string,
  method: string | undefined,
): Promise<
  { status: "bridge_down" } | { status: "route"; route: OrgSpaceRoute; features: FeatureListItem[] }
> {
  try {
    const view = await ctx.client.getFeatures();
    const universe = orgSpaceUniverseOf({
      disk: listOrgDirs(ctx.docs.orgsDir),
      ledger: ctx.orgsLedger.load().ledger,
      featureGroups: featureOrgGroups(view.features),
      defaultGroup: ctx.write.defaultGroup,
    });
    return { status: "route", route: resolveOrgSpaceRoute(pathname, universe, method), features: view.features };
  } catch {
    return { status: "bridge_down" };
  }
}

/**
 * 空间失败档（404 / 410）。**410 带「回门户」出路链接**（v0.9.4 增补五 §9.4-④）：
 * 停用后再访问该空间的人（书签 / 后退 / 顶栏遗留链接）不该困在错误页 —— 门户是停用语义下的正当落点。
 */
function respondSpaceFailure(res: ServerResponse, accept: string | undefined, route: Extract<OrgSpaceRoute, { kind: "failure" }>): void {
  if (route.failure === "gone") {
    respondError(
      res,
      accept,
      410,
      ORG_SPACE_GONE_CODE,
      `组织 ${route.orgRaw} 已在板台账停用 ⇒ 组织空间不再开放（在途部分在排期看板照常可见，未排期∧终态者经引擎查阅（组织空间需求清单读面已退役），管理页含空间与成员均 410；恢复 = 同名重建，零迁移）`,
      undefined,
      undefined,
      SPACE_ACTIVE,
      undefined,
      { href: "/", label: "回组织门户" },
    );
    return;
  }
  respondError(
    res,
    accept,
    404,
    ORG_SPACE_NOT_FOUND_CODE,
    `未知组织空间 /org/${route.orgRaw}/…（组织不存在，或名称段不合法 —— 两档同码，不给枚举留信号）`,
  );
}

/**
 * 顶栏组织切换器 + NAV 组织感知的上下文（BD7 · §9-b/§9-d 口径收口）。
 *
 * 清单 = {@link portalOrgNames}（**组织门户卡与切换器共用同一纯函数**）：台账在用名
 * （板台账 `.data/orgs.json` ∪ 宿主桥托管）∪ 需求归属（ownerGroup）∪ 板级默认，剔除停用名
 * （点了必 410）；**磁盘一级目录不再进**（盘遗留目录与外机组不构成板可见组织）。
 * `featureGroups` 只由**已持有需求列表的页面**喂入（门户 / 排期 / 组织管理 / 空间页 ⇒ 零新增触桥面）；
 * 其余页面（项目 / Agent / 宿主桥 / 写口回执）拿不到列表 ⇒ 传空，切换器退化为「台账 ∪ 默认」——
 * 不为一条导航链给全站页面各加一次桥查询（BD7 原留痕口径照旧成立）。
 * `specificOrg` = 当前空间组织：其空间路由已由存在性 universe 放行 ⇒ 必进清单，高亮不因源缺席而丢。
 */
function orgNavOf(ctx: Ctx, specificOrg?: string, featureGroups: readonly string[] = []): PageOrgNav {
  const ledger = ctx.orgsLedger.load().ledger;
  return {
    org: specificOrg ?? null,
    orgs: portalOrgNames({
      ledger: [...enabledOrgNames(ledger), ...(ctx.host?.managedOrgs?.() ?? [])],
      featureGroups,
      defaultGroup: ctx.write.defaultGroup,
      disabled: disabledOrgNames(ledger),
      current: specificOrg ?? null,
    }),
  };
}

/** 需求列表 → ownerGroup 源名单（trim + 去空 + 去重；供 {@link orgNavOf} 的 `featureGroups` 入参）。 */
function featureOrgGroups(features: readonly FeatureListItem[]): string[] {
  return [...new Set(features.map((f) => (f.ownerGroup ?? "").trim()).filter((n) => n !== ""))];
}

/**
 * 空间二级导航行（v0.9.6 B5b · 口径 14 / 19–23）：三枚 tab「排期 · 任务 · 管理」。
 * **REQ-2026-09-30-04 件1 的两处改动**：① 原行右组织切换器（{@link renderOrgSwitcher} 单点复用）撤除
 * ⇒ 组织切换形态改为**侧栏二级菜单**（功能语义不变，仍是各组织 → `/org/<名>/` 的服务端渲染链接）；
 * ② 显示文案改名「组织空间」→「项目组空间」（**URL `/org/<名>`、台账键名、目录名、代码标识符一律不动**）。
 * 「需求」枚随 `/org/<名>/features` 整页退役；末段「← 回全局」撤（回全局动线由侧栏一级菜单承担）。
 * 当前视图在 inline `font-weight:700` 之外另挂 `class="fl on"` —— 空间页位置的唯一断言钩子。
 *
 * **件2（REQ-2026-09-30-04）**：`view = null` ⇒ **无激活态**档（需求详情页也携带本行，作空间上下文与
 * 返回口；本行不属于任何一档视图，故不得高亮任一枚）。tab 行外套 `<div class="b-tabs">` 供样式定位，
 * `<p class="hint">项目组空间 …` 的原文形态逐字不动（BD7 的窗口定界锚靠它）。
 */
function renderSpaceNav(org: string, view: OrgSpaceView | null): string {
  const link = (v: OrgSpaceView, text: string): string =>
    `<a class="fl${v === view ? " on" : ""}" href="${escapeHtml(orgSpaceLink(org, v))}"${v === view ? ' style="font-weight:700"' : ""}>${text}</a>`;
  return `<div class="b-tabs"><p class="hint">项目组空间 <b>${escapeHtml(org)}</b>：${link("schedule", "排期")} · ${link("tasks", "任务")} · ${link("manage", "管理")}</p></div>`;
}

/**
 * 详情页的空间归属（件2 tab 行的数据源，三态）：
 * - 空间路由进来 ⇒ 用路由组织（存在性 / 停用已由 `resolveOrgSpaceRoute` 放行）；
 * - 全局 `/features/:id` 进来 ⇒ 回落该卡 `ownerGroup`（trim 后非空 ∧ **未停用** ⇒ 才给行；
 *   停用名点了必 410 ⇒ 不给死链）；
 * - 两者皆空 / 归属缺失 ⇒ `null` ⇒ 详情页不渲 tab 行（**不臆造默认组织**，同 C3 深链页头口径）。
 */
function detailSpaceOrg(ctx: Ctx, routeOrg: string | null | undefined, ownerGroup: string | null | undefined): string | null {
  const fromRoute = (routeOrg ?? "").trim();
  if (fromRoute !== "") return fromRoute;
  const fromCard = (ownerGroup ?? "").trim();
  if (fromCard === "") return null;
  const disabled = disabledOrgNames(ctx.orgsLedger.load().ledger);
  return disabled.includes(fromCard) ? null : fromCard;
}

/**
 * `GET /org/<名>/`（D 档空间首页 = 排期看板，按 ownerGroup 过滤）：
 * 正文走 {@link renderScheduleBoard}/{@link schedulePageScripts} 单点（B5a 起本页是该单点**唯一**调用方），
 * 数据先过 {@link featuresOfOrg} 过滤。
 * 提需求弹窗 = BD8 免选形态（组织只读展示 + hidden 值必发，action 带空间前缀）；
 * 组织归属 mismatch 执法见 `handleWriteRequirement`。
 * **建版本入口归本页（v0.9.6 B4 · 口径 4 / 24）**：页头「＋ 新版本」按钮 + {@link renderNewVersionDialog}
 * 骨架同批在位（骨架由 {@link renderScheduleBoard} 在 `spaceOrg !== null` 档渲染）——台账按
 * `(org, version)` 成域后，本页是**全站唯一**的登记新版本入口（全局 `/schedule` 那份已随 B5a 整页退役）。
 * **v0.10.1 B4**：「各 project 版本」区块随本页出（喂入点在 {@link renderScheduleBoard}，
 * 容器在 `#schedule-board` **之外**）—— 本页不另拼区块 HTML、不新增脚本（内联脚本闭集仍七元）。
 */
async function pageOrgSpaceSchedule(ctx: Ctx, org: string, all: readonly FeatureListItem[], orgNav: PageOrgNav): Promise<Page> {
  const features = featuresOfOrg(all, org);
  const ledger = ctx.versionsLedger.load().ledger;
  return {
    title: `空间 · ${org} · 排期`,
    active: "schedule",
    orgNav,
    // 「＋ 新版本」与「＋ 新增需求」同规格：服务端 `hidden` ⇒ 无 JS 不显死按钮，显形与点击经 wireNewVersion 委托 wire()
    headerActions:
      '<button type="button" id="new-req-open" class="header-actions">＋ 新增需求</button>' +
      '<button type="button" id="new-version-open" class="header-actions" hidden>＋ 新版本</button>',
    // B5b ⑤：看板页头 `<h2>` 由本页给出（`renderSchedule` 不再自带）
    bodyHtml: `${renderSpaceNav(org, "schedule")}<h2>排期看板</h2>${await renderScheduleBoard(ctx, features, ledger, org)}`,
    // 增补三 件B（REQ-2026-10-02-03）：排期页不收全站口径说明（复用增补二 `noNotes` 单点开关）
    noNotes: true,
    extraScripts: schedulePageScripts(ctx),
  };
}

/** 空间三页宕页/桥宕档的高亮统一挂「排期」（NAV 组织感知见 {@link orgNavOf}）。 */
const SPACE_ACTIVE: NavKey = "schedule";

/**
 * `GET /org/<名>/manage`（v0.9.4 §9-c · REQ-2026-09-27-06 N3）：**空间内管理页** ——
 * `/orgs` 组织管理页退役后，成员管理与停用操作在本组织空间内承接：
 * - **成员区** = 该组声明态成员清单（3300 `GET /api/groups` 投影）+ 增 / 删表单
 *   （action 复用既有全局写口 `POST /orgs/{org}/members`，服务端零改动）；
 * - **停用操作** = `POST /orgs`（隐藏 `action=disable`，同写口分流）；成功 303 回 `/` 即门户；
 * - **项目区** = 本组运行态项目（只读 `a2a_projects`，组身份 = 组织名；与声明态成员清单并存、不替代）；
 * - 需求简表 = 归一层已持有的该组需求投影（`resolved.features`，**零新增触桥面**）。
 * 停用组织进本路由已由归一层挡下（410 `board_org_space_gone`，同空间口径）。
 */
async function pageOrgSpaceManage(ctx: Ctx, org: string, all: readonly FeatureListItem[], orgNav: PageOrgNav): Promise<Page> {
  const groupsOutcome =
    ctx.orgGroups === null
      ? Promise.resolve<OrgGroupsOutcome | null>(null)
      : ctx.orgGroups().catch((err: unknown): OrgGroupsOutcome => ({
          ok: false,
          code: "groups_query_failed",
          error: err instanceof Error ? err.message : String(err),
        }));
  const projectsOutcome =
    ctx.orgProjects === null
      ? Promise.resolve<OrgProjectsOutcome | null>(null)
      : ctx.orgProjects(org).catch((err: unknown): OrgProjectsOutcome => ({
          ok: false,
          code: "org_query_failed",
          error: err instanceof Error ? err.message : String(err),
        }));
  // v0.9.8 项目池恒空修复（REQ-2026-10-03-02 · N3）：左栏「项目池」= **注册表全量机器项目** − 全组声明面。
  // 左集换源为 N2 的 `getRegistryProjects()`（`GET /api/registry/projects`，遍历源 = runners 表，含离线机项目、
  // 无组布尔）。旧面 `getProjects()`（`/api/projects`）在服务端是**全组声明成员的并集**，与减集
  // （`/api/groups`，同样是声明面）**同域 ⇒ 差集构造性恒空**（无组归属者根本进不了左集）；换源后
  // 未归属项才落到池面。**减集仍取 `/api/groups`**（组声明面），板为**唯一**差集执行处（B-7）。
  // 读失败 / 形状不合（缺 `machines[]` ⇒ `parseRegistryProjects` fail-closed 抛出）⇒ 快照 `ok=false`，
  // 由 `computeProjectPool` 连带降级（**不给假池、更不降级成空池**），页面其余照常。
  // **`await` 在 try 内**：快照读的任何失败（含同步抛出 —— 注入的 client 缺该方法即 TypeError）
  // 一律收口为降级；否则整页 502（本区四档灰化先例：单面不可用不炸页）。
  const snapshotOutcome = (async (): Promise<ProjectSnapshotOutcome> => {
    try {
      const view = await ctx.client.getRegistryProjects();
      return { ok: true, rows: poolRowsFromSnapshot(view), observedAt: view.observedAt };
    } catch (err: unknown) {
      return { ok: false, code: "snapshot_unreachable", error: errText(err) };
    }
  })();
  const [groups, projects, snapshot] = await Promise.all([groupsOutcome, projectsOutcome, snapshotOutcome]);
  const poolOutcome = computeProjectPool(snapshot, groups);
  // v0.9.8 按项目组配 agent：配置卡数据源 = 本次已读台账记录 + configView（零新读面；宿主面未装配 ⇒ 全局两键 null）
  const orgRec = findOrgRecord(ctx.orgsLedger.load().ledger, org);
  const faceConfig = ctx.host === null ? null : ctx.host.configView();
  return {
    title: `空间 · ${org} · 管理`,
    active: SPACE_ACTIVE,
    orgNav,
    // 增补四 件B（REQ-2026-10-02-04）：管理页不收全站口径说明（复用 `noNotes` 单点开关；成员写回执入口复用本函数 ⇒ 两入口同效）
    noNotes: true,
    // v0.9.8 两栏拖拽（REQ-2026-10-03-02）：第七枚脚本**仅本页**注入（页隔离由入口守卫 `#member-pool` 承担；
    // 成员写成功回执也复用本函数 ⇒ 回执页同样可继续拖拽）
    extraScripts: MEMBER_DRAG_SCRIPT,
    bodyHtml:
      renderSpaceNav(org, "manage") +
      renderOrgSpaceManagePage({
        org,
        features: featuresOfOrg(all, org),
        groupsOutcome: groups,
        projectsOutcome: projects,
        poolOutcome,
        // B-3（REQ-2026-10-03-02）：左集规模只服务空态两分支的字面（不入差集、不参与判定）。
        poolSourceCount: snapshot.ok ? snapshot.rows.length : null,
        hostAgent: {
          orgKind: orgRec?.agentKind ?? null,
          orgModel: orgRec?.agentModel ?? null,
          globalKind: faceConfig?.kind ?? null,
          globalModel: faceConfig?.hostModel ?? null,
        },
      }),
  };
}

// ---------------------------------------------------------------------------
// BD7 / BD8 / M3 / v0.9.4 A1 / BD4 写面（八条放开的 POST；CSRF 守卫与结构化错误口径同一规格）
// ---------------------------------------------------------------------------

function lowerHeaders(req: IncomingMessage): Record<string, string | undefined> {
  const out: Record<string, string | undefined> = {};
  for (const [k, v] of Object.entries(req.headers)) {
    out[k.toLowerCase()] = Array.isArray(v) ? v[0] : v;
  }
  return out;
}

/** 带硬上限地读请求体（超限即断连并报 413，不无界缓冲）。 */
function readBodyCapped(req: IncomingMessage, max: number): Promise<string> {
  return new Promise<string>((resolve, reject) => {
    const chunks: Buffer[] = [];
    let size = 0;
    req.on("data", (c: Buffer) => {
      size += c.length;
      if (size > max) {
        reject(Object.assign(new Error("payload_too_large"), { code: "payload_too_large" }));
        req.destroy();
        return;
      }
      chunks.push(c);
    });
    req.on("end", () => resolve(Buffer.concat(chunks).toString("utf8")));
    req.on("error", reject);
  });
}

/**
 * 提需求表单失败回填（REQ-v0.9.2 N1）：从已收取的 urlencoded 原始 body 提取非空提交值，
 * 供浮层回显。body 不可解析 / 字段全空 ⇒ 空数组（浮层与无回填时逐字节一致）。
 * **免选态（BD8，`spaceOrg` 非空）隐去组织字段** —— 组织由路径决定、非用户可改的提交值，回显无意义。
 */
function requirementBackfillFields(body: string, spaceOrg: string | null = null): ErrorOverlayField[] {
  const f = new URLSearchParams(body);
  const fields: ErrorOverlayField[] = [];
  for (const [key, label] of [
    ["group", "组织"],
    ["title", "标题"],
    ["version", "版本"],
    ["requirement", "需求描述"],
  ] as const) {
    if (key === "group" && spaceOrg !== null) continue;
    const value = (f.get(key) ?? "").trim();
    if (value !== "") fields.push({ label, value });
  }
  return fields;
}

async function handleWriteRequirement(
  req: IncomingMessage,
  res: ServerResponse,
  ctx: Ctx,
  spaceOrg: string | null = null,
  orgNav?: PageOrgNav,
): Promise<void> {
  const headers = lowerHeaders(req);
  // ① CSRF 守卫先于一切（未认证请求不消耗 body 读取、也不泄露板配置）
  const auth = checkWriteAuth({ method: req.method, headers, proto: "http" });
  if (!auth.ok) {
    respondError(res, headers.accept, 403, auth.code, auth.error);
    return;
  }
  // ② 入参校验（空 title/version ⇒ 400；组织名见 `parseRequirementForm`：**表单 > 板级默认**，
  //    两者皆空 ⇒ 400 `board_group_required` —— BD11 起校验点在请求期，板级默认未配置不是错误）
  let body: string;
  try {
    body = await readBodyCapped(req, MAX_REQUIREMENT_BODY_BYTES);
  } catch (err) {
    const code = errText(err) === "payload_too_large" ? "payload_too_large" : "body_read_failed";
    respondError(res, headers.accept, code === "payload_too_large" ? 413 : 400, code, errText(err));
    return;
  }
  const form = parseRequirementForm(body, Number(headers["content-length"] ?? NaN), ctx.write.defaultGroup);
  if (!form.ok) {
    respondError(res, headers.accept, form.status, form.code, form.error, undefined, requirementBackfillFields(body, spaceOrg));
    return;
  }
  // ②b 空间档提需求（v0.9.4 D 档 / BD6+BD8）：写路由归一后 spaceOrg = 路径组织，**以路径为准**——
  //     表单组织与路径不一致 ⇒ 409 `board_org_mismatch`；**空间档禁板级默认回落**
  //     （组织上下文只认路径）。BD8 表单侧已免选（只读展示 + hidden 值必发、action 带前缀），
  //     本执法仍是服务端事实源（篡改 hidden / 直投 API 同拒）。
  if (spaceOrg !== null) {
    if (form.group !== spaceOrg) {
      respondError(
        res,
        headers.accept,
        409,
        ORG_MISMATCH,
        `表单组织（${form.group}）与组织空间路径（${spaceOrg}）不一致 ⇒ 以路径为准拒写（跨组织提需求请改走对应组织空间的排期页）。`,
        undefined,
        requirementBackfillFields(body, spaceOrg),
        "schedule",
        orgNav,
      );
      return;
    }
  }
  // ③ 已发版锁（REQ-v0.9.2 增补 ⑤ N2 / v0.9.4 N3 锁读台账 / **v0.10.0 B4 锁读引擎投影**）：
  //    目标版本 ∈ 引擎版本台账 released ⇒ 409 零出网。
  //    锁判据唯一走 `isVersionLocked`（trim 后精确串匹配，禁前缀，**本版零改动**）；
  //    空 version = 未排期 ⇒ 恒不锁、放行（未排期不进锁判定，也就不需投影在场）。
  //    **fail-closed**：已排版本 ∧ 拿不到引擎台账投影 ⇒ 503 拒写（§2.3(1)「锁只紧不松」），
  //    **不回落本地台账、绝不当作「零个已发版」放行**。
  //    **锁的 org 维**（v0.9.6 B3 · 口径 29）= 三段回退 `spaceOrg ?? form.group ?? ctx.write.defaultGroup`
  //    （`form.group` 已由 `parseRequirementForm` 做过「表单 > 板级默认」回落 ⇒ 与下方 ③b
  //    `isOrgDisabled` 的归属解析同源，不新立一套）；台账唯一键 `(org, version)` ⇒ 他组织同版号不锁本条。
  const lockOrg = (spaceOrg ?? form.group ?? ctx.write.defaultGroup ?? "").trim();
  if (normalizeVersion(form.version) !== "") {
    const projection = await versionProjectionOf(ctx);
    if (projection === null) {
      respondVersionProjectionClosed(res, ctx, headers.accept, requirementBackfillFields(body, spaceOrg));
      return;
    }
    if (isVersionLocked(form.version, releasedVersionNames(versionProjectionLedgerOf(projection), lockOrg))) {
      respondError(
        res,
        headers.accept,
        409,
        "board_version_released",
        `版本 ${form.version} 已发版 ⇒ 已发版版本不可排入新需求。请排入后续版本（锁的事实源 = 引擎版本台账；在引擎把该版标记 released / 重开为进行中即实时生效）。`,
        undefined,
        requirementBackfillFields(body, spaceOrg),
      );
      return;
    }
  }
  // ③b 停用组织不可提新需求（v0.9.4 A4 · BD3）：目标组织在板台账被标记停用 ⇒ 409 拒绝（零出网）。
  //    判据单一纯函数 = `orgs-ledger.isOrgDisabled`（与 D 档归属 mismatch 校验同落点，可共享）。
  if (isOrgDisabled(ctx.orgsLedger.load().ledger, form.group)) {
    respondError(
      res,
      headers.accept,
      409,
      ORG_DISABLED,
      `组织 ${form.group} 已在板台账停用 ⇒ 不可提新需求（不起桥、不进该组织工作区）。恢复 = 用同名重新建组织（零迁移），或改选其它组织。`,
      undefined,
      requirementBackfillFields(body, spaceOrg),
    );
    return;
  }
  // ④ 复用唯一写封装（不新写 MCP 调用）；组身份 = 表单组织名（缺省才回落板级默认）
  //    v0.9.4 N4 semver 收口（§2.5）：非法版本号由封装先于网络抛 RequirementConfigError
  //    （属入参不合法，非服务端故障）⇒ 归一为结构化 400，不裸 500。
  let outcome: CreateRequirementOutcome;
  try {
    outcome = await ctx.write.createRequirement(
      { title: form.title, version: form.version, requirement: form.requirement },
      { group: form.group, baseUrl: ctx.write.mcpBaseUrl },
    );
  } catch (err) {
    if (err instanceof RequirementConfigError) {
      respondError(res, headers.accept, 400, "requirement_form_invalid", errText(err), undefined, requirementBackfillFields(body, spaceOrg));
      return;
    }
    throw err;
  }
  if (!outcome.ok) {
    respondError(
      res,
      headers.accept,
      502,
      outcome.code,
      outcome.error,
      undefined,
      [
        ...(spaceOrg === null ? [{ label: "组织", value: form.group }] : []),
        { label: "标题", value: form.title },
        { label: "版本", value: form.version },
        ...(form.requirement === undefined ? [] : [{ label: "需求描述", value: form.requirement }]),
      ],
    );
    return;
  }
  // ④b v0.9.5 增补三「建卡即自动首轮」：建卡成功后**只点火、不等收口**（见 {@link fireAutoFirstTurn}）
  //     —— 落在 ⑤ 两条回显档之前点火，JSON 档 201 与表单档 303 共用同一次点火。
  fireAutoFirstTurn(ctx, outcome.featureId, form.group, form.version);
  // ⑤ 回显：浏览器表单 ⇒ 303 跳详情页（PRG，刷新不重复建）；声明 accept: application/json ⇒ 201 JSON
  const accept = headers.accept ?? "";
  if (accept.includes("application/json")) {
    respondJson(res, 201, {
      ok: true,
      featureId: outcome.featureId,
      /** 本条需求实际使用的组织名（表单优先，未填时回落板级默认）—— 归属可核对。 */
      group: form.group,
      state: outcome.state,
      stage: outcome.stage,
      version: outcome.version,
      approval: outcome.approval,
    });
    return;
  }
  res.writeHead(303, { location: `/features/${encodeURIComponent(outcome.featureId)}`, "cache-control": "no-store" });
  res.end();
}

/** 自动首轮的留痕标签（可 grep 前缀；建卡日志里点名是这条轨点的火，不是人工触发）。 */
const AUTO_FIRST_TURN_TAG = "[auto-first-turn]";

/**
 * **建卡即自动首轮**（v0.9.5 增补三）：以本条实际生效的组织名为 {@link BoardHostFace.triggerTurn}
 * 点一发**纯触发**（无补充文本 ⇒ 提示词与动作区「留空 = 只说『继续』」同档；不扩表单字段）。
 *
 * - **不等收口**：`triggerTurn` 对在飞轮要等 `submitted.done`（至多 `turnTimeoutMs` = 10 分钟）⇒
 *   本函数**不 await**，建卡响应的时延与语义（201 / 303）与点火成败无关；收口结论迟到即日志。
 * - **不污染建卡**：宿主面未装配 / 桥不可达 / 起桥抛错一律留一行结构化日志后吞掉，绝不上抛。
 * - **防重**：复用宿主面既有同需求 occupant 判定（在飞 / 排队轮 ⇒ `disposition=busy`，不入队），
 *   故连点与「先手工点过再建卡」都不产生两轮并发。
 */
function fireAutoFirstTurn(ctx: Ctx, featureId: string, org: string, version: string): void {
  const face = ctx.host;
  if (face === null) {
    process.stderr.write(
      `${timestampPrefix("board")}${AUTO_FIRST_TURN_TAG} 放弃 featureId=${featureId} org=${org} 结果=未点火 :: 宿主面未装配（hostFace=null，无桥可起）\n`,
    );
    return;
  }
  void face
    .triggerTurn({ featureId, org, version })
    .then((outcome) => {
      const verb = outcome.disposition === "busy" ? "放弃" : outcome.ok ? "已点火" : "失败";
      const reason = outcome.error === null ? "" : ` :: ${outcome.error.code} ${outcome.error.message}`;
      // 「放弃」是防重命中的正常分流（不是故障）⇒ 与成功同用 board 档，仅真失败落 error 档
      const tag = outcome.ok || outcome.disposition === "busy" ? "board" : "error";
      process.stderr.write(
        `${timestampPrefix(tag)}${AUTO_FIRST_TURN_TAG} ${verb} featureId=${featureId} org=${org}` +
          ` 结果=${outcome.disposition} 轮=${outcome.turnId ?? "-"}${reason}\n`,
      );
    })
    .catch((err: unknown) => {
      process.stderr.write(
        `${timestampPrefix("error")}${AUTO_FIRST_TURN_TAG} 失败 featureId=${featureId} org=${org} 结果=throw :: ${errText(err)}\n`,
      );
    });
}

// ---------------------------------------------------------------------------
// v0.9.4 A1/A3 写面：POST /orgs（一条路由，`action` 分「建 / 停用」；板侧组织台账本地写，不触桥、不写状态机、不写 machine 配置）
// ---------------------------------------------------------------------------

/** 三源重名闸命中源 → 文案点名（让用户知道「和谁重了」）。 */
const ORG_CONFLICT_SOURCE_LABEL: Record<OrgNameConflictSource, string> = {
  disk: "组织目录根下的一级目录（磁盘已有）",
  ledger: "板组织台账（.data/orgs.json）",
  featureGroup: "既有需求的归属组织",
};

/** 建组织表单失败回填（口径同 {@link requirementBackfillFields}：只回显非空提交值）。 */
function orgBackfillFields(body: string): ErrorOverlayField[] {
  const value = (new URLSearchParams(body).get("org") ?? "").trim();
  return value === "" ? [] : [{ label: "组织", value }];
}

/**
 * 建组织成功路径的目录供给：**幂等单级** mkdir —— 目录已在 = 成功（不覆盖、不清空）；
 * 刻意不共用 `host-bridge.ts` 的 `prepareWorkspace`（起桥侧的同名供给，报错文案面向 spawn），
 * 也刻意不用 recursive：`orgsDir` 根是**部署面**，存在性已由写入前置闸把关，**根不代建**。
 * 建不成（该路径被文件占用 / 权限不足）⇒ 抛出，由调用方落结构化错误。
 */
function mkdirOrgDir(dir: string): void {
  try {
    mkdirSync(dir);
  } catch (err) {
    // EEXIST 只对「确实是目录」豁免：被文件占用时 mkdir 同样抛 EEXIST，不得当成已就绪。
    if ((err as NodeJS.ErrnoException).code === "EEXIST" && statDirKind(dir) === "dir") return;
    throw err;
  }
}

/** 建组织成功但组织目录建不出来（路径被文件占用 / 权限不足）⇒ 结构化错误码。 */
const ORG_DIR_CREATE_FAILED = "board_org_dir_create_failed";

async function handleWriteOrg(req: IncomingMessage, res: ServerResponse, ctx: Ctx): Promise<void> {
  const headers = lowerHeaders(req);
  // ① CSRF 守卫先于一切（与其它写口同规格：未认证请求不消耗 body 读取）
  const auth = checkWriteAuth({ method: req.method, headers, proto: "http" });
  if (!auth.ok) {
    respondError(res, headers.accept, 403, auth.code, auth.error);
    return;
  }
  // ② 表单解析 + 组织名字符集闭集校验（单一纯函数 validateOrgName，经 parseOrgForm）
  let body: string;
  try {
    body = await readBodyCapped(req, MAX_REQUIREMENT_BODY_BYTES);
  } catch (err) {
    const code = errText(err) === "payload_too_large" ? "payload_too_large" : "body_read_failed";
    respondError(res, headers.accept, code === "payload_too_large" ? 413 : 400, code, errText(err));
    return;
  }
  const form = parseOrgForm(body, Number(headers["content-length"] ?? NaN));
  if (!form.ok) {
    respondError(res, headers.accept, form.status, form.code, form.error, undefined, orgBackfillFields(body));
    return;
  }
  // ③′ 动作分流（v0.9.4 A3/BD3）：一条 `POST /orgs` 靠 `action` 分「建 / 停用」，白名单不扩条。
  if (form.action === ORG_ACTION_DISABLE) {
    await handleDisableOrg(res, headers, ctx, form.name, body);
    return;
  }
  // ③″ v0.9.8 按项目组配 agent：`setHostAgent` 只写台账两键，**不建组织** ⇒ 必须先于 orgsDir 根闸与
  // 三源重名闸 return（照 disable 先例；漏分流转而会走建组织）。
  if (form.action === ORG_ACTION_SET_HOST_AGENT) {
    await handleSetOrgHostAgent(res, headers, ctx, form.name, body);
    return;
  }
  // ③ 写入前置闸：组织目录**根必须存在**（diagnoseOrgsDir 口径；未配置与不可用是两回事，**根不代建、不回落**）
  const orgsDir = ctx.docs.orgsDir;
  if (orgsDir === null) {
    respondError(
      res,
      headers.accept,
      503,
      ORGS_DIR_NOT_CONFIGURED,
      "组织目录根未配置（config.json 的 orgsDir 留空/缺键，无缺省值）⇒ 建组织没有磁盘落点面，不回落任何兜底路径；请先配置 orgsDir 并重启板",
      undefined,
      orgBackfillFields(body),
    );
    return;
  }
  const problem = diagnoseOrgsDir(orgsDir, statDirKind(orgsDir));
  if (problem !== null) {
    respondError(res, headers.accept, 503, problem.code, problem.message, undefined, orgBackfillFields(body));
    return;
  }
  // ④ 三源重名闸：盘枚举 ∪ 板台账 ∪ 需求 ownerGroup（A2）；桥读不动 ⇒ fail-closed 不建
  let featureGroups: string[];
  try {
    const view = await ctx.client.getFeatures();
    featureGroups = view.features.map((f) => (f.ownerGroup ?? "").trim()).filter((n) => n !== "");
  } catch (err) {
    respondError(
      res,
      headers.accept,
      502,
      BRIDGE_UNREACHABLE_CODE,
      `建组织查重需读既有需求的 ownerGroup 源 ⇒ 桥读不到即不建（fail-closed）：${errText(err)}`,
      undefined,
      orgBackfillFields(body),
    );
    return;
  }
  const conflict = findOrgNameConflict(form.name, {
    disk: listOrgDirs(orgsDir),
    ledger: ledgerOrgNames(ctx.orgsLedger.load().ledger),
    featureGroups,
    // A3/BD3 过滤第二处：**已停用**组织名豁免查重 ⇒ 同名提交 = 复活（目录不动，零迁移）。
    disabled: disabledOrgNames(ctx.orgsLedger.load().ledger),
  });
  if (conflict !== null) {
    respondError(
      res,
      headers.accept,
      409,
      ORG_EXISTS_CODE,
      `组织 ${form.name} 已存在（命中源：${ORG_CONFLICT_SOURCE_LABEL[conflict]}）⇒ 不重复创建`,
      undefined,
      orgBackfillFields(body),
    );
    return;
  }
  // ⑤ 台账写入：**纯新建**（无停用语义，停用归 BD3），tmp+rename 原子替换；同名竞态再拒一次
  const added = ctx.orgsLedger.addOrg(form.name);
  if (!added.added) {
    respondError(
      res,
      headers.accept,
      409,
      ORG_EXISTS_CODE,
      `组织 ${form.name} 已存在于台账（读-写窗口内同名竞态）⇒ 未二次写入`,
      undefined,
      orgBackfillFields(body),
    );
    return;
  }
  // ⑥ 建目录（v0.9.4 §9-a 死锁修复）：台账写成立即建 `<orgsDir>/<组织>`，消除「建组织后目录要等
  //    首次起桥才出现」的断裂（盘枚举源 / 组织空间目录面从此与台账同步）。根存在性已由③闸保证
  //    ⇒ 只建一级、不代建根；目录已在（盘遗留 / 同名复活）⇒ 幂等成功。建不成 ⇒ 如实出声（台账条目
  //    已在，读面 = 盘 ∪ 台账，不静默假装目录就绪）。
  const orgDir = join(orgsDir, form.name);
  try {
    mkdirOrgDir(orgDir);
  } catch (err) {
    respondError(
      res,
      headers.accept,
      503,
      ORG_DIR_CREATE_FAILED,
      `组织 ${form.name} 已写入板台账，但组织目录建不出来：${orgDir} —— 根因：${errText(err)}；` +
        `对策：确认该路径未被文件占用且组织目录根可写，然后同名重建（目录补齐即无副作用）。`,
      undefined,
      orgBackfillFields(body),
    );
    return;
  }
  // ⑥′ 组织种子化（v0.9.5 C10）：`AGENTS.md`（模板渲染）+ `flow/spec` 三份规范快照落组织目录。
  //     **fail-open**：任一步失败只记结构化告警，**不回滚组织创建、不改回显**（缺失由启动幂等回填自愈）；
  //     `seedOrgWorkspace` 自身零抛。无独立写路由 —— 本步不是 HTTP 端点，白名单保持 11 条不动。
  if (ctx.orgSeed !== null) {
    logOrgSeedWarnings(seedOrgWorkspace(orgDir, form.name, ctx.orgSeed).warnings);
  }
  // ⑦ 回显：浏览器表单 ⇒ 303 回组织页（PRG，刷新不重复建）；声明 accept: application/json ⇒ 201 JSON
  const accept = headers.accept ?? "";
  if (accept.includes("application/json")) {
    respondJson(res, 201, { ok: true, org: form.name, ledgerFile: ctx.orgsLedger.file });
    return;
  }
  res.writeHead(303, { location: "/orgs", "cache-control": "no-store" });
  res.end();
}

/** 组织名下仍有活跃宿主桥 ⇒ 拒绝删除的结构化错误码（A3/BD3；族名见 `views.ERROR_FAMILY_LABELS`）。 */
const ORG_HAS_ACTIVE_BRIDGE = "board_org_has_active_bridge";

/**
 * `POST /orgs` 的停用分支（v0.9.4 A3 · BD3；由 {@link handleWriteOrg} 按 `action=disable` 分流进来，
 * CSRF / 表单解析 / 组织名校验已在调用方完成）。**删除 = 台账标记停用 + 同步摘除编排成员登记**
 * （v0.9.4 增补五 §9.4-①）：
 * - **前置闸：名下有活跃宿主桥 ⇒ 409 结构化拒绝** + 浮层引导「先逐桥 stop 再删」——
 *   **绝不隐式连带停桥**（停桥是 `POST /host/{org}/stop` 的独立职责，见 {@link handleWriteHostStop}）；
 *   宿主面未装配（本板不管宿主桥）⇒ 无从有活跃桥，直接放行；
 * - **同步摘除成员登记**：调 O1 `group.remove` 删该组织在 orch `projectGroup` 的整组段
 *   （语义 = 组织退出编排、项目归还「无归属」，可被其它组织接管）。**先出网、后台账** ——
 *   O1 失败 ⇒ **停用整体失败（原子，不留半态：台账不写）**，按 {@link describeMemberWriteFailure}
 *   映射状态码结构化上报；组段本不存在（板台账新组织从未挂成员）⇒ 封装内**幂等放行**（视为成功）。
 *   **不自动跨组搬迁成员**（跨组自动搬迁有风险，走「先移除 / 先停用」引导）。
 * - 过闸过网后写台账 `disabledAt`（幂等：已停用 ⇒ `changed:false`，文件逐字节不动）；
 * - 回显：JSON ⇒ 200，表单 ⇒ **303 回组织门户 `/`**（v0.9.4 增补五 §9.4-②：不再回已退役的 `/orgs`，
 *   与停用表单 `data-ov-redirect="/"` 同落点）。**不物理删目录**（同名重建 = 复活，零迁移）。
 */
async function handleDisableOrg(
  res: ServerResponse,
  headers: Record<string, string | undefined>,
  ctx: Ctx,
  name: string,
  body: string,
): Promise<void> {
  const active = ctx.host?.activeBridgesFor(name) ?? [];
  if (active.length > 0) {
    const states = active.map((s) => s.state).join("、");
    respondError(
      res,
      headers.accept,
      409,
      ORG_HAS_ACTIVE_BRIDGE,
      `组织 ${name} 名下仍有 ${String(active.length)} 个活跃宿主桥（${states}）⇒ 不隐式连带停桥。请先逐桥 stop（宿主桥页 POST /host/${name}/stop）再删除（停用）。`,
      undefined,
      orgBackfillFields(body),
    );
    return;
  }
  // ② 同步摘除编排成员登记（§9.4-①）：O1 `group.remove` 先于台账标记 —— 失败即整体失败（原子，不留半态）。
  //    组身份 = 目标组织名（O1 是全组面工具，但连接仍需显式身份）。
  const release = await ctx.write.releaseOrgGroup(
    { groupName: name },
    { group: name, baseUrl: ctx.write.mcpBaseUrl },
  );
  if (!release.ok) {
    process.stderr.write(
      `${timestampPrefix("error")}停用释放成员：组织 ${name} 的 group.remove 失败（${release.code}）⇒ 停用整体失败，台账零写\n`,
    );
    const mapped = describeMemberWriteFailure(release.code, release.error);
    respondError(res, headers.accept, mapped.status, mapped.code, mapped.error, undefined, orgBackfillFields(body));
    return;
  }
  const disabled = ctx.orgsLedger.disableOrg(name, () => new Date(ctx.now()).toISOString());
  const accept = headers.accept ?? "";
  if (accept.includes("application/json")) {
    respondJson(res, 200, {
      ok: true,
      org: name,
      disabled: true,
      changed: disabled.changed,
      /** group.remove 结果：`changed` = 是否真摘除组段（false = 组段本不存在，幂等放行）。 */
      membersReleased: release.changed,
      ledgerFile: ctx.orgsLedger.file,
    });
    return;
  }
  res.writeHead(303, { location: "/", "cache-control": "no-store" });
  res.end();
}

// ---------------------------------------------------------------------------
// v0.9.8 按项目组配 agent：POST /orgs 的 action=setHostAgent 分支（写本组织 agent 配置两键）
// ---------------------------------------------------------------------------

/** 目标组织不在板台账 ⇒ 结构化错误码（404）。 */
const ORG_HOST_AGENT_NOT_FOUND = "board_org_host_agent_not_found";

/**
 * 写本组织 agent 配置（`agentKind` / `agentModel` 两键，**整体覆盖**，留空 = 置 null 恢复全局回落）。
 * 由 {@link handleWriteOrg} 在 disable 分流之后、orgsDir 根闸与三源重名闸**之前**转进来
 * （本分支不建组织、不碰目录，两道建组织闸与本分支无关）：
 * - 目标组织判据：**在台账**（不在 ⇒ 404 {@link ORG_HOST_AGENT_NOT_FOUND}）∧ **未停用**
 *   （已停用 ⇒ 409 `board_org_disabled`，恢复配置须先同名复活）；
 * - 成功 = {@link OrgsLedgerStore.setOrgHostAgent} 一次 RMW 写两键（板唯一台账写封装）；
 * - 回显：JSON ⇒ 200，表单 ⇒ **303 回本组织管理页**（配置卡就在本页，PRG 刷新不重复写）。
 */
async function handleSetOrgHostAgent(
  res: ServerResponse,
  headers: Record<string, string | undefined>,
  ctx: Ctx,
  name: string,
  body: string,
): Promise<void> {
  const form = parseOrgHostAgentForm(body, Number(headers["content-length"] ?? NaN));
  if (!form.ok) {
    respondError(res, headers.accept, form.status, form.code, form.error, undefined, orgBackfillFields(body));
    return;
  }
  const { ledger } = ctx.orgsLedger.load();
  const rec = findOrgRecord(ledger, name);
  if (rec === null) {
    respondError(
      res,
      headers.accept,
      404,
      ORG_HOST_AGENT_NOT_FOUND,
      `组织 ${name} 不在板台账 ⇒ 没有可写 agent 配置的记录（先建组织，再配置）`,
      undefined,
      orgBackfillFields(body),
    );
    return;
  }
  if (rec.disabledAt !== null) {
    respondError(
      res,
      headers.accept,
      409,
      ORG_DISABLED,
      `组织 ${name} 已停用 ⇒ 不改其 agent 配置；恢复 = 同名重新建组织（复活保留旧配置）`,
      undefined,
      orgBackfillFields(body),
    );
    return;
  }
  const written = ctx.orgsLedger.setOrgHostAgent(name, form.agentKind, form.agentModel);
  const accept = headers.accept ?? "";
  if (accept.includes("application/json")) {
    respondJson(res, 200, {
      ok: true,
      org: name,
      agentKind: written.found ? form.agentKind : null,
      agentModel: written.found ? form.agentModel : null,
      ledgerFile: ctx.orgsLedger.file,
    });
    return;
  }
  res.writeHead(303, { location: orgSpaceLink(name, "manage"), "cache-control": "no-store" });
  res.end();
}

// ---------------------------------------------------------------------------
// v0.9.4 N1 写面：POST /versions（REQ-2026-09-27-05 —— 版本台账，`action` 三值闭集分流）
// ---------------------------------------------------------------------------

/**
 * **写面改道引擎（v0.10.0 B2 · 改造文档 §2.3(2)/(3)）**：建 / 删 / 设状态三支不再有板侧事实源
 * 写口（原 `board_version_exists` / `board_version_not_found` / `board_version_remove_released` /
 * `board_version_remove_confirmed_cards` / `board_version_remove_pool_back_failed` 五个本地码随
 * 本地台账写口一并退役）。板**不判闸**：错误码一律来自引擎（`orch_*` …），经
 * {@link describeVersionWriteError} 决定展示文案（未知码原样展示、不 fail-closed）。
 */

/** 版本写表单失败回填（口径同 {@link orgBackfillFields}：只回显非空提交值）。 */
function versionBackfillFields(body: string): ErrorOverlayField[] {
  const f = new URLSearchParams(body);
  const fields: ErrorOverlayField[] = [];
  for (const [key, label] of [
    ["version", "版本"],
    ["status", "状态"],
    ["action", "动作"],
  ] as const) {
    const value = (f.get(key) ?? "").trim();
    if (value !== "") fields.push({ label, value });
  }
  return fields;
}

/**
 * 版本台账写（v0.10.0 B2 起：**写面改道引擎**）。一条 `POST /versions` 靠表单 `action` 分三支
 * （`create` / `remove` / `setStatus`），三支**都只向引擎发一次意图**（`ctx.write.versions`），
 * 板**不判闸**（不复核形状 / 重复 / released / 名下卡 / 迁移矩阵）：引擎的错误码**原样展示**
 * （经 {@link describeVersionWriteError} 决定文案，未知码原样、不 fail-closed），HTTP 状态用引擎回执；
 * 引擎不可达 ⇒ **502 `bridge_unreachable` 硬失败**（**无本地下沉兜底写**，`.data/versions.json`
 * 不再被本写面写入）。
 *
 * CSRF / body 上限 / 回填 / 错误浮层与其余写口**同规格**；**不写状态机、不动任何配置**。
 * 回显：JSON ⇒ 结构化载荷（create 201 / remove 200 / setStatus 200）；表单档 ⇒ **303 回排期看板**
 * （PRG，版本列就在该页；刷新不重复写）。
 *
 * **组织作用域（口径 4 / 5 / 30）**：本 handler 的 org **只从服务端路径上下文取**
 * （`spaceOrg` = 归一层剥 `/org/<名>` 前缀后的路径组织；建版本表单**不带 org 字段**）。
 * - `spaceOrg` 非空 ⇒ 以该组织为 `ownerGroup` 发引擎，303 回**本空间排期页**；
 * - `spaceOrg` 为 null（全局 `POST /versions` 直投 —— 全局页头入口已撤除，路由留到 B5a 退役）
 *   ⇒ `ownerGroup = null`（引擎匿名档），303 回 `/schedule`。
 */
async function handleWriteVersions(
  req: IncomingMessage,
  res: ServerResponse,
  ctx: Ctx,
  spaceOrg: string | null = null,
): Promise<void> {
  const headers = lowerHeaders(req);
  // ① CSRF 守卫先于一切（与其余八条写径同规格：未认证请求不消耗 body 读取）
  const auth = checkWriteAuth({ method: req.method, headers, proto: "http" });
  if (!auth.ok) {
    respondError(res, headers.accept, 403, auth.code, auth.error);
    return;
  }
  let body: string;
  try {
    body = await readBodyCapped(req, MAX_REQUIREMENT_BODY_BYTES);
  } catch (err) {
    const code = errText(err) === "payload_too_large" ? "payload_too_large" : "body_read_failed";
    respondError(res, headers.accept, code === "payload_too_large" ? 413 : 400, code, errText(err));
    return;
  }
  // ② 表单：action 三值闭集 + version 非空 + setStatus 的 status 闭集
  const form = parseVersionActionForm(body, Number(headers["content-length"] ?? NaN));
  if (!form.ok) {
    respondError(res, headers.accept, form.status, form.code, form.error, undefined, versionBackfillFields(body));
    return;
  }
  /**
   * 组织档（口径 4 / 30：org **只**由服务端路径上下文决定，表单零 org 字段）：`null` = 全局直投
   * （引擎匿名档 NULL）；否则 = 本组织名。`backTo` = 三支共用的 303 落点（空间档回**本空间排期页**，
   * 全局档仍 `/schedule`，口径 5）。
   */
  const engineOwner = spaceOrg === null || spaceOrg.trim() === "" ? null : spaceOrg.trim();
  const backTo = spaceOrg === null ? "/schedule" : orgSpaceLink(spaceOrg, "schedule");

  if (form.action === VERSION_ACTION_CREATE) {
    const out = await ctx.write.versions.create({ ownerGroup: engineOwner, version: form.version });
    if (!out.ok) {
      respondError(res, headers.accept, out.httpStatus, out.code, describeVersionWriteError(out.code, out.message), undefined, versionBackfillFields(body));
      return;
    }
    if ((headers.accept ?? "").includes("application/json")) {
      respondJson(res, 201, { ok: true, version: out.version ?? form.version, status: out.status ?? "notstart" });
      return;
    }
    res.writeHead(303, { location: backTo, "cache-control": "no-store" });
    res.end();
    return;
  }

  if (form.action === VERSION_ACTION_REMOVE) {
    const out = await ctx.write.versions.remove({ ownerGroup: engineOwner, version: form.version });
    if (!out.ok) {
      respondError(res, headers.accept, out.httpStatus, out.code, describeVersionWriteError(out.code, out.message), undefined, versionBackfillFields(body));
      return;
    }
    if ((headers.accept ?? "").includes("application/json")) {
      respondJson(res, 200, { ok: true, version: form.version, removed: true });
      return;
    }
    res.writeHead(303, { location: backTo, "cache-control": "no-store" });
    res.end();
    return;
  }

  // setStatus（parser 保证 form.status 非 null）：目标态原样发引擎，迁移矩阵 / 发版闸执法归引擎
  if (form.action === VERSION_ACTION_SET_STATUS) {
    const target = form.status;
    if (target === null) {
      respondError(res, headers.accept, 400, VERSION_FORM_INVALID_CODE, "目标状态缺失（setStatus 必带 status）", undefined, versionBackfillFields(body));
      return;
    }
    const out = await ctx.write.versions.setStatus({ ownerGroup: engineOwner, version: form.version, status: target });
    if (!out.ok) {
      respondError(res, headers.accept, out.httpStatus, out.code, describeVersionWriteError(out.code, out.message), undefined, versionBackfillFields(body));
      return;
    }
    if ((headers.accept ?? "").includes("application/json")) {
      respondJson(res, 200, { ok: true, version: form.version, status: out.status ?? target });
      return;
    }
    res.writeHead(303, { location: backTo, "cache-control": "no-store" });
    res.end();
    return;
  }

  // 不可达（parser 已把 action 收敛到三值闭集）
  respondError(res, headers.accept, 400, VERSION_FORM_INVALID_CODE, `未处理的版本写动作：${form.action}`, undefined, versionBackfillFields(body));
}

// ---------------------------------------------------------------------------
// BD4 写面：POST /orgs/{org}/members（v0.9.4 B 档 —— 成员增删，一条路由靠 `action` 分流）
// ---------------------------------------------------------------------------

/** 成员写表单失败回填（口径同 {@link orgBackfillFields}：只回显非空提交值，让用户看到「删的是哪一条」）。 */
function memberBackfillFields(org: string, body: string): ErrorOverlayField[] {
  const f = new URLSearchParams(body);
  const fields: ErrorOverlayField[] = [{ label: "组织", value: org }];
  for (const [key, label] of [
    ["action", "动作"],
    ["machineId", "machineId"],
    ["projectId", "projectId"],
  ] as const) {
    const value = (f.get(key) ?? "").trim();
    if (value !== "") fields.push({ label, value });
  }
  return fields;
}

/**
 * 件3 文案解析（v0.9.4 增补五 §9.4-③）：加成员撞 O1 `config_write_duplicate_member` 时，
 * 从 3300 `GET /api/groups` 的**声明面投影**解析「该项目当前所属组织」：
 * - 命中 ⇒ 文案点名组织 X + `X` 的 manage 页链接；
 * - 未装配 / 3300 不可达 / 声明面无该成员 ⇒ **空投影**，`describeMemberGroupConflict` 退通用文案
 *   （**绝不臆造组织名、绝不给假链接**）。
 * 桥的 `projectGroup` 不变量原文**只留日志**，不进浮层。
 */
async function resolveMemberGroupConflict(
  ctx: Ctx,
  member: { machineId: string; projectId: string },
): Promise<MemberConflictDisplay> {
  let groups: readonly GroupRow[] = [];
  if (ctx.orgGroups !== null) {
    const out = await ctx.orgGroups().catch(() => null);
    if (out !== null && out.ok) groups = out.groups;
  }
  return describeMemberGroupConflict({ member, groups });
}

/**
 * 组织成员的增 / 删（v0.9.4 B 档 · BD4）。与 A 档「建 / 停用」刻意的两点不同：
 * - **落点在 orch**：本写口**不动板台账**，经 `group-admin.ts`（板第三个 MCP 写封装）以**组身份**
 *   调 O1 的受控写工具（配置面组写）；**绝不直写 `orch/config.json`**，桥不可达 ⇒
 *   结构化报错 + 浮层引导（不降级本地直写）；
 * - **action 无缺省**：`add` / `remove` 必须显式给出（增删是两回事，不像建组织可缺省）；
 *   动作越界 ⇒ 400 `board_member_action_invalid`，成员对不全 ⇒ 400 `board_member_pair_missing`。
 *
 * 错误映射读面（HTTP 状态归板，见 `group-admin.describeMemberWriteFailure`）：
 * 闭集六元按表给 422 / 409 / 500，其中 `config_write_group_not_found` 走**保守文案**；
 * 非闭集码（transport / jsonrpc / 坏信封…）⇒ **502 + 不可达引导**。
 * **末位成员写前闸（v0.9.4 增补二 §9.1-①）**：remove 且 3300 声明面该组仅剩一员 ⇒
 * 板侧 409 `board_last_member_remove` + 业务文案「请选择停用组织」，**不出网**、桥原文只进日志。
 * **加成员撞组间互斥（v0.9.4 增补五 §9.4-③）**：add 撞 O1 `config_write_duplicate_member` ⇒
 * 板侧 409 `board_member_group_conflict`（`describeMemberGroupConflict`），文案点名所属组织 X + X 的
 * manage 页链接，**不透传桥原文**（`projectGroup` 不变量句只进日志）；X 由 3300 声明面投影解析，
 * 查不到 ⇒ 退通用文案（不臆造组织名 / 不给假链接）。
 * `config_write_concurrent_modification` ⇒ 封装内**单次自动重读重试**（O1 每次现读 config，
 * 板侧不缓存成员清单），重投仍同一 op / 同一成员对。
 *
 * 回显：JSON ⇒ 200 结构化载荷；表单档成功**有内容回执**（备份路径 `backedUpTo` + G11 驻留引导）
 * ⇒ 出整页（口径同 N7「有内容回执的档仍出整页」），组织页刷新失败时**不掩盖已成功的写**。
 */
async function handleWriteOrgMembers(
  req: IncomingMessage,
  res: ServerResponse,
  ctx: Ctx,
  orgRaw: string,
): Promise<void> {
  const headers = lowerHeaders(req);
  // ① CSRF 守卫先于一切（与其余七条写径同规格：未认证请求不消耗 body 读取）
  const auth = checkWriteAuth({ method: req.method, headers, proto: "http" });
  if (!auth.ok) {
    respondError(res, headers.accept, 403, auth.code, auth.error);
    return;
  }
  let body: string;
  try {
    body = await readBodyCapped(req, MAX_REQUIREMENT_BODY_BYTES);
  } catch (err) {
    const code = errText(err) === "payload_too_large" ? "payload_too_large" : "body_read_failed";
    respondError(res, headers.accept, code === "payload_too_large" ? 413 : 400, code, errText(err));
    return;
  }
  // ② URL 段的组织名 = 单一纯函数闭集校验（与 D 档归一层共享 validateOrgName 事实源，不立第二套规则）
  const org = validateOrgName(orgRaw);
  if (!org.ok) {
    respondError(res, headers.accept, 400, org.code, org.error, undefined, undefined, SPACE_ACTIVE);
    return;
  }
  // ③ 表单：action 闭集 + 成员对非空
  const form = parseMemberForm(body, Number(headers["content-length"] ?? NaN));
  if (!form.ok) {
    respondError(
      res,
      headers.accept,
      form.status,
      form.code,
      form.error,
      undefined,
      memberBackfillFields(org.name, body),
      SPACE_ACTIVE,
    );
    return;
  }
  // ③′ 末位成员写前闸（v0.9.4 增补二 §9.1-①）：声明面持组且仅剩一员 ⇒ 板侧直接业务拒绝，
  //     **不调 O1、不出网**（桥原文只进日志，绝不进浮层）。3300 不可达 / 声明面无该组 ⇒ 不拦，
  //     照旧出网交 O1 判（幂等零写入不得被翻译成「末位不可删」）。
  if (ctx.orgGroups !== null) {
    const groupsOutcome = await ctx.orgGroups();
    if (
      groupsOutcome.ok &&
      removesLastGroupMember({
        action: form.action,
        groupName: org.name,
        member: { machineId: form.machineId, projectId: form.projectId },
        groups: groupsOutcome.groups,
      })
    ) {
      process.stderr.write(
        `${timestampPrefix("error")}成员写前闸：组织 ${org.name} 末位成员 ${form.machineId}/${form.projectId} remove 被板侧业务拒绝（${LAST_MEMBER_REMOVE_CODE}，未出网）\n`,
      );
      respondError(
        res,
        headers.accept,
        409,
        LAST_MEMBER_REMOVE_CODE,
        LAST_MEMBER_REMOVE_DISPLAY,
        undefined,
        memberBackfillFields(org.name, body),
        SPACE_ACTIVE,
      );
      return;
    }
  }
  // ④ 出网：唯一通路 = 第三个写封装（组身份 = 目标组织名；O1 是全组面工具，但连接仍需显式身份）
  const { outcome, retriedOnce, groupCreatedOnce } = await ctx.write.groupMemberWrite(
    {
      op: memberActionToOp(form.action),
      groupName: org.name,
      members: [{ machineId: form.machineId, projectId: form.projectId }],
    },
    { group: org.name, baseUrl: ctx.write.mcpBaseUrl },
  );
  if (!outcome.ok) {
    // ③″ 加成员撞「组间成员互斥」（v0.9.4 增补五 §9.4-③）：O1 的 duplicate 码在 add 路径上业务化为
    //     `board_member_group_conflict`（点名所属组织 X + X 的 manage 页链接），**不透传桥原文**
    //     （`projectGroup` 不变量句只进日志）。声明面投影查不到 X ⇒ 退通用文案。
    if (form.action === MEMBER_ACTION_ADD && outcome.code === DUPLICATE_MEMBER_CODE) {
      const conflict = await resolveMemberGroupConflict(ctx, {
        machineId: form.machineId,
        projectId: form.projectId,
      });
      process.stderr.write(
        `${timestampPrefix("error")}成员写：组织 ${org.name} 加成员 ${form.machineId}/${form.projectId} 撞重复成员（桥原码 ${outcome.code}）⇒ 业务化 ${conflict.code}；桥原文只进日志：${outcome.error}\n`,
      );
      respondError(
        res,
        headers.accept,
        409,
        conflict.code,
        conflict.error,
        undefined,
        memberBackfillFields(org.name, body),
        SPACE_ACTIVE,
        undefined,
        conflict.link ?? undefined,
      );
      return;
    }
    const mapped = describeMemberWriteFailure(outcome.code, outcome.error);
    respondError(
      res,
      headers.accept,
      mapped.status,
      mapped.code,
      mapped.error,
      retriedOnce ? "已按并发冲突策略自动重读重试一次，仍被拒 ⇒ 请人工核对 orch 配置后重试。" : undefined,
      memberBackfillFields(org.name, body),
      SPACE_ACTIVE,
    );
    return;
  }
  if (wantsJson(headers.accept)) {
    respondJson(res, 200, {
      ok: true,
      org: org.name,
      action: form.action,
      op: outcome.op,
      changed: outcome.changed,
      members: outcome.members,
      /** 仅展示：本次实际写入前的备份路径（零写入 ⇒ null；板不解析该路径）。 */
      backedUpTo: outcome.backedUpTo,
      retriedOnce,
      /** true = orch 侧原本无该组 ⇒ 本次经 `group.add` 建组带首成员一次写入（v0.9.4 §9-a 兜底）。 */
      groupCreated: groupCreatedOnce === true,
      ...(form.action === MEMBER_ACTION_ADD ? { note: MEMBER_ADD_RESIDENCY_NOTE } : {}),
    });
    return;
  }
  const card = renderMemberWriteCard({
    org: org.name,
    action: form.action,
    machineId: form.machineId,
    projectId: form.projectId,
    changed: outcome.changed,
    members: outcome.members,
    backedUpTo: outcome.backedUpTo,
    retriedOnce,
  });
  let page: Page;
  try {
    // §9-c：成员写的宿主页 = 该组织空间内管理页（`/orgs` 页退役）；刷新失败不得伪装成写失败（也不回 502）。
    const view = await ctx.client.getFeatures();
    page = await pageOrgSpaceManage(ctx, org.name, view.features, orgNavOf(ctx, org.name, featureOrgGroups(view.features)));
  } catch (err) {
    const nav = orgNavOf(ctx, org.name);
    page = {
      title: `空间 · ${org.name} · 管理`,
      active: SPACE_ACTIVE,
      orgNav: nav,
      bodyHtml: `${renderSpaceNav(org.name, "manage")}<p class="hint warn">管理页刷新失败（${escapeHtml(errText(err))}）：上方成员写的结果仍然有效，恢复后重开本页即可。</p>`,
    };
  }
  sendPage(res, { ...page, bodyHtml: card + page.bodyHtml });
}

// ---------------------------------------------------------------------------
// BD8 写面 ①：POST /features/:id/turn（触发一轮 —— 起桥 + 发轮，**不等排队轮**）
// ---------------------------------------------------------------------------

/**
 * 宿主面写端点的公共前置（**BD7 / BD8 / BD9 同规格**）：CSRF 守卫先于一切 ⇒ 排空请求体 ⇒ 宿主面装配检查。
 * 返回宿主面句柄与已排空的请求体；返回 `null` ⇒ 已应答（403 / 413 / 503），调用方直接 return。
 */
async function hostWriteGate(
  req: IncomingMessage,
  res: ServerResponse,
  ctx: Ctx,
): Promise<{ face: BoardHostFace; body: string } | null> {
  const headers = lowerHeaders(req);
  const auth = checkWriteAuth({ method: req.method, headers, proto: "http" });
  if (!auth.ok) {
    respondError(res, headers.accept, 403, auth.code, auth.error);
    return null;
  }
  try {
    const body = await readBodyCapped(req, MAX_REQUIREMENT_BODY_BYTES);
    if (ctx.host === null) {
      respondError(res, headers.accept, 503, HOST_FACE_DISABLED_CODE, HOST_FACE_DISABLED_DISPLAY);
      return null;
    }
    return { face: ctx.host, body };
  } catch (err) {
    const code = errText(err) === "payload_too_large" ? "payload_too_large" : "body_read_failed";
    respondError(res, headers.accept, code === "payload_too_large" ? 413 : 400, code, errText(err));
    return null;
  }
}

/**
 * turn / confirm / answer 共用的应答出口：JSON 档出结构化载荷，HTML 档出结果页（**失败不伪装成 200**）。
 * 失败档（bridge_down / turn_failed / timeout / not_awaiting / busy / terminal / config_error）
 * 叠加 BD2 错误浮层（REQ-v0.9.2 N2 出口样式统一）；整页台账结构不动。
 *
 * **REQ-v0.9.2 N7**：HTML 档的**受理成功（排队）档**改 303 回需求详情页（PRG，同提需求 `POST /requirements`
 * 的先例）—— 该档本轮还没跑、结果页除「排队中」外无内容，详情页的轮次进度行才是它该有的落点，
 * 刷新也不重复烧一轮。**有内容回执的档（succeeded 摘要 / awaiting_answer 问题 / 各失败档）仍出整页**，
 * 否则 agent 的回答与失败根因会在跳转中丢失。JSON 档不受影响（载荷照常返回）。
 */
function respondTurnOutcome(
  res: ServerResponse,
  accept: string | undefined,
  title: string,
  outcome: TriggerTurnOutcome,
): void {
  const status = dispositionHttpStatus(outcome.disposition);
  if (wantsJson(accept)) {
    respondJson(res, status, outcome);
    return;
  }
  if (outcome.disposition === "queued") {
    res.writeHead(303, {
      location: `/features/${encodeURIComponent(outcome.featureId)}`,
      "cache-control": "no-store",
    });
    res.end();
    return;
  }
  sendPage(res, {
    title: `${title} · ${outcome.featureId.slice(0, 8)}`,
    active: "features",
    status,
    bodyHtml: renderTurnOutcome(outcome),
    errorOverlay: turnOutcomeErrorOverlay(outcome) ?? undefined,
  });
}

/**
 * BD8 触发一轮 与 BD9 人工确认（同一触发通道，仅提示词不同）共用一个 handler。
 * `kind = "confirm"` ⇒ 板投「用户已确认改造文档，请核对后执行放行」的一轮消息给宿主 agent
 * （**板不写状态机**：agent 核对不通过会不放行并回报原因，结果如实回显）。
 */
async function handleWriteTurn(
  req: IncomingMessage,
  res: ServerResponse,
  ctx: Ctx,
  featureId: string,
  kind: "trigger" | "confirm",
): Promise<void> {
  const headers = lowerHeaders(req);
  const gate = await hostWriteGate(req, res, ctx);
  if (gate === null) return;
  // v0.9.5 C2：turn 表单的**可选**补充文本（缺键 / 空 / 纯空白 = 纯触发，合法语义）——
  // 超限 8 KiB ⇒ 结构化 400，先于一切读面 / 出网动作收口（不静默、不白烧）。
  const form = parseTurnForm(gate.body);
  if (!form.ok) {
    respondError(res, headers.accept, form.status, form.code, form.error);
    return;
  }
  // 归属组织取桥侧 `ownerGroup`（身份链 S1）；读面失败 ⇒ 交宿主面回退**板级**组织名，
  // 两者皆无时宿主面返回结构化 503 —— 编排桥不可读不该让触发凭空猜一个组织。
  let org: string | null = null;
  let version: string | null = null;
  let engineState: string | null = null;
  try {
    const detail = await ctx.client.getFeature(featureId);
    org = detail.feature.ownerGroup;
    version = detail.feature.version;
    engineState = detail.feature.state;
  } catch {
    org = null;
  }
  // 收口轨 16 ③ 服务端兜底：已终态的需求 ⇒ 409 `board_feature_terminal`，不起桥不发轮
  // （防绕过页面直调 API 白烧一轮；编排桥读面失败 ⇒ 判不了，按既有链路放行，不新增误挡）。
  if (engineState !== null && isTerminalFeatureState(engineState)) {
    respondTurnOutcome(
      res,
      headers.accept,
      kind === "confirm" ? "确认指令" : "本轮结果",
      terminalTurnRejection(featureId, engineState),
    );
    return;
  }
  const outcome = kind === "confirm"
    ? await gate.face.confirmTurn({ featureId, org, version })
    : await gate.face.triggerTurn({ featureId, org, version, supplement: form.supplement });
  respondTurnOutcome(res, headers.accept, kind === "confirm" ? "确认指令" : "本轮结果", outcome);
}

// ---------------------------------------------------------------------------
// BD9 写面 ②：POST /features/:id/answer（澄清回答；仅当最新轮 `awaiting_answer` ⇒ 同 contextId 续推）
// ---------------------------------------------------------------------------

async function handleWriteAnswer(
  req: IncomingMessage,
  res: ServerResponse,
  ctx: Ctx,
  featureId: string,
): Promise<void> {
  const headers = lowerHeaders(req);
  const gate = await hostWriteGate(req, res, ctx);
  if (gate === null) return;
  const answer = (new URLSearchParams(gate.body).get("answer") ?? "").trim();
  if (answer === "") {
    respondError(
      res,
      headers.accept,
      400,
      "answer_empty",
      "回答内容为空（不得静默提交；澄清回答必须有内容）",
    );
    return;
  }
  // 收口轨 16 ③ 服务端兜底：终态需求 ⇒ 409 `board_feature_terminal`（与 turn / confirm 同一判据；
  // 桥读面失败 ⇒ 判不了，放行到宿主面既有链路，不新增误挡）。
  let engineState: string | null = null;
  try {
    engineState = (await ctx.client.getFeature(featureId)).feature.state;
  } catch {
    engineState = null;
  }
  if (engineState !== null && isTerminalFeatureState(engineState)) {
    respondTurnOutcome(res, headers.accept, "澄清回答", terminalTurnRejection(featureId, engineState));
    return;
  }
  const outcome = await gate.face.answerRequirement({ featureId, answer });
  respondTurnOutcome(res, headers.accept, "澄清回答", outcome);
}

// ---------------------------------------------------------------------------
// v0.9.5 C4 · T3 写面：POST /features/:id/stop-chain（按需求停链）
// ---------------------------------------------------------------------------

/**
 * **按需求停链**（v0.9.5 C4 · T3）：置**内存**停链标志（接力决策器判定序① 见标志即停）并复用
 * `cancelTurn` 清该需求的在飞 / 排队轮（排队 ⇒ 一条也不发）。**不落 `.data/` 台账、不跨重启持久**
 * （接力链本身是进程内 Promise 链）。一切失败结构化透出：未起接力 ⇒ 503 `board_relay_not_assembled`。
 * JSON 档出结构化载荷（API / 编排侧）；HTML 档成功 ⇒ 303 回详情页、失败 ⇒ 整页（REQ-2026-09-30-04 §2.4）。
 * 板内入口 = 详情页链状态行的停链表单（空表单，id 走路径 ⇒ 本 handler 不解析 body 字段）。
 */
async function handleWriteStopChain(
  req: IncomingMessage,
  res: ServerResponse,
  ctx: Ctx,
  featureId: string,
): Promise<void> {
  const headers = lowerHeaders(req);
  const gate = await hostWriteGate(req, res, ctx);
  if (gate === null) return;
  const outcome = await gate.face.stopChain(featureId);
  // v0.9.5 C7 · T7 清条目挂接：停链 ⇒ 该需求的 suspended 条目同生死（挂起条目与停链标志同口径）。
  // 载体（停链标志 / 链内计数）归 T2/T3 单一定义，本节点只做「清条目」，不另造任何链状态。
  const suspendCleared = ctx.suspendLedger.clear(featureId);
  const status = outcome.ok ? 200 : outcome.error?.code === "board_relay_not_assembled" ? 503 : 400;
  if (wantsJson(headers.accept)) {
    respondJson(res, status, { ...outcome, suspendCleared });
    return;
  }
  // REQ-2026-09-30-04 §2.4：HTML 档的**成功档**改 303 回详情页（PRG，对齐 turn 受理档先例）——
  // 停链的反馈本就长在详情页（链状态行转「链已停 · 来源：用户」+ 动作区回来），独立结果页是绕远路，
  // 且刷新结果页会重复置标志。**失败档仍出整页**：跳转会把根因（503 接力未装配 / 400 标识缺失）吞在跳转里。
  if (outcome.ok) {
    res.writeHead(303, {
      location: `/features/${encodeURIComponent(outcome.featureId)}`,
      "cache-control": "no-store",
    });
    res.end();
    return;
  }
  const bodyHtml = [
    `<p>${escapeHtml(outcome.display)}</p>`,
    suspendCleared ? "<p>已同步清除该需求的挂起条目（停链与挂起同生死）。</p>" : "",
    outcome.error === null
      ? ""
      : `<p class="mono">${escapeHtml(outcome.error.code)}：${escapeHtml(outcome.error.message)}</p>`,
    `<p class="hint"><a href="/features/${encodeURIComponent(outcome.featureId)}">返回该需求详情页</a></p>`,
  ].join("");
  sendPage(res, {
    title: `停链 · ${outcome.featureId.slice(0, 8)}`,
    active: "features",
    status,
    bodyHtml,
  });
}

// ---------------------------------------------------------------------------
// v0.9.5 C7 · T7 写面：POST /features/:id/suspend（挂起口 —— 登记 suspended 台账）
// ---------------------------------------------------------------------------

/**
 * **挂起口**（v0.9.5 C7 · T7）：宿主下发子任务后带本轮 `turnId` + `pending[]` 清单调本口，
 * 登记 suspended 台账即退出本轮；板心跳（C8）按 pending / DAG 定条件评估、命中后同 `contextId` 唤醒。
 *
 * 前置与同族写端点同规格（复用 {@link hostWriteGate}：CSRF 两档 → capped body → 宿主面 null 503）；
 * 表单解析纯函数 {@link parseSuspendForm}（超限 413 / 校验不过结构化 400）。
 *
 * **turnId 归属判据（R2 定稿）**：`providedTurnId === latestTurnOf(featureId).turnId`
 * （轮管理器为唯一事实源）—— 不匹配（旧轮 / 非板发 / 该需求无板发轮）一律 **400**，**不设时间窗**。
 * 这从根上把「agent 客户端触发的任务」挡在板链之外（它们没有板发 turnId）。
 *
 * **台账语义**：内存为事实源、`.data` 仅供崩溃取证、不跨重启（见 `suspend-ledger.ts`）。
 */
async function handleWriteSuspend(
  req: IncomingMessage,
  res: ServerResponse,
  ctx: Ctx,
  featureId: string,
): Promise<void> {
  const headers = lowerHeaders(req);
  const gate = await hostWriteGate(req, res, ctx);
  if (gate === null) return;
  const form = parseSuspendForm(gate.body);
  if (!form.ok) {
    respondError(res, headers.accept, form.status, form.code, form.error);
    return;
  }
  // 归属校验：必须等于该需求最新板发轮的 turnId（唯一事实源 = 轮管理器；不设时间窗）。
  const latest = gate.face.latestTurnOf(featureId);
  if (latest === null || latest.turnId !== form.turnId) {
    const why =
      latest === null
        ? "该需求没有板发轮记录（agent 客户端任务没有板发 turnId，天然进不了板链）"
        : `给定 turnId ${form.turnId} 不是该需求最新板发轮（最新 = ${latest.turnId}）`;
    respondError(
      res,
      headers.accept,
      400,
      SUSPEND_TURN_MISMATCH_CODE,
      `挂起归属校验不过：${why} ⇒ 旧轮 / 非板发一律拒（不设时间窗）`,
    );
    return;
  }
  const entry: SuspendedEntry = ctx.suspendLedger.arm(
    {
      featureId,
      turnId: latest.turnId,
      contextId: latest.contextId,
      pending: form.pending,
      wakeCond: form.wakeCond,
    },
    new Date(ctx.now()).toISOString(),
  );
  const display =
    `已挂起：登记 suspended 台账（pending ${String(entry.pending.length)} 项${entry.pending.length === 0 ? " = 纯 DAG 监视" : ""}）；` +
    `板心跳按条件评估，命中后同 contextId 唤醒（重启板进程即无链）`;
  if (wantsJson(headers.accept)) {
    respondJson(res, 200, {
      ok: true,
      featureId,
      turnId: entry.turnId,
      contextId: entry.contextId,
      pending: entry.pending,
      wakeCond: entry.wakeCond,
      createdAt: entry.createdAt,
      display,
    });
    return;
  }
  const bodyHtml = [
    `<p>${escapeHtml(display)}</p>`,
    entry.pending.length > 0 ? `<p class="mono">pending：${escapeHtml(entry.pending.join(" · "))}</p>` : "",
    entry.wakeCond !== null ? `<p class="mono">wakeCond：${escapeHtml(entry.wakeCond)}</p>` : "",
  ].join("");
  sendPage(res, { title: `挂起 · ${featureId.slice(0, 8)}`, active: "features", status: 200, bodyHtml });
}

// ---------------------------------------------------------------------------
// BD8 写面 ②：POST /host/:org/stop（停桥；停后立即重探活并渲染状态页）
// ---------------------------------------------------------------------------

async function handleWriteHostStop(
  req: IncomingMessage,
  res: ServerResponse,
  ctx: Ctx,
  org: string,
): Promise<void> {
  const headers = lowerHeaders(req);
  const gate = await hostWriteGate(req, res, ctx);
  if (gate === null) return;
  const outcome = await gate.face.stopBridge(org);
  const status = outcome.ok ? 200 : 502;
  if (wantsJson(headers.accept)) {
    respondJson(res, status, outcome);
    return;
  }
  const page = await pageHost(ctx, renderHostNotice(outcome));
  sendPage(res, {
    ...page,
    status,
    errorOverlay: stopBridgeErrorOverlay(outcome) ?? undefined,
  });
}

// ---------------------------------------------------------------------------
// v0.9.2 M3 写面：POST /features/:id/schedule（排期写 —— 唯一放开的登记字段 `version` 写）
// ---------------------------------------------------------------------------

/** 排期写「归属组织缺失」的结构化错误码（503，请求期）—— 与提需求的 400 `board_group_required` 是两回事。 */
const SCHEDULE_OWNER_GROUP_MISSING_CODE = "board_schedule_owner_group_missing";

/** 锁版拒绝的回填：提交的目标版本 + 现版本（被锁的一侧要让用户看到「从哪被锁」；现为空 ⇒ 未排期）。 */
function scheduleLockBackfill(targetVersion: string, currentVersion: string | null): ErrorOverlayField[] {
  return [
    { label: "目标版本", value: targetVersion },
    { label: "现版本", value: normalizeVersion(currentVersion) === "" ? "（未排期）" : normalizeVersion(currentVersion) },
  ];
}

/**
 * 排期写一条需求（经 `feature-schedule.ts` 唯一封装，装配仅 {featureId, to, version} 三键）：
 * - 表单 `version` **必须显式传**（键缺失 ⇒ 编程错误，经全局兜底落 500，不做缺键语义）；
 *   空串 = 删除排期；服务端发送前一律 `trim()`；
 * - `to` = 先 `getFeature` 取当前态原样回填（advance「`to` = 当前态」登记字段特例，不迁移状态机）；
 * - **已发版锁（增补 ⑤ N3 / v0.10.0 B4 改读引擎投影）**：`getFeature` 之后、出网之前做三分判（现版本 × 目标版本）——
 *   入锁（现 ∉ 锁版 ∧ 目标 ∈ 锁版）⇒ 409；出锁（现 ∈ 锁版 ∧ 目标 ≠ 现版本，含清空回池）⇒ 409；
 *   同锁版无变化 ⇒ 幂等放行；未排期 ↔ 未锁版间的一切变动照常（错误码同提需求面 `board_version_released`）；
 *   **锁集的数据源 = 引擎版本台账投影**（本地 `.data/versions.json` 不再参与判定）；投影不可读 ⇒
 *   **503 fail-closed 挡排期写**（§2.3(1)「锁只紧不松」，不回落本地台账）；
 * - 身份 = 该 Feature 的 `ownerGroup`，**null ⇒ 结构化 503，绝不回落板级默认组**
 *   （排期改的是既有需求归属，拿板级组名出网会把写打到别的组织目录）；
 * - 读-写窗口内态漂移被桥拒（非法流转）⇒ 如实弹错误浮层 + N1 字段回填，**不自动重试**；
 * - **双条件状态闸（v0.9.3 B-T5）**：排期改动（新 version ≠ 现 version）仅
 *   `stage=需求分析 ∧ approval=未发起` 可写 ⇒ 409 `board_schedule_state_locked` 零出网；
 *   stage/approval 只作读判（getFeature），不进 HTTP 载荷与 `ScheduleAdvanceInput`；
 * - **改版自动善后（v0.9.3 B-T6）**：第一跳成功后，若 version 确实改动 ∧ decisions 含 `doc/{旧版}/`
 *   登记 ⇒ 受限 mv（`docs-move.ts`：仅源 A 树内、仅登记路径、目标已存在 = 跳 mv 仅登记、
 *   org 工作区路径不自动搬列入 manual）+ 第二跳 advance 追加 decisions 新路径；
 *   善后异常不回滚已成功的排期写，回执 `docMoves` 如实列出（JSON 出参；表单档 200 JSON 直显）；
 * - 成功 = PRG 303 回详情页；`Accept: application/json` ⇒ 200 JSON。
 */
async function handleWriteSchedule(
  req: IncomingMessage,
  res: ServerResponse,
  ctx: Ctx,
  featureId: string,
): Promise<void> {
  const headers = lowerHeaders(req);
  // ① CSRF 守卫先于一切（与既有五条同规格，含 body 读取都不做）
  const auth = checkWriteAuth({ method: req.method, headers, proto: "http" });
  if (!auth.ok) {
    respondError(res, headers.accept, 403, auth.code, auth.error);
    return;
  }
  // ② 入参解析（超限 413；version 键缺失 = 编程错误 ⇒ 不 catch，落全局兜底）
  let body: string;
  try {
    body = await readBodyCapped(req, MAX_REQUIREMENT_BODY_BYTES);
  } catch (err) {
    const code = errText(err) === "payload_too_large" ? "payload_too_large" : "body_read_failed";
    respondError(res, headers.accept, code === "payload_too_large" ? 413 : 400, code, errText(err));
    return;
  }
  const form = parseScheduleForm(body, Number(headers["content-length"] ?? NaN));
  if (!form.ok) {
    respondError(res, headers.accept, form.status, form.code, form.error);
    return;
  }
  const backfill = [{ label: "版本", value: form.version }];
  // ③ 当前态 + 归属 + 现版本：getFeature 失败 ⇒ 502 如实报（不猜态、不回落组名，交错误浮层）
  let to: string;
  let ownerGroup: string | null;
  let currentVersion: string | null;
  let stage: string | null;
  let approval: string | null;
  let decisions: string | null;
  try {
    const detail = await ctx.client.getFeature(featureId);
    to = detail.feature.state;
    ownerGroup = detail.feature.ownerGroup;
    currentVersion = detail.feature.version;
    stage = detail.feature.stage;
    approval = detail.feature.approval;
    decisions = detail.feature.decisions;
  } catch (err) {
    respondError(
      res,
      headers.accept,
      502,
      BRIDGE_UNREACHABLE_CODE,
      `需求数据读取失败，无法确定当前态与归属组织：${errText(err)}`,
      undefined,
      backfill,
    );
    return;
  }
  // ③a′ 同版判据（归一后**精确等串**，非前缀）：既是锁版幂等放行判据，也是双条件闸的豁免判据
  //     —— 同版重提 = 零变更写，不属「排期改动」，闸/锁都不拦（幂等语义原样保留）。
  const sameVersion = normalizeVersion(currentVersion) === normalizeVersion(form.version);
  if (ownerGroup === null || ownerGroup.trim() === "") {
    respondError(
      res,
      headers.accept,
      503,
      SCHEDULE_OWNER_GROUP_MISSING_CODE,
      `该需求无归属组织（ownerGroup 缺失）⇒ 拒绝排期写：不猜、绝不回落板级默认组（默认组只属于「提需求」链路）。` +
        "请先在引擎侧为该需求补齐 owner_group 后重试。",
      undefined,
      backfill,
    );
    return;
  }
  // ③b 已发版锁（REQ-v0.9.2 增补 ⑤ N3 / v0.9.4 N3 锁读台账 / **v0.10.0 B4 锁读引擎投影**）：
  //    现版本（getFeature）× 目标版本（表单）三分判，零出网。
  //    同锁版无变化 ⇒ 幂等放行（不报错）；锁判据唯一走 `isVersionLocked`（trim 后精确匹配，**本版零改动**）；
  //    清空回池 = 目标归一后空串 ⇒ 若现 ∈ 锁版即"出锁"被拒。回填带上现版本值（用户看到从哪被锁）。
  //    **fail-closed**：拿不到引擎版本台账投影 ⇒ 503 拒写（不回落本地台账、绝不当作「零个已发版」放行）。
  const scheduleProjection = await versionProjectionOf(ctx);
  if (scheduleProjection === null) {
    respondVersionProjectionClosed(res, ctx, headers.accept, backfill, "schedule");
    return;
  }
  const released = releasedVersionNames(versionProjectionLedgerOf(scheduleProjection));
  const targetLocked = isVersionLocked(form.version, released);
  const currentLocked = isVersionLocked(currentVersion, released);
  // 入锁判据：`v0.9.1-probe` 相对锁版 `v0.9.1` 算「改到别的版」⇒ 出锁拒（同版判据见 ③a′ 精确等串）。
  if (!currentLocked && targetLocked) {
    respondError(
      res,
      headers.accept,
      409,
      "board_version_released",
      `版本 ${form.version} 已发版 ⇒ 该版本已发版，不可将需求排入（事实源 = 引擎版本台账；在引擎把该版标记 released / 重开为进行中即实时生效）。`,
      undefined,
      scheduleLockBackfill(form.version, currentVersion),
    );
    return;
  }
  if (currentLocked && !sameVersion) {
    respondError(
      res,
      headers.accept,
      409,
      "board_version_released",
      `该需求现排期版本 ${normalizeVersion(currentVersion)} 已发版 ⇒ 已发版版本的需求不可移出或取消排期（事实源 = 引擎版本台账；在引擎把该版标记 released / 重开为进行中即实时生效）。`,
      undefined,
      scheduleLockBackfill(form.version, currentVersion),
    );
    return;
  }
  // ③c 双条件状态闸（v0.9.3 B-T5 · 规范 §7 改版纪律）：排期改动仅
  //    `stage = 需求分析 ∧ approval = 未发起`（想法挪版档）可写 ⇒ 否则 409
  //    `board_schedule_state_locked` 零出网。stage/approval **只作读判**（来自 getFeature），
  //    不进 ScheduleAdvanceInput / HTTP 载荷（类型层封死，feature-schedule.ts）。
  //    与 ③b 已发版锁**叠加、互不替代**（两把锁各自独立 409，本版先判版本锁）；
  //    同版重提（sameVersion）= 零变更 ⇒ 闸豁免（口径同锁版幂等放行）。
  //    老桥登记字段缺失（null）⇒ fail-closed 拒写，不猜。
  if (!sameVersion && !deriveScheduleGateOpen(stage, approval)) {
    respondError(
      res,
      headers.accept,
      409,
      "board_schedule_state_locked",
      `需求已确认（stage = ${stage ?? "缺失"} · approval = ${approval ?? "缺失"}）⇒ 排期锁定：需求确认单经用户确认后（stage 迁「改造方案」/ approval 过门）该需求的排期即不可在本板改动，` +
        `仅「stage = 需求分析 ∧ approval = 未发起」的想法可改版/入池/出池（板前台执法，拖拽与表单同口）。` +
        `如确需挪版：方案变 ⇒ 由宿主走流程（主需求 cancel 后从 Step 0 新建）；**本板不提供解除入口**（approval 单向、无回边，锁不会因拖拽解除）。` +
        `宿主经 MCP 直写 \`version\` **不经过本闸**，由流程规范纪律句兜底。`,
      undefined,
      scheduleLockBackfill(form.version, currentVersion),
    );
    return;
  }
  // ④ 唯一封装出网（装配仅三键；桥拒原样透传，不自动重试）
  let outcome: ScheduleOutcome;
  try {
    outcome = await ctx.write.scheduleFeature(
      { featureId, to, version: form.version },
      { group: ownerGroup, baseUrl: ctx.write.mcpBaseUrl },
    );
  } catch (err) {
    // 封装的前置校验（空 featureId / 空 to / 缺 version 键 / 组名仅空白）= 编程错误口径，
    // 但其中「组名仅空白」可经真表单 + 老桥数据出现 ⇒ 归一为结构化 400，不裸 500。
    if (err instanceof ScheduleFormProgrammingError || err instanceof FeatureScheduleConfigError) {
      respondError(res, headers.accept, 400, "schedule_request_invalid", errText(err), undefined, backfill);
      return;
    }
    throw err;
  }
  if (!outcome.ok) {
    respondError(
      res,
      headers.accept,
      502,
      outcome.code,
      outcome.error + "（读-写窗口内状态可能已漂移；未自动重试，请刷新核对后再次提交）",
      undefined,
      backfill,
    );
    return;
  }
  // ④b 改版自动善后（v0.9.3 B-T6 · 受限 mv）：version 确实改动 ∧ decisions 含 doc/{旧版}/ 登记
  //    ⇒ 自动 mv 至 doc/{新版}/ + decisions 追加新路径（第二跳 advance，仅携带 version 回显 +
  //    decisions，仍不触 stage/approval）。守卫与幂等口径见 docs-move.ts：
  //    仅源 A 树内、仅登记路径、目标已存在 ⇒ 跳 mv 仅登记；org 工作区路径不自动搬、列入 manual。
  //    mv 为服务端文件动作，不经 HTTP 写路由面；第一跳已成功 ⇒ 善后异常不回滚排期写、不裸 5xx，
  //    moved/registerOnly/failed/manual 全部如实进回执（JSON 出参 / 表单档 JSON 直显）。
  let docMoves: (DocsMoveResult & { rejected: string[]; notes: string[] }) | null = null;
  if (!sameVersion) {
    const plan = planDocsMove(decisions, form.version, ctx.docs.repoRoot);
    if (plan.actions.length > 0 || plan.manual.length > 0 || plan.rejected.length > 0) {
      const executed = executeDocsMove(plan);
      docMoves = { ...executed, rejected: plan.rejected, notes: [] };
      const registrations = docsMoveRegistrations(executed);
      if (registrations.length > 0) {
        let appended: ScheduleOutcome;
        try {
          appended = await ctx.write.scheduleFeature(
            { featureId, to, version: form.version, decisions: registrations },
            { group: ownerGroup, baseUrl: ctx.write.mcpBaseUrl },
          );
        } catch (err) {
          appended = { ok: false, code: "schedule_request_invalid", error: errText(err) };
        }
        if (appended.ok) {
          docMoves.notes.push(`decisions 已追加 ${String(registrations.length)} 条搬移后路径`);
        } else {
          docMoves.failed.push(`decisions 追加未成功（${appended.code}：${appended.error}）⇒ 文档已搬至新目录，请宿主手工补登记`);
        }
      }
    }
  }
  // ⑤ 回显：JSON 档 200；表单档 PRG 303 回详情页（刷新不重复写）
  if (wantsJson(headers.accept)) {
    respondJson(res, 200, {
      ok: true,
      featureId: outcome.featureId,
      group: ownerGroup,
      state: outcome.state,
      version: outcome.version,
      ...(docMoves === null ? {} : { docMoves }),
    });
    return;
  }
  res.writeHead(303, { location: `/features/${encodeURIComponent(outcome.featureId)}`, "cache-control": "no-store" });
  res.end();
}

/**
 * 关卡（BD13″ 停机链）：先 `closeIdleConnections()` + `server.close()` 等在飞收尾；
 * keep-alive/长连接会让 close 回调迟迟不来 ⇒ 宽限后 `closeAllConnections()` 强断兜底
 * （照 orch `http.ts#HTTP_CLOSE_GRACE_MS` = 5s 同语义、异实现）。**回调恒在宽限时 settle**，
 * 停机链不会因单条连接挂死。
 *
 * **BD19**：这根兜底定时器**必须 `unref()`**（先前漏了）—— 它只是「连接挂死」时的保险，
 * 不该反过来把已经排空的事件循环再钉 5s：真机上「已停止（耗时 5007ms）」就是它造成的
 * （停机链要等 `close()`，而 `close()` 之所以慢是 keep-alive 连接 —— 那些连接本身就是活跃句柄，
 * 定时器 unref 后照常在 5s fire；循环若已空则进程直接自然退出，走不到强断）。
 */
function closeServer(server: Server): Promise<void> {
  return new Promise<void>((resolve) => {
    let settled = false;
    const done = () => {
      if (settled) return;
      settled = true;
      resolve();
    };
    server.closeIdleConnections();
    server.close(done);
    setTimeout(() => {
      server.closeAllConnections();
      setTimeout(done, 250).unref();
    }, HTTP_CLOSE_GRACE_MS).unref();
  });
}

/** 停机时强断残留连接的宽限（与 orch 桥同值）；导出供 index.ts 停机日志口径引用。 */
export const HTTP_CLOSE_GRACE_MS = 5_000;

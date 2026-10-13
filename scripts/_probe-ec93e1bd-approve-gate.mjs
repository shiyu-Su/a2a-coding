// 一次性只读探针（宿主自办 · 增补卡 ec93e1bd Step 1）
// 目的：核「门② 六条」上线后，现网有多少在途卡会被新条件挡住（orch R1 请求宿主打的那发）。
// 只读打开（readOnly），不写库、不改数据。
import { DatabaseSync } from 'node:sqlite';

const db = new DatabaseSync('orch/data/sessions.sqlite', { readOnly: true });
const one = (sql, ...p) => db.prepare(sql).get(...p).c;

const rows = {
  '总卡数': one('SELECT count(*) c FROM features'),
  "state='waiting_approval' 卡数": one("SELECT count(*) c FROM features WHERE state='waiting_approval'"),
  "停在 waiting_approval ∧ approval='待审批'": one(
    "SELECT count(*) c FROM features WHERE state='waiting_approval' AND approval='待审批'"),
  '└ 其中 decisions 不含《改造文档》档名（⑥ 会挡）': one(
    "SELECT count(*) c FROM features WHERE state='waiting_approval' AND approval='待审批' AND IFNULL(decisions,'') NOT LIKE '%-改造文档.md%'"),
  '└ 其中 decisions 不含《需求确认单》档名（④ 会挡）': one(
    "SELECT count(*) c FROM features WHERE state='waiting_approval' AND approval='待审批' AND IFNULL(decisions,'') NOT LIKE '%-需求确认单.md%'"),
  "waiting_approval 中 decisions 全空（NULL/'')": one(
    "SELECT count(*) c FROM features WHERE state='waiting_approval' AND IFNULL(decisions,'')=''"),
  "waiting_approval ∧ approval='待审批' ∧ stage NOT IN ('需求分析','改造方案')": one(
    "SELECT count(*) c FROM features WHERE state='waiting_approval' AND approval='待审批' AND stage NOT IN ('需求分析','改造方案')"),
};

console.log(JSON.stringify(rows, null, 2));
db.close();

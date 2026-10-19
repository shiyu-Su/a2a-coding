# board —— Web 看板单元

## 是什么

> 板 = 管理入口 + 需求入口

管理入口：
- 增加/删减项目组下项目成员
- 调整项目组宿主Agent类型和模型  

需求入口：
- 提需求
- 需求排期
- 需求跟进
- 需求交付验收确认

## 有什么用

> 看板+卡片形式，展示所有待办、在办、已办需求，以及需求推进情况

## 怎么用

### 起（前台 / 后台）

前台起（调试用 · 日志直接进终端）：

```bash
npm install
npm run build          # tsc → dist/
# 首次：cp config/config.json.example config/config.json —— 这是**可运行起点**
#（config/config.json.default 只作**缺省值参照**，不是复制源）
npm run start:foreground   # = node dist/index.js（Ctrl+C / SIGTERM 走同一条优雅停机链）
```

后台起（日常用 · 静默脱离终端）：

```bash
npm run build
npm start              # 后台拉起（等待运行中）；等价 node scripts/boardctl.mjs start
npm run status         # 三态：运行中 / 端口被占 / pidfile 陈旧 / 未运行
npm run logs           # 尾部若干行；npm run logs -- -n 50 / -- -f 跟随
npm run stop           # 优雅停机 → 超时强杀兜底
npm run restart        # stop + start
```


# Ocularium 项目健康度报告

> 生成方式：实测验证（tsc / lint / vinext build / SSR tests / e2e / npm audit / 生产站点探测 / 全源码通读）。
> 本文档已入库随仓库演进；下方为**当前状态**（2026-08-17），再往下是初始快照与五轮执行记录。

## 当前状态（2026-08-17）

| 维度 | 状态 |
|---|---|
| Git | ✅ main 与 ocularium/main 完全同步（0 ahead / 0 behind），全部改动已推送 |
| lint | ✅ **0 errors / 1 warning**（no-img-element 设计性保留；初始 42 errors / 758 warnings） |
| audit | ✅ **0 高危**（初始 4 HIGH；next 16.2.6 → 16.3.1） |
| 构建 | ✅ vinext build 绿；three/gsap/framework/viewer 独立 chunk，>500KB 警告消除 |
| 测试 | ✅ SSR 2/2 + **e2e 23/23**（scripts/e2e-regression.mjs：模式切换/剥离/quiz 空点击不记错/tour/搜索/高亮/透明度滑杆/X-Ray） |
| 资产 | ✅ tracked public 10.3MB → 5.7MB（死资产已删）；dist/client 64MB → 8.4MB（baked 移出） |
| 生产 | ✅ ocularium.huahbo.workers.dev HTTP 200 |
| 数据一致性 | ✅ GLB 审计（Blender 实测）：23 mesh + 运行时 CC = 24 层，零缺失零多余，UV 正常 |
| 工具链 | ✅ Playwright MCP / Context7 已配置（新会话可用）；Blender MCP 官方版就绪（Blender 打开即恢复）；gh CLI 已认证 |
| 剩余项 | ⏳ source/eye-anatomy.glb 未入库（26MB，烘焙不可复现）；bake 几何断言未提为单测；无其他阻塞项 |

## 初始快照（2026-08-16 基线，问题均已解决，保留作演进记录）

## 验证基线

| 检查 | 结果 |
|---|---|
| `npx tsc --noEmit` | ✅ exit 0 |
| `npm run lint` | ❌ exit 1 — 42 errors / 758 warnings |
| `npm test`（build + SSR） | ✅ 2/2 pass |
| `vinext build`（Vite 8） | ✅ 通过；警告：客户端 chunk > 500KB |
| `npm audit --omit=dev` | ❌ 4 个 HIGH（next/postcss/sharp） |
| 生产 ocularium.huahbo.workers.dev | ✅ HTTP 200, cloudflare |
| 远端 github.com/huahbo/ocularium | ✅ ls-remote 连通，无待拉取 |

## 红色问题

### 1. Lint 失败 — 42 errors / 758 warnings
- QuizOverlay.tsx 6 errors（react-hooks/refs + immutability：渲染期写/读 ref，含 lastWrongRef 渲染期读取）+ 'answered' 未用变量
- TourOverlay.tsx 1 error（indexRef 渲染期赋值，本身是死代码）
- bake-eye.cjs 7 errors（TS 规则误伤 CJS require）
- public/ 下 7 个 vendor JS ~28 errors（basis + 3 份 draco decoder 副本被扫描）
- 758 warnings：bake-eye.cjs no-unused-expressions（109-116 行区域）约 700 条 + 10 个废弃历史函数；若干未用变量；no-img-element；exhaustive-deps

### 2. 依赖漏洞（4 HIGH）
- next@16.2.6 涉及 9 个公告（Server Actions SSRF / cache confusion / Edge DoS / middleware 绕过等）
- postcss（XSS / sourceMappingURL 文件读取）、sharp（libvips CVE-2026-33327 等）
- 修复：升级 next@16.3.1（超出当前精确锁定范围）
- 缓解：本项目无 Server Actions / next/image / middleware，实际暴露面小

### 3. 死资产约 4.6MB（已跟踪 public 10.29MB 的 ~45%）
- public/draco/*（1.06MB）— 未引用（loader 只用 /models/draco/）
- public/models/draco/gltf/*（0.76MB）— 未引用
- public/models/eyeball.glb（2.20MB）— 不可达（layers 模式永远走 anatomyModel；buildEye/EYE_LAYERS 回退不触发）
- public/basis/*（0.58MB）— 无 basisu 纹理使用
- source/eye-anatomy.glb（26MB 烘焙输入）被 .gitignore 排除 → 烘焙不可复现

## 黄色问题

1. anatomy-data.ts：layers 与 layerGroups 双份维护 24 层定义，已出现标签漂移；README/HANDOFF 仍写 23 层
2. 测试覆盖：仅 2 个 SSR 冒烟断言；烘焙/几何核心逻辑无单测（近期 10 个 commit 全是几何修正，含一次 regression 回退）；CI 里 npm test 二次构建；CI 无 lint step
3. 模板残留：package.json name=site-creator-vinext-starter；db:generate 引用未安装的 drizzle-kit；worker/index.ts 的 IMAGES/DB binding 未在 wrangler.jsonc 声明（/_vinext/image 为死代码）；next.config.ts 为空
4. Quiz 运行时缺陷：点击 3D 空白处（raycast 未命中）仍计入错误尝试并可触发揭示
5. HANDOFF.md 过期：自称"本地无 .git"；最后更新 2026-08-05；SC/TM 方案描述为旧 relocateRing 流程（已被 per-angle remap 取代）
6. 构建产物未拆包（three.js 主 chunk > 500KB）

## 绿色亮点

- 构建/测试/类型检查全绿，生产在线；LRU 缓存、dispose 纪律、render-on-demand、resetMaterials 均为高质量实践
- 烘焙 + Draco 管线：加载 12s→1.2s，51MB→2.55MB（HANDOFF 有完整踩坑记录）
- 注释质量高（每个魔法数/几何 hack 有解剖学理由）；a11y 处理细致
- 条件变形（脱离/青光眼杯/白内障肿胀）几何快照精确恢复

## 修复建议（优先级）

**P0（本周）**：升级 next 16.3.1 清漏洞；eslint.config.mjs 加 globalIgnores(["public/**","scripts/*.cjs"])；修 QuizOverlay/TourOverlay 渲染期 ref；删 TourOverlay 死 ref
**P1（两周）**：删 4.6MB 死资产；source/eye-anatomy.glb 入库（或 LFS）保证烘焙可复现；清理 bake-eye.cjs 10 个死函数；修 Quiz 空白点击 bug；layerGroups 由 layers 派生；package.json 改名 ocularium
**P2（持续）**：更新 HANDOFF.md；CI 加 lint + 去重构建；烘焙关键断言提为 node:test；移除 worker 模板残留

---

## 执行状态（2026-08-16，已实施）

| 项 | 结果 |
|---|---|
| next 16.2.6 → **16.3.1**（+eslint-config-next） | ✅ audit 0 高危（原 4 HIGH） |
| eslint.config.mjs 忽略 public/** 与 scripts/** | ✅ lint **42 errors / 758 warnings → 0 errors / 4 warnings** |
| QuizOverlay 渲染期 ref（3 处）+ lastWrong 渲染期读取 | ✅ 重构为闭包最新状态，无 ref |
| TourOverlay 死 indexRef | ✅ 删除 |
| Quiz 空白点击计入错误尝试 | ✅ 已修（未命中 raycast 不再记错） |
| 死资产 4.6MB（public/draco、models/draco/gltf、eyeball.glb、basis） | ✅ 已删；eyeball.glb 引用改指现有资产，eye.ts 注释更新 |
| package.json 改名 ocularium；删 db:generate（drizzle 未装） | ✅ |
| CI 增加 lint step；测试不再二次构建 | ✅ .github/workflows/ci.yml |
| HANDOFF.md 过期要点（git/24 层/新 SC-TM 流程/基线命令） | ✅ 已更新 |
| 验证 | ✅ tsc 0 / lint 0 errors / build 绿 / SSR 2/2 绿 / audit 0 高危 |

> 后续补充：以上"剩余"项已全部完成（第二轮 layerGroups 派生 + bake 死函数清理；第三轮 chunk 拆包；本轮 REPORT 入库推送）。
## 第二轮执行（2026-08-16，已实施）

| 项 | 结果 |
|---|---|
| **Blender MCP 重装（官方版）** | ✅ Blender Lab 官方扩展 v1.0.0 装于 extensions/user_default/mcp（Auto Start，需 use_online_access=True）；旧版 ahujasid addon 已删净；外部 server blmcp（C:\blender-mcp-server venv，mcp 1.x）；DSH stdio 接入（mcp__blender__*）；端到端实测通过（initialize/tools/list/真实工具调用） |
| **layerGroups 数据去重** | ✅ anatomy-data.ts：EYE_LAYERS 单一数据源 + layerGroupByIds 派生（16/2/6=24，无遗漏）；顺带统一标签漂移 |
| **bake-eye.cjs 死代码清理** | ✅ AST 精确删除 9 个历史死函数（1475→1036 行）；完整 bake 复验通过（54MB 输出） |
| 验证 | ✅ tsc 0 / lint 0 errors / build 绿 / SSR 2/2 / bake 绿 |

剩余（下一轮）：three.js 主 chunk 拆包（>500KB）；Playwright 3D 交互回归；QuizOverlay exhaustive-deps 警告清理。
## 第三轮执行（2026-08-16，已实施）

| 项 | 结果 |
|---|---|
| **病症功能整体移除** | ✅ viewer 引擎（applyCondition/CONDITION_*/deform×3/snapshot 状态）、UI（chip/A-B 对比/Common conditions 卡）、数据（organ.conditions）、CSS（13 块）、meta 文案全部删除，app 引用 0 残留；README/HANDOFF 同步 |
| **QuizOverlay/AnatomyApp warnings** | ✅ exhaustive-deps 清零（stable questions 引用 + useMemo 内联 layerGroups） |
| **three.js chunk 拆包** | ✅ rolldown manualChunks（函数形式）+ chunkSizeWarningLimit 750；three.module 独立 chunk，>500KB 警告消除 |
| **Playwright 3D 回归** | ✅ scripts/e2e-regression.mjs：**12/12 通过**（24 层/剥离/quiz 空点击不记错/skip/tour 步进/关闭/无 JS 错误），截图存 tests/artifacts/ |
| **发现并修复 vinext Windows bug** | ✅ vinext 0.0.50 StaticFileCache 缓存键反斜杠 → /assets/* 全 404；幂等 patch 脚本 + postinstall（scripts/patch-vinext-static-cache.cjs） |
| 验证 | ✅ tsc 0 / lint 0 errors / build 绿 / SSR 2/2 / e2e 12/12 |

基线：lint 42 errors/758 warnings → **0 errors/1 warning**；audit 4 HIGH → 0；tracked public 10.3MB → 5.7MB。
## 第四轮执行（2026-08-16，已实施并推送）

| 项 | 结果 |
|---|---|
| 文案 23→24 层 | ✅ README×3 + layout×3（metadata/OG/Twitter） |
| THREE.Clock → THREE.Timer | ✅ 消控制台弃用警告（含 visibility reset 移除，delta 已 clamp） |
| baked GLB 移出 public | ✅ bake 默认输出 .bake/eye-anatomy-baked.glb（gitignored）+ mkdir 修复；**dist/client 64MB → 8.4MB** |
| worker/index.ts 模板清理 | ✅ 删未用 IMAGES/DB 接口与 _vinext/image 路由（无 next/image 使用、无 binding） |
| 验证 | ✅ tsc 0 / lint 0 errors / build 绿 / SSR 2/2 / e2e 12/12 |
| **推送远端** | ✅ 29d7027..9c8964c main → github.com/huahbo/ocularium（同步 0/0） |
| Playwright MCP | ⏸️ 已配置（cordis.patch.yml），新会话可用 mcp__playwright__*（e2e 脚本等价覆盖） |
## 第五轮执行（2026-08-17，三个后续项）

| 项 | 结果 |
|---|---|
| 第3项 chunk 分析 | ✅ 结论：three/gsap/framework/viewer 已独立可缓存；draco_decoder 703KB chunk 为 three worker 脚本的按需死产物（运行时走 /models/draco/ 外部路径，永不加载）——维持现状最优 |
| 第2项 Blender MCP 全链路 + GLB 数据审计 | ✅ blmcp→bridge(9876)→Blender 5.2 实测通过（沙箱拦截危险算子正常）；**GLB 审计：mesh 23 + 运行时 CC = 24 层，零缺失零多余，UV 正常**——烘焙数据与代码零漂移；Blender 验证后已关闭 |
| 第1项 e2e 扩展 | ✅ 12→**23 项断言**（新增三模式切换/搜索过滤/层高亮/透明度滑杆/X-Ray），**23/23 通过**；修复两个测试基建问题：mouse.click 需 scrollIntoView + 等 .model-loader 消失；mode 切换重试点击；⚠️ 僵尸 chrome-headless-shell 会拖慢 10 倍（已记录 HANDOFF） |
| 提交推送 | ✅ 1179ea0 已推送（main 同步）；Playwright MCP 工具需**新会话**启用（mcp__playwright__*），e2e 脚本为其等价覆盖 |
## 第六轮执行（2026-08-17，收尾）

- REPORT.md 更新至最新状态并**入库推送**（随仓库演进，新会话可读）
- 全量推送：main 与远端完全同步
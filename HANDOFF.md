# Anatomy Atelier — 开发进度交接文档（HANDOFF）

> 用途：上下文清理后，由新会话读取此文档 + 恢复提示词，无缝继续开发。
> 最后更新：2026-08-16（健康基线见 `REPORT.md`：next 16.3.1 / lint 0 errors / audit 0 高危）

---

## 1. 项目概况

- **位置**：`E:\anatomy-main`（git 仓库，remote: `ocularium` → github.com/huahbo/ocularium，58+ commits）
- **技术栈**：Next.js 16.3.1 + React 19 + Three.js 0.185 + GSAP + Tailwind 4 + vinext (Cloudflare)
- **本质**：单眼球深度解剖教学应用（已删光其它 8 个器官）
- **启动**：`npm run dev`（Windows 已用 cross-env 修复，PS7 直接可跑）
- **构建**：`npm run build` ✅；**lint**：`npm run lint` ✅（0 errors，public/ 与 scripts/ 已加入 ignore）；**audit**：0 高危

## 2. 当前架构（已完成）

```
三栏布局：
├─ 左栏：24 层结构树（前节16/中节2/后节6 分组，含 collector channels）
│       点击=高亮 眼睛图标=隐藏 ◐=透明层 点击展开=透明度滑杆
├─ 中栏：OrganViewer（3D）
│       三模式：Layered / Anatomy / Outflow
│       工具条：rotate/zoom/isolate/section/layers/compare/reset
├─ 右栏：信息面板（Eye 详情/关键数据/病症）
└─ 底部：5 张插图卡片（microscopic/compare/animation/clinical/system）
```

### 关键文件
| 文件 | 职责 |
|---|---|
| `app/lib/anatomy-data.ts` | 23 层数据（layers/layerGroups/hotspots/anteriorLayerIds），单器官 |
| `app/lib/three/anatomy-materials.ts` | **程序化材质引擎**：CanvasTexture 生成器 + 外部贴图加载 + UV 投影（sphere/plane/cylinder/radial）+ Loop 细分 + 纹理缓存 |
| `app/lib/three/viewer.ts` | AnatomyViewer：三模式渲染、热点、highlightLayer、setLayerOpacity、setOnlyLayersVisible、applyAnatomyMaterials |
| `app/lib/three/loaders.ts` | GLB 加载/归一化 FIT_SIZE=3.8/resetMaterials |
| `app/lib/three/eye.ts` | 程序化分层眼球（备用，无 GLB 时降级） |
| `app/components/AnatomyApp.tsx` | 三栏布局 + 结构树 + 信息面板 + 插图卡片 + Quiz/Tour 入口 |
| `app/components/OrganViewer.tsx` | 3D 容器：三模式切换、高亮、透明度同步、剥离、viewerRef 暴露 |
| `app/components/QuizOverlay.tsx` | 交互式 3D 测验（Identify/Find，点击模型作答） |
| `app/components/TourOverlay.tsx` | 引导式解剖导览（10 步光路，聚焦+高亮+讲解） |
| `app/globals.css` | 全部样式 |

### 已用的真实贴图（`public/models/sclera-textures/`）
- `sclera-tileable.webp`（无缝巩膜，MIT RoboPoets）
- `iris-brown.webp`（真实棕色虹膜，MIT RoboPoets）
- `fundus-seamless.jpg`（真实眼底照，CC0 Wikimedia，视网膜用）
- 程序化：脉络膜放射血管树、角巩膜缘放射细血管、结膜平滑粉红、小梁网多孔网格等

## 3. 待做工作（用户已确认，按序实施）

### P1: 交互式 3D 测验（Quiz）✅ 已完成 (2026-08-06)
- 现状：Quiz 是纯文字弹窗（3 固定选项）
- 目标：在 3D 里点选结构——高亮结构让用户点选 / 显示结构让用户找出（Identify/Find 模式）
- 复用：现有热点系统、setLayerVisible、highlightLayer
- 参考：SciMynd 的 Identify/Find 模式
- 实现：`QuizOverlay.tsx` + viewer quiz 引擎（beginQuiz/endQuiz/quizSetQuestion/pickLayerAt/quizFlashLayer）+ `anatomy-data.ts` quiz 数据（10 题）+ 3D raycast 拾取
- 已验证：tsc+build 全绿；Playwright 实测 identify/find/错误重试/答错揭示/Skip/关闭恢复

### P2: 引导式解剖导览（Guided Tour）✅ 已完成 (2026-08-06)
- 预设旅程：角膜→虹膜→晶状体→视网膜…每步自动定位/高亮+文字
- 数据驱动：加 tour 配置，复用相机系统（tween 已有）
- 实现：`TourOverlay.tsx` + viewer tour 引擎（beginTour/endTour/tourStep）+ `anatomy-data.ts` tour 数据（10 步光路）+ focusLayer/highlight 复用
- 已验证：tsc+build 全绿；Playwright 实测步进/回退/Finish/关闭恢复/工具条隐藏

### P3: 性能优化 ✅ 已完成 (2026-08-06) — 构建期烘焙 + Draco
- **最终方案**：`scripts/bake-eye.cjs` 构建期烘焙——node 里复刻 `generatePartUVs`（sphere/plane/cylinder/radial）+ LoopSubdivision 细分（sclera/cornea/choroid/retina）写入 GLB，网格标记 `userData.baked=true`（经 GLTFExporter→draco→GLTFLoader 完整往返保留）
- **运行时**：`viewer.ts applyAnatomyMaterials` 检测 `mesh.userData.baked` → 跳过 UV 生成 + 细分（省 ~3.4s 阻塞）
- **体积**：烘焙版 51MB → draco 压至 **2.33MB**（原 26MB，-91%）。draco 量化 position 安全（运行时不再细分，无 KHR_mesh_quantization 死循环问题）
- **加载实测**（headless 冷加载）：模型 **1.2s 渲染完成**（原 12s，快 10 倍），截图无阻塞跳跃
- **关键结论**：加载慢真根因是 LoopSubdivision（原始版 8.1s：vitreous 4.7s/choroid 1.3s/sclera 0.8s/retina 0.7s/cornea 0.5s），非模型体积。vitreous 已移出细分（透明凝胶无视觉收益）
- **重新生成**：`node scripts/bake-eye.cjs` → 输出 `public/models/eye-anatomy-baked.glb`（51MB），再 `npx @gltf-transform/cli draco public/models/eye-anatomy-baked.glb public/models/eye-anatomy.glb`
- **回退**：原始 26MB 在 `C:\Users\ADMINI~1\AppData\Local\Temp\opencode\eye-anatomy-original.glb`（换回 + 运行时 baked 检测自动走旧路径，代码兼容）；烘焙 draco 版备份 `eye-anatomy-baked-draco.glb`
- **踩坑**：① meshopt 量化 position→[-1,1]→细分死循环（勿用）② draco 本地解码+细分>原始传输（烘焙前方案），烘焙后 draco 安全

### 眼底贴图修复（完整历程）✅ (2026-08-07)
- **问题**：Cross-section 剖切时眼底出现"哑铃形无血管区"（暗红边界+内部空）
- **排查历程**（6 轮排除）：血管覆盖→噪声→分布→几何孔洞→UV/接缝→光照——均非根因
- **真正根因**：正方形眼底照片的**四角是圆形眼底视野外的背景**（暗红/黑），被 sphere 映射进球面形成哑铃形区域
- **最终方案**：换 CC0 左眼眼底照片（Wikimedia `Fundus-photograph-left.jpg`，Augenarztpraxis Dr. med. Stephan Kaut）+ 管线：
  1. 眼底圆检测（径向亮度剖面，半径≈585px）
  2. **圆外径向镜像延伸**（眼底边缘纹理向外延续，替代背景）
  3. **四边无缝渐变混合**（seamless 保持）
  4. **roll 平移**视盘 → 纹理中心（-Z 缺口锚点，黄斑→颞侧解剖正确）
- **误判教训**：choroid 加 emissive（851fa93）解决的是光照死区（真问题但非哑铃）；NVIDIA 视觉模型被 prompt 锚定会幻觉（"还有哑铃"），最终以 PIL 硬数据为准
- 经验沉淀：skill `analyzing-images-with-nvidia-vision`（视觉模型调用法）+ `ocularium-dev-ops` 第 10 节（贴图锚点）
- 验证：视盘 (0.496,0.501) 居中、四角延伸、seam 2.8/2.2、剖切 99.5% 明亮眼底纹理、无哑铃

### 结膜材质改进 ✅ (2026-08-06)
- 问题：Palpebral Conj. 表面可见方块贴图、不够细腻
- 修复：① 3×2 `fillRect` 矩形噪点 → **双倍频 value noise 连续场**（broad 37px + fine 12px，bilinear-smoothstep，零硬边缘）；② 纹理分辨率 512 → **1024**（`CONJUNCTIVA_SIZE`，眼睑大面积显示防 texel stepping）
- 验证（纹理数组直读）：相邻像素差异 **0.410**、零硬边缘、自相关 0.988→0.943→0.632
- UV 投影诊断：结膜 sphere 投影放大仅 1.2x（非主因），未改动
- 真实照片方案评估：CC0 结膜无缝贴图不存在（临床照片有反光/无法平铺），不采用
- 代码：`app/lib/three/anatomy-materials.ts` 新增 `makeValueNoise` + 重写 `drawConjunctiva` + `CONJUNCTIVA_SIZE`

### A3: 结构搜索 + 相机飞入 ✅ (2026-08-06)
- 左栏结构树顶部搜索框：按 label/id 大小写不敏感过滤（`filteredGroups` useMemo）
- 点击结构（rail 或搜索结果）→ `viewer.focusLayer(layerId)` 相机飞入 + 高亮 + 透明度滑杆
- quiz/tour 激活时不抢相机（`!quizOpen && !tourOpen` 守卫）
- 无匹配显示 "No structures match"；清空恢复 23 层
- 验证：过滤精确、飞入生效（视角 diff 22.7）、清空恢复；tsc+build 绿
- 文件：`AnatomyApp.tsx`（selectStructure + structure-search UI）、`globals.css`（.structure-search 样式）

### B3: X-Ray 透视模式 ✅ (2026-08-06)
- 工具条 "X-Ray" 按钮（ScanEye icon）：`viewer.toggleXRay()` 快照全部层 opacity/transparent → 设 0.12（半透明看内层），关闭恢复；激活时清高亮/选择
- setOrgan/dispose 重置；验证：半透明生效（亮度 249→219）

### B4: 可拖动剖切平面 ✅ (2026-08-06)
- Cross-section 激活后显示深度滑块（`.section-control`）：`viewer.setCrossSectionDepth(±2.4)` 实时移动 clipPlane.constant
- 验证：滑块拖动剖面深度变化（diff 11-18）

### C1: 病症模式 ✅ (2026-08-06)
- `viewer.applyCondition/clearCondition` + `CONDITION_EFFECTS`：材质级模拟 4 种病症（白内障=晶状体浑浊、青光眼=视盘加深、黄斑变性=黄斑/fovea 暗沉、视网膜脱离=视网膜半透明苍白）
- UI：底部 "Common conditions" 列表可模拟项变按钮（`CONDITION_3D` 映射），点击应用/切换/恢复，"Viewing in 3D" 标签
- 验证：应用/切换/清除/不可模拟保持纯文本

### C2: 点击标签放大结构 ✅ (2026-08-06)
- 热点 callout 加 "Focus in 3D" 按钮：hotspot label → 层 id 匹配 → `focusLayer`（相机飞入）+ `highlightLayer`（高亮）
- 验证：callout 渲染 + 飞入生效（diff 30）

### C3: 房水流动动画 ✅ (2026-08-06)
- `viewer.toggleAqueousFlow`：40 粒子沿 CatmullRom 路径（睫状体→瞳孔→前房→小梁网→Schlemm 管）循环动画（~7.7s/圈），Normal 蓝色点（0x4aa8d8），depthTest:false 示意穿透
- animate 循环集成；quiz/tour 开始自动停止；setOrgan/dispose 清理
- UI：右栏 Animate 按钮改为触发 3D 流动（active 高亮）
- 验证：粒子可见 + 移动 + toggle 正常

### D1: git init + fork + CI ✅ (2026-08-06)
- `git init` + commits 已推送到独立仓库 **`huahbo/ocularium`**（`isFork:false`，已脱离原 fork，旧 fork 已删除）
- README 致谢原项目 thebuggeddev/anatomy
- `.github/workflows/ci.yml`：npm ci + tsc + build + npm test（CI 通过）
- **部署**：Cloudflare Workers → **https://ocularium.huahbo.workers.dev**（wrangler deploy；workers.dev 子域名 `huahbo` 通过 API 注册）
- 部署配置：`wrangler.jsonc`（name/main/assets/nodejs_compat）；siteUrl 已指向新域名
- ⚠️ 部署注意事项：nodejs_compat 只在 wrangler.jsonc 配置（vite.config 不重复加，否则产物 flags 重复部署报错）；Cloudflare API token 不落盘（临时环境变量）

### 品牌改名 Ocularium ✅ (2026-08-06)
- 左上角 + meta（title/description/OG/Twitter/applicationName）从 "Anatomy Atelier" → **"Ocularium — Anatomy of vision, in 3D"**
- 文件：`app/layout.tsx`、`app/components/AnatomyApp.tsx`（brand 按钮 + tagline）
- 域名 anatomy-atelier.openai.site 未改（部署域名）

### 病症 A/B 对比 + 相机归位 ✅ (2026-08-06)
- 视口状态条 `condition-chip`：病症激活时顶部显示 "⚠ Condition: X"（预览正常态时追加 "previewing normal state"）
- AB 对比按钮 `condition-compare`：病症卡 active 项下方 "Show normal / Show condition" 一键切换（同视角对比，chip 保留表示模式）
- 相机归位：applyCondition 快照相机，clearCondition tween 飞回；切换病症不飞回（相机快照保持）
- 验证：相机精确回位（diff <0.01），chip/按钮状态流转正常

### D2: 3D LOD + B1: WebGPU ⏸️ 低优先级评估 (2026-08-06)
- D2 LOD：模型已烘焙+压缩（1.2s 加载），单标本展示 LOD 意义小，跳过
- B1 WebGPU：three WebGPURenderer 兼容风险高，当前 WebGL 正常，跳过

## 4. HRA 原始数据注意事项（已知坑，显示时不可搞错）

HRA 眼模型（`source/eye-anatomy.glb`，26MB 原始，来自美国 Human Reference Atlas / Visible Human）的原始数据本身有多处问题，**所有显示逻辑必须使用修正后的数据，不能直接使用原始坐标**：

1. **SC/TM 位置错误（最麻烦，已修）**：原始数据 TM 半径 0.885、SC 半径 0.864，掉在**睫状体环的内孔**里。最终方案（2026-08-15 plan-A 起）：**逐角度 remap**——SC 每方向外缘 = 睫状体外缘 − 0.10（`remapRingToReference`），TM 每方向外缘 = SC 内缘 − 0.005（`remapRingInnerToReference`），z 对齐睫状体后缘平面。历史 `relocateRing`（均匀缩放）等 10 个旧函数已成死代码。**重新烘焙后必须验证实际 bbox**（12 扇区对比）。
2. **嵌套 mesh 连带隐藏（已修）**：fovea / macula lutea / optic disc 是 **retina 的子节点**；ciliary muscle 是 **ciliary body 的子节点**——父级从 rail 隐藏时子级连带隐藏（Three.js 规则）。`viewer.ts` 的 `flattenNestedMeshes` 在加载后把它们解绑到 model 根（保持局部变换，位置不变）。
3. **原始 GLB 无 UV**：所有 mesh 没有 TEXCOORD——运行时 `generatePartUVs` 按几何类型投影（sphere/plane/cylinder/radial），烘焙版已生成 UV（`userData.baked` 跳过）。
4. **mesh 名称在 draco 压缩后丢失**：`eye-anatomy.glb`（压缩版）的 mesh.name 为空——但 **node 名保留**（`VH_M_*_L`），three GLTFLoader 用 node 名填充 mesh.name——运行时按 mesh.name 匹配 layer id（`partIdForMesh`）。**不要用 gltf-transform 删除/重命名 node**。
5. **draco 丢 Line primitive**：CC（collector channels）烘焙即丢失——必须运行时生成（`buildCollectorChannels`，28 条线，SC 外壁 1.14 → 巩膜 1.55）。
6. **CC/SC/TM 的坐标系**：HRA 模型是**左眼**，0°=+X 为鼻侧——CC 鼻侧优势分布（inferonasal 最密 10 条）以此为前提。
7. **choroid/retina 纹理后极汇聚**：`generatePartUVs` 的 `backPole` 参数让血管树汇聚于 -Z（视盘/后极）。
8. **模型归一化**：加载时按 FIT_SIZE=3.8 归一化并居中（`loaders.ts`）——所有 hotspot 坐标（anatomy-data）在 FIT 空间。
9. **眼底贴图（纹理问题，非几何）**：正方形照片四角非眼底背景被 sphere 映射成"哑铃"形——已换 CC0 左眼眼底照片 + 圆外径向延伸 + seamless 修复。

## 5. 验证方法

- `npx tsc --noEmit` + `npm run build` 必须全绿
- Playwright MCP（`skill_mcp` + `playwright`）：操作页面 + 截图
- NVIDIA 视觉模型（`llama-3.2-90b-vision-instruct`）验证渲染效果：
  ```python
  # auth.json 在 C:\Users\Administrator\.local\share\opencode\auth.json
  # key = auth["nvidia"]["key"].strip()
  # POST https://integrate.api.nvidia.com/v1/chat/completions
  ```
  ⚠️ 该 API 频繁超时（限流），超时则用本地像素分析（PIL）兜底
- Blender MCP 可用（GUI 模式运行中，端口 9876）

## 5. 环境备注

- PowerShell 7.6，PS7 语法
- dev 服务器：`npm run dev`（3000 端口，若占用自动换 3001）
- Blender 5.2.0 LTS：`E:\Blender\blender-5.2.0-windows-x64\blender.exe`（GUI 运行中）
- 后端临时目录：`C:\Users\ADMINI~1\AppData\Local\Temp\opencode`

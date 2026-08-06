# Anatomy Atelier — 开发进度交接文档（HANDOFF）

> 用途：上下文清理后，由新会话读取此文档 + 恢复提示词，无缝继续开发。
> 最后更新：2026-08-05

---

## 1. 项目概况

- **位置**：`E:\anatomy-main`（GitHub fork: `huahbo/anatomy`，但本地**无 .git**）
- **技术栈**：Next.js 16 + React 19 + Three.js 0.185 + GSAP + Tailwind 4 + vinext (Cloudflare)
- **本质**：单眼球深度解剖教学应用（已删光其它 8 个器官）
- **启动**：`npm run dev`（Windows 已用 cross-env 修复，PS7 直接可跑）
- **构建**：`npm run build` ✅（当前全绿）

## 2. 当前架构（已完成）

```
三栏布局：
├─ 左栏：23 层结构树（前节15/中节2/后节6 分组）
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

- A3 结构搜索+相机飞入
- B3 X-Ray 透视模式（外层半透明）
- B4 可拖动剖切平面（任意角度+剖面填充）
- C1 病症模式（白内障/青光眼/黄斑变性/视网膜脱离 程序化模拟）
- C2 点击标签放大结构+详情展开
- C3 房水流动动画（GSAP/粒子，契合 Aqueduct 研究）
- D1 git init + 连接 fork + GitHub Actions CI
- D2 3D LOD
- B1 WebGPU 渲染器（低优先级）

## 4. 验证方法

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

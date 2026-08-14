# CLAUDE.md

This file provides guidance to Claude Code (claude.ai/code) when working with code in this repository.

## 项目概述

竹知了 —— 传统玩具的 Web 模拟版（甩起来"哇哇"叫的竹筒玩具）。核心承诺：**零依赖、单文件、无构建、纯前端**，用浏览器直开 `index.html` 即可玩（含 `file://`）。线上地址 <https://imsai.top>，纯静态走 Cloudflare Pages，**没有任何后端**（页面加载完不发任何请求）。

许可不是开源：源码公开供学习，禁止再分发/公开部署/商用，见 `LICENSE`。改动 README 或页面文案时不要写"开源"，用"源码公开"。

## 开发流程和注意事项
- 禁止擅自push到远程oss
- 在独立branch/worktree开发完毕之后，将局域网可验证的https网址链接展示给用户审核(每个 worktree 用随机端口，否则会产生冲突)，审核通过后才能合并到main，然后deploy到cloudflare

## 常用命令

没有构建、lint、测试。开发即改 `index.html` 后刷新浏览器。

```bash
# 局域网试玩（手机连同一 Wi-Fi 访问 http://<电脑IP>:8123）
python3 -m http.server 8123

# 局域网 HTTPS（手机"甩手机"体感模式需要安全上下文才有 devicemotion）
python3 .claude/tls/serve-https.py        # 默认 8443，证书在 .claude/tls/，不进 git
```

## 架构

两块代码，边界清晰：

### `index.html`（~1350 行，主体）

单文件包含全部 HTML/CSS/JS，按注释分节：**物理 → 声音 → 视觉特效粒子 → 绘制 → 主循环 & 交互 → 计数**。

- **物理是唯一事实源**：竹筒是绳系质点（重力 + 只拉不推的弹性绳 + 空气阻力），1/240s 定步长积分。发声核心变量是绳方向角速度，声音、2D 绘制、3D 层都只消费物理状态。
- **声音**：主音源是内嵌 base64 AAC 真实录音采样（变量 `ZZL_SAMPLE`，无缝循环，回放速率随转速），解码失败回退纯 Web Audio 合成链。音频初始化受 user activation 规则约束（首次触摸/点击时解锁）；有僵尸 AudioContext 心跳检测与重建（后台切回失声问题）。
- **计数**：只有个人哇数，存 localStorage（`zzl_mywah`），不联网不上报。曾有一套 Worker + Durable Object 全站实时计数，已整体下线并从仓库移除——**不要再往页面里加任何网络请求**。

### `3d/`（可选 WebGL 渲染层）

主站通过动态 `import('./3d/boot3d.js')` 在 2D 画布上叠一层透明 WebGL。**物理、声音全部留在主站**，3D 层只是每帧接收物理状态摆位姿。

- `boot3d.js`：`init(canvas)` 返回 `{resize, render, clear, dispose}`，失败返回 `null`；`file://` 直开或 WebGL 不可用时 import/init 静默失败，主站自动回落 2D 手绘小蝉——**这个回落链不能破**。
- `model.js`：纯代码程序化 Three.js 模型（Canvas 2D 生成贴图，无外部网格/贴图资源），比例按实物三视图测量，以筒身高为 1 单位。
- `vendor/`：three.js 与 OrbitControls 直接 vendor 进仓库（importmap 映射 `three`），不走 npm。

## 约束

- **不引入任何构建步骤或 npm 依赖**：新资源要么内嵌（base64）、要么 vendor 进仓库、要么走可静默失败的动态 import。
- **移动端优先**：改交互/布局时注意安全区适配、多点触控互斥、触屏锚点上移、绳长随屏幕缩放这些已有处理。
- 修改 3D 层时保持接口不变（主站只认 `init` 返回的四个方法），且任何失败都必须静默回落 2D。
- **纯前端不回头**：不加后端、不加统计上报、不加任何第三方脚本或外链资源，页面加载完就不应再有网络请求。
- README.md 详细记录了发声原理、采样制作方式和物理模型，改相关行为时同步更新。

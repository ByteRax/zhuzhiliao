# Repository Guidelines

## Project Structure & Module Organization

- `index.html`：主应用，包含全部 HTML、CSS、物理模拟、Web Audio、交互和实时计数逻辑；项目坚持零依赖、无需构建。
- `3d/`：可选 WebGL 渲染层。`boot3d.js` 负责生命周期，`model.js` 负责程序化模型，`vendor/` 存放直接 vendor 进仓库的 Three.js 文件。
- `worker/src/index.js`：Cloudflare Worker 与 SQLite Durable Object 计数后端；`worker/wrangler.jsonc` 保存部署和路由配置。
- 根目录静态资源包括 `sw.js`、`manifest.webmanifest`、SEO 文件、图标和社交分享图。当前没有独立测试目录。

## Build, Test, and Development Commands

本项目没有构建、lint 或自动化测试流程。修改 `index.html` 或 `3d/` 后直接刷新浏览器验证：

```bash
python3 -m http.server 8123
python3 .claude/tls/serve-https.py  # 体感模式需要 HTTPS
cd worker && npx wrangler deploy  # 部署 /api/* 后端
```

手机测试时使用同一 Wi-Fi 访问局域网地址；`devicemotion` 相关功能需安全上下文，并需覆盖触屏、自动甩、断线和 WebGL 不可用时的 2D 回退。

## Coding Style & Naming Conventions

沿用现有单文件结构和注释分节，保持改动局部、格式与周边代码一致。JavaScript 使用 2 空格缩进；变量和函数使用 `camelCase`，常量使用全大写下划线（如 `ZZL_SAMPLE`）。不要引入 npm 依赖或新的构建步骤；新资源应内嵌、vendor，或通过可静默失败的动态 import 加载。

## Testing Guidelines

没有测试框架或覆盖率门槛。提交前至少手动验证桌面浏览器、移动触摸交互、音频初始化、`file://` 直开，以及 3D 初始化失败时仍能回落到 2D。后端改动还应检查 WebSocket 连接、批量计数和部署配置。

## Commit & Pull Request Guidelines

提交信息应简短、以动作开头；历史中可见 `FEAT(...)`、`SEO：...`、`修复 ...` 等风格。PR 请说明行为变化和验证方式，涉及视觉改动附截图或可访问的局域网 HTTPS 链接，并关联 Issue（如有）。请在独立 branch/worktree 开发；未经审核不要合并到 `main` 或部署到 Cloudflare，也不要擅自 push 到远程 OSS。

## Configuration & Architecture Notes

物理状态是声音、2D 和 3D 渲染的唯一事实源；修改 3D 层时必须保持 `init()` 返回的 `resize`、`render`、`clear`、`dispose` 接口及静默 2D 回退。涉及玩法、声音或后端同步策略的改动，应同步更新 `README.md`。

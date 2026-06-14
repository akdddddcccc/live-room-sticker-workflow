# 自动化直播间贴片设计工作流

一个独立的 Vite / Vue 工具站，用于根据参考图生成直播间上贴、侧贴、下贴背景和文字图层，并导出可继续放进 Figma、Photoshop 或直播间搭建流程里的 PNG 素材。

## 本地预览

```bash
npm install
npm run dev
```

本地 AI 接口服务：

```bash
npm run dev:workflow
```

## EdgeOne 部署

`edgeone.json` 已配置：

```text
Install command: npm install
Build command: npm run build
Output directory: ./dist
Node version: 22.11.0
```

## 两套 API

个人预览站使用 OpenAI 官方 API：

```text
OPENAI_PROVIDER_LABEL=OpenAI official
OPENAI_API_KEY=<personal OpenAI API key>
OPENAI_BASE_URL=https://api.openai.com/v1
OPENAI_IMAGE_MODEL=gpt-image-2
OPENAI_IMAGE_QUALITY=low
```

单位镜像站使用单位 API：

```text
OPENAI_PROVIDER_LABEL=Company API
OPENAI_API_KEY=<company API key>
OPENAI_BASE_URL=<company OpenAI-compatible base URL ending in /v1>
OPENAI_IMAGE_MODEL=gpt-image-2
OPENAI_IMAGE_QUALITY=low
```

真实 key 只放在 EdgeOne 环境变量里，不要提交到 GitHub。

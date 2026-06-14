# AI直播间贴片生成项目

独立版直播间贴片生成工具。支持：

- 根据参考图生成上贴、侧贴、下贴背景。
- 生成文字贴片图层。
- 上传无贴片直播间截图，预览融合效果并导出 PNG。
- Web 部署和 Electron 桌面端打包。

## 本地 Web 运行

```bash
npm install
copy .env.local.example .env.local
npm run local:workflow
npm run dev
```

真实 API Key 只放在 `.env.local` 或桌面端本机配置里，不提交到 GitHub。

## Windows 桌面端

```bash
npm install
npm --prefix desktop install
npm run desktop:pack
```

输出目录：

```text
desktop/dist/
```

## macOS 桌面端

请在 Mac 上执行：

```bash
npm install
npm --prefix desktop install
npm run desktop:pack:mac
```

macOS 首次打包如果需要签名、公证，需要后续配置 Apple Developer 证书；内部测试可以先做未签名包。

## 配置

`.env.local.example` 默认使用公司接口地址：

```env
OPENAI_BASE_URL=https://api.ofox.io/v1
OPENAI_PROVIDER_LABEL=Company API
```

桌面端启动后也可以直接在界面里填写 URL 和 Key。

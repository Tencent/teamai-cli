# TeamAI 网站

[#1131](https://github.com/Tencent/teamai-cli/issues/1131) 的独立静态站点。需要 Node.js 20+；无额外依赖，不包含 CLI 源码或文档副本。

```sh
cd website
npm run build
npm test
python3 -m http.server 4173 --bind 127.0.0.1 --directory dist
```

打开 `http://127.0.0.1:4173`。Python 3 只用于上述本地预览命令，也可使用其他静态文件服务器。将 `website/dist/` 内的文件部署到静态托管平台即可。链接和资源使用相对路径，也支持部署到 URL 子路径。托管平台、域名和自动发布方式由维护者确定。

## 贡献真实使用案例

先在 [#1131](https://github.com/Tencent/teamai-cli/issues/1131) 分享提议：团队如何搭建 TeamAI，以及日常如何使用。包括使用的工具、可公开的仓库结构和一个真实工作流。不要包含私有代码、凭据或编造的结果。

范围确定后，在 `website/use-cases/` 下贡献 HTML 页面，并在首页案例区域添加链接。使用相对资源路径（如 `../styles.css`）和易于访问的标题结构。构建时原样复制这些页面。如果案例使用其他语言，请设置对应的 HTML `lang`。

目前没有已贡献的案例。首个真实案例到来前保持 `use-cases/` 为空；Git 不跟踪空目录，构建会在缺失时创建它。不要在其中添加虚构案例或 `.gitkeep`。

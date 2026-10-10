# 图片与 XLSX 预览

v1 已支持图片与 `.xlsx` 只读预览。进入首页 `/` 或会话页 `/session/:sessionId`，选择工作区并打开“文件”：点击图片打开图片预览弹窗；点击 `.xlsx` 在编辑器区域显示表格预览，窄窗口或移动端使用弹窗。聊天中的文件链接通过同一个编辑器接入预览。

v2 的 `/data-agent/files` 文件 Tab 也复用这套预览组件。

- 图片：PNG、JPEG、GIF、SVG、WebP、ICO、BMP；支持缩放、100% 原尺寸、适应窗口、尺寸显示与下载原图。预览上限 20 MB，加载超时为 30 秒。
- XLSX：切换工作表，显示行号和 Excel 列标，每页 100 行。单个文件上限 10 MB，每张表最多预览前 1,000 行、100 列；单元格文本最多 2,000 字符，整张预览文本最多约 200 万字符。截断时显示提示。
- 保留数字、日期等显示值。公式读取文件中保存的结果；没有缓存结果时显示公式文本，不执行公式。此版本不还原图表、图片、复杂样式或合并单元格，也不支持编辑、旧版 `.xls` 或加密工作簿。
- 空表、损坏文件、无权限、文件不存在、超限和超时均有提示，提供重新加载与原文件下载。
- 覆盖同名文件后，已打开的图片和 XLSX 预览会根据当前工作区的文件变化通知自动重新加载；本地和 WebSocket 的重复通知会合并。XLSX 重新加载后回到首个工作表、第一页。

读取与下载复用带登录、租户和工作区上下文的文件接口。XLSX 在 Web Worker 中解析，仅读取当前工作表；切表重新解析，关闭 Tab 终止 Worker。单次文件加载或切表超过 20 秒会中止。

依赖采用 [SheetJS 官方 0.20.3 分发包](https://docs.sheetjs.com/docs/getting-started/installation/frameworks/)，安装地址及完整性哈希固定在 package-lock.json；浏览器运行时不访问第三方解析服务或 CDN。

## 验证

```sh
npm run test:file-preview
npm run typecheck
npm run build:client
npm run preview:files
```

本地示例页默认位于 `http://127.0.0.1:4403`，默认展示 v1 聊天文件链接与编辑器预览，可切换到 v2 文件 Tab。页面使用真实组件和内存样例，包含多 Sheet、大表、空表、损坏和超限文件，以及窄栏、深色模式切换。它不会连接生产数据库或调用模型。可用 `FILES_PREVIEW_PORT` 修改端口。

`test:file-preview` 同时运行前端预览用例与后端读取路径边界用例，包括工作区内符号链接、越界符号链接和不存在的文件。

端到端验证使用真实应用和临时账号、数据库及工作区。先运行服务，再在另一个终端执行 API 验证：

```sh
npm run preview:files:e2e
npm run test:file-preview:api
```

启动方式、浏览器操作和验证结果见 [图片与 XLSX 端到端测试记录](file-preview-e2e.md)。

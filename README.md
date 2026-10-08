# StartFlow 2.0.0

**Windows 智能工作流管理平台** · Your Workspace, Ready in Seconds.

在现有 Tauri 2 / React / Rust 项目上增量升级。简单启动列表保留；可视化顺序和条件分支由 Rust 后台执行。配置、历史与自动自然日去重保存在当前用户 SQLite。核心离线可用，无账号、云服务、遥测、Electron 或 Python 核心运行时。

## 安装

安装 `release/StartFlow_2.0.0_x64-setup.exe`。当前用户安装，沿用 V1 应用标识和数据目录。首次升级前自动创建一致性 SQLite 备份；不会主动开启登录自启。关闭主窗口默认隐藏到托盘，彻底退出后后台调度暂停。

## 新增功能

- React Flow 三栏工作流编辑器：自定义节点、拖拽、连线、框选、缩放、复制、删除、撤销重做、自动排列、对齐线、键盘连线、未保存提示、验证、保存、真实测试和正式执行。
- Rust 顺序 / 条件引擎：启动节点复用 V1 Task Launcher；开始、结束、延迟、条件、等待网络、窗口布局、通知、其它简单场景。真实节点状态、结果、取消、超时、失败策略和 interrupted 恢复。
- AND / OR 条件：时间区间（含跨午夜）、指定星期 / 自定义工作日、完整路径进程、文件、文件夹、本地网络接口、带超时 HTTPS 服务。明确 true / false / error；系统错误不隐式变为 False。
- Windows 窗口布局：枚举顶层窗口和显示器；路径 / 瞬时 PID / 标题匹配，相对工作区位置、大小、最大化；线程 DPI 上下文和物理坐标；缺失显示器主屏 / 跳过 / 备用布局回退，读取实际位置验证结果。
- 全局快捷键：官方插件实际注册、录制、重复与系统占用检查、失败回滚、重启注册、删除注销。默认不预占用组合键。
- 独立命令面板：托盘、顶部或快捷键呼出；本地搜索场景、任务和操作；上下键、Enter、Esc。共用已初始化数据库与调度器。
- 个性化：保留深色 / 浅色 / 跟随系统、强调色与动画；五种统一颜色预设、圆角、密度、渐变 / 图片背景。安全复制 PNG / JPEG / WebP，最大 8 MB、4096×4096。
- 模板：办公、剪辑、工作日、空白结构；个人模板保存、重命名、删除和预览。通用模板不预填假定软件路径。
- 备份：升级前 SQLite 完整副本；手动 / 每日 / 每周 JSON，默认每日、保留 7 份自动备份；预览、UUID 冲突重映射合并、完整替换二次确认、恢复前备份、引用验证与事务回滚。
- 工作台与监控：真实下次计划、当前节点、已执行数量、取消、最近工作流与失败；历史可查询完整节点路径。隐藏主窗口停止前端快照刷新。

V1 网页 / EXE / LNK / 文件夹、多场景、复用排序、每日 / 每周 / 登录规则、补执行、托盘、单实例、日志、主题、引导和数据管理继续保留。复制高级场景保留其工作流绑定和关联简单布局，共享任务继续复用；计划和快捷键不自动复制。

转换简单场景只创建可恢复草稿，保留旧列表。保存不激活高级模式；首次正式执行明确确认切换。恢复简单模式使用保留的旧列表，不静默扁平化条件工作流。

最多 200 节点，整体最长 60 分钟，同时最多 4 个场景 / 独立任务。同场景全部入口互斥，自动场景保留自然日去重。一个开始节点、其它节点一条入边、条件两条明确分支，各自连接结束；不支持循环、并行和汇合。

“请求已提交”表示 Windows 接受启动请求，不确认第三方已完全就绪，也不检测浏览器标签页。取消中断等待和未来节点，不强制结束已启动应用。退出 / 崩溃后记录 interrupted，不从中间自动恢复。

## 开发

Windows 10/11 x64、Node 24.16.0、Rust 1.99.0（工具链固定）、Visual Studio C++ 桌面开发和 Windows SDK、WebView2 Evergreen Runtime。

```powershell
$env:Path = "$env:USERPROFILE\.cargo\bin;$env:Path"
npm ci
npm run desktop
```

`scripts/dev.ps1` 也启动真实桌面程序。`npm run dev` 仅前端服务，普通浏览器不能执行本地系统命令，界面不提供伪造数据。

## 检查与测试

```powershell
npm run build
npm test
npm run format:check
cargo fmt --manifest-path src-tauri/Cargo.toml -- --check
cargo test --locked --manifest-path src-tauri/Cargo.toml
cargo clippy --locked --manifest-path src-tauri/Cargo.toml --all-targets -- -D warnings
```

原生测试在上述 Cargo 检查后重新 Tauri 构建，避免把依赖 Vite 的普通 Cargo 开发产物当作内嵌前端的桌面程序：

```powershell
cargo build --locked --manifest-path src-tauri/Cargo.toml --example launch_probe
npm run tauri -- build --debug --no-bundle
npm run test:native
npm run test:native:v2
npm run test:ui:v2
```

测试顺序运行，先关闭其它 StartFlow 实例。使用临时库、受控 EXE 与两个 WinForms 窗口；V1 回归临时注册并清除测试自启。V2 先用真实 V1 调试程序创建基线，再升级并核验工作流、窗口、快捷键、主题和备份。仅调试版接受 `STARTFLOW_TEST_DATA_DIR`，发行版忽略；调试端口仅由测试环境参数打开。

本机保存的 `release/StartFlow_1.0.0-debug.exe` 不进入安装包；重建方法见 [升级说明](docs/UPGRADE-V2.md)。报告和真实截图在 `test-results/`；交付证据见 [V2 测试记录](docs/V2-TEST-RESULTS.md)。旧 V1 证据另行保留。

## 打包

```powershell
npm ci
npm run bundle
# 或含自动化检查的完整流程
./scripts/build.ps1
```

默认产物：`src-tauri/target/release/bundle/nsis/StartFlow_2.0.0_x64-setup.exe`。显式指定 `npm run bundle -- --target x86_64-pc-windows-msvc` 时位于 `src-tauri/target/x86_64-pc-windows-msvc/release/bundle/nsis/`。

`.github/workflows/windows.yml` 使用锁文件和固定工具链构建并上传 NSIS。`npm run test:upgrade` 检查现有安装的真实原位升级，保留生产配置与历史，不创建测试业务数据、不卸载用户数据。旧 `installer-smoke.mjs` 是 V1 干净安装测试。

缺少 WebView2 时 NSIS 提供微软运行时安装引导；已有运行时后核心离线可用。安装包暂未配置代码签名。卸载默认保留数据，只有用户主动勾选删除应用数据才删除。

## 数据与限制

通常位于 `%APPDATA%\com.startflow.desktop`，设置显示准确目录。数据库 `startflow.sqlite3`，备份 `backups/`，背景 `backgrounds/`。保留 V1 表，迁移到数据库版本 2；内部 Config `version:1` 保持兼容，外层导出 `schema_version:2`。迁移失败回滚并停止，未知 / 未来数据库拒绝初始化，不创建空库替换。

导入不运行内容，两种恢复均暂停自动任务；完整替换停用所有快捷键，合并保留当前主题和原有快捷键，导入快捷键停用。恢复前备份，历史与日期去重保留，Windows 自启注册独立处理。常规 JSON 不备份执行历史，升级 SQLite 副本包含旧历史。

不执行任意 JS / CMD / PowerShell 节点，不绕过 UAC、不申请管理员服务、不上传配置或窗口内容。程序与参数分离，网址仅 http/https，服务探测仅 HTTPS 且不跟随重定向。远程网页不进入受信任 WebView，capabilities 最小授权。

管理员程序、独占全屏、受限窗口或限制大小的应用可能无法恢复。浏览器标签不是独立窗口。进程完整路径识别对无权限进程存在可见性限制；本地接口可用不等同互联网可达。

自动更新 P2 未启用：尚无可信发布源、签名公钥和签名产物，未填写虚假地址。真实登录、睡眠恢复、物理双屏断开 / 混合 DPI 和长期性能仍需 [Windows 手工验收](docs/V2-WINDOWS-VALIDATION.md)。

[V1 基线](docs/V1-BASELINE.md) · [V2 架构](docs/V2-ARCHITECTURE.md) · [升级与回退](docs/UPGRADE-V2.md) · [V2 测试结果](docs/V2-TEST-RESULTS.md)

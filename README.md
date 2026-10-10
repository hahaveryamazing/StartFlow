# StartFlow 3.1.0 · 第五阶段

**StartFlow 智能工作中心 · Intelligent Workspace Automation**

GitHub 私有仓库：[hahaveryamazing/StartFlow](https://github.com/hahaveryamazing/StartFlow)。当前 Windows 安装包与校验文件位于 [V3.1 第五阶段预发布](https://github.com/hahaveryamazing/StartFlow/releases/tag/v3.1.0-phase5)，需有仓库访问权限。预发布保留测试报告中的未验收项；源码下载不包含最新安装包或浏览器运行时，构建时按文档准备依赖。

Windows 本地桌面程序，沿用 Tauri 2、React、TypeScript、Rust 和 SQLite。V3 在既有启动场景、可视化工作流、托盘调度和窗口布局上增加真实设备环境感知、规则决策、模拟器与受控 AI 配置草稿。核心功能离线运行，没有云端账号体系、遥测或默认数据上传。

## V3.1：安全凭据与网页登录

第一阶段增量添加网页 / Windows 应用账号管理。同一目标支持多个账号；Rust 通过 Windows Credential Manager 保存、更新、删除和检查密码。SQLite 仅存元数据及 UUID 引用。密码不提供读取 IPC，不进入普通 JSON、前端存储、日志或备份。历史报告见 [第一阶段交付](docs/V3.1-CREDENTIALS.md)。

第二阶段添加真实 Playwright 网页登录：每个账号独立持久 Profile、优先复用有效会话、明确授权后读取绑定凭据、精确 HTTPS/Origin/表单校验、一次自动提交、持久冷却、人工验证等待和真实身份结果检测。Rust 使用固定受控 Node 服务及匿名管道，不通过参数或端口传密码。第二阶段历史交付见 [安全限制](docs/V3.1-WEB-LOGIN.md)。

第三阶段增加**可视化网页登录录制器**：「账号与凭据」中点击“配置网页登录 / 录制登录流程”，在独立浏览器点选账号框、密码框、登录按钮；人工登录后选择成功与身份标识，分别测试、编辑并保存定位规则。优先采用 Role / Label / Placeholder / TestId，必要时使用唯一 CSS。录制不读取凭据、输入值、Cookie 或令牌；保存不会执行，真实测试需另行确认。详见 [使用指南、测试与限制](docs/V3.1-LOGIN-RECORDER.md)。当前阶段支持同 Origin 的 HTTPS 表单，尚不支持跨域 SSO、iframe、复杂多页与无安全表单的登录。

随后增量改为**浏览器按需准备**：启动时检测已安装 Edge / Chrome，并实际验证启动与 CDP 能力；不可用时允许从官方来源下载专用 Chromium。只复用浏览器程序，每个账号仍使用 StartFlow 独立 Profile。检测、下载、取消和错误状态在「网页登录」页面显示；准备浏览器不执行登录。详见 [精简安装包交付](docs/V3.1-BROWSER-ON-DEMAND.md)。

当前数据库为版本 7，迁移前备份，失败回滚。Schema 4 配置包可导出账号和登录规则元数据，导入时重映射引用并要求重新录入密码和授权；不包含密码、Cookie 或浏览器 Profile。专用 Profile 含敏感会话，仅保留本地，不进入配置、AI 或备份。密码属于当前 Windows 用户，跨设备恢复需要重新录入。

## 安装与使用

V3.0 稳定安装包保留在 `release/StartFlow_3.0.0_x64-setup.exe`；其 V2 原位升级结果见原有 V3 测试报告。V3.1 第一阶段安装包已实际构建，位于 `release/StartFlow_3.1.0_x64-setup.exe`。构建和验证范围见阶段报告；未执行安装或替换已安装的生产应用。升级自动备份数据库，保留旧场景、任务、工作流、布局、快捷键、主题、调度和日志；不主动开启 Windows 登录自启。

V3.1 第二阶段 Windows x64 NSIS 安装包已实际生成：[StartFlow_3.1.0_phase2_x64-setup.exe](release/StartFlow_3.1.0_phase2_x64-setup.exe)，172.98 MiB。内含 Node 24.16.0、Playwright 1.64.0 与专用 Chromium 156.0.8078.4，用户无需另装 Node 或日常浏览器。SHA-256 与依赖锁文件校验值见 [构建清单](release/StartFlow_3.1.0_phase2_manifest.json)。此安装包未签名，尚未执行安装/卸载验收；没有更改用户生产数据库。

第二阶段精简包：[StartFlow_3.1.0_browser-light_x64-setup.exe](release/StartFlow_3.1.0_browser-light_x64-setup.exe)，29.27 MiB，浏览器本体已从打包清单移除，仍内含 Node / Playwright。没有可用 Edge / Chrome 时，在「网页登录」点击“下载专用浏览器”；约需数百 MB 本地空间，支持取消和重试。历史安装包和 [构建清单](release/StartFlow_3.1.0_browser-light_manifest.json) 保留。

**第三阶段历史安装包**：[StartFlow_3.1.0_phase3_x64-setup.exe](release/StartFlow_3.1.0_phase3_x64-setup.exe)，约 29.39 MiB，已加入可视化录制器，继续采用浏览器按需准备。实际构建与校验值见 [清单](release/StartFlow_3.1.0_phase3_manifest.json)。未签名，未安装覆盖生产应用或进行此包安装/卸载验收。录制器及凭据回归已在独立 debug 应用与合成本地 HTTPS 网站上完成 Windows 原生测试。

首次升级后智能自动化、Wi-Fi 感知、持续应用检测与 AI 默认关闭。先在系统设置的「隐私与环境感知」中选择需要的能力，再创建规则，用模拟器确认结果。新规则默认禁用且采用请求确认；选择自动执行会要求明确确认。关闭主窗口默认隐藏到托盘，Rust 服务继续运行；彻底退出后不会独立执行计划。


第四阶段增加 **Windows 桌面应用登录与可视化控件录制**：通过 Rust Microsoft UI Automation 定位绑定 EXE 的窗口，用户明确授权后使用安全凭据填写并最多提交一次；成功与账号身份双重核验、会话复用、人工验证降级、进程超时隔离及 Schema 6 事务迁移。使用方式、实际验证和限制见 [第四阶段说明](docs/V3.1-DESKTOP-LOGIN.md)。不改变现有工作流核心。

第五阶段已将网页与桌面登录接入原有 Rust 工作流，新增「检查登录状态」「自动登录」「等待人工验证」「登录结果分支」。包含明确的本机授权、失败策略、取消与超时、账号中心及工作台真实登录历史、AI 登录草稿引用和不含密码/会话的 Schema 4 配置备份。数据库升级至 Schema 7。

**当前交付为第五阶段**：[安装包](release/StartFlow_3.1.0_phase5_x64-setup.exe) · [构建清单与 SHA256](release/StartFlow_3.1.0_phase5_manifest.json) · [使用、迁移与安全说明](docs/V3.1-INTEGRATION.md) · [实际测试报告与限制](docs/V3.1-PHASE5-TESTS.md)。安装包不含浏览器本体，继续探测现有 Edge/Chrome 或由用户确认下载专用 Chromium。未签名；第三方网站和应用需逐项验证，扫码/MFA/UAC 由用户完成。

## V3 功能

- 真实 Windows 环境：活动网络接口、授权后的当前 Wi-Fi、显示器位置和缩放、电源及电池、当前用户会话、指定完整路径进程和窗口、带超时的指定 HTTPS 服务。未知、拒绝权限、不支持和错误分别展示。
- 原生通知：网络接口 / WLAN、显示器、电源、锁定 / 解锁和睡眠恢复；有限队列、防抖与稳定等待。指定应用检测仅按启用规则进行，使用有界低频补查。
- Rust 四值规则：True / False / Unknown / Error，AND / OR / NOT，最多三层、64 条件节点。优先级和稳定排序、互斥模式、冷却、持久化事件去重、全局暂停与人工覆盖。
- 统一执行：所有环境动作复用既有协调器和工作流引擎；同场景互斥、最多四个场景 / 独立任务、自动场景自然日去重。失败隔离、可取消等待、超时与中断恢复继续生效。
- 工作模式：手动、建议、自动策略；一小时、今日、下次登录或手动取消的覆盖期限。办公、创作、便携模板生成禁用的建议草稿，具体网络和程序仍由用户填写。
- 规则表单：触发事件、嵌套条件卡片、关联场景 / 工作流、模式、优先级、执行策略、冷却和稳定时间；本地确定性冲突分析。支持每日日程与星期范围。
- 后端模拟器：可注入时间和设备状态，复用正式评估 / 冲突算法；无启动请求、无数据库执行记录副作用。历史回放使用原规则版本、事件、运行约束和脱敏快照。
- 决策诊断：真实匹配路径、跳过原因、待确认建议、实际执行 ID、下次可执行时间；升级后运行中断标记为 interrupted，不盲目重新启动第三方软件。
- AI 草稿助手：兼容标准协议的用户本地或云端服务、精确发送预览、结构化结果、参数校验和用户确认。API Key 保存在 Windows Credential Manager；AI 草稿不会自动保存为启用配置或执行。没有配置模型时其余功能正常。
- 智能工作台、环境面板、工作模式、规则、模拟器、决策历史、隐私中心和真实 SQLite 本地统计。旧版导航入口全部保留，页面按需加载，隐藏窗口停止前端快照刷新。
- 完整备份 / 恢复覆盖 V3 规则和模式；合并 UUID 引用重映射、预览、恢复前备份、事务校验；导入不执行且关闭新增敏感权限。升级备份包含旧日志。

V1 / V2 的网页、EXE、LNK、文件夹、多场景、复用排序、登录 / 每日 / 每周调度、补执行、单实例、系统托盘、日志、主题、React Flow 工作流、条件分支、Win32 布局、全局快捷键、独立命令面板、模板及备份保持原架构。详细旧版能力见 [V2 README](docs/V2-README.md)。

“启动请求成功”不代表第三方程序完全就绪。取消不强制结束已经启动的应用，不检测浏览器标签页。Windows 权限受限时不会绕过 UAC。规则未知状态默认不授权自动执行。

## 开发

Windows 10/11 x64、Node 24.16.0、Rust 1.99.0（固定工具链）、Visual Studio C++ 桌面开发 / Windows SDK、WebView2 Evergreen。

```powershell
$env:Path = "$env:USERPROFILE\.cargo\bin;$env:Path"
npm ci
npm run browser:prepare
npm run desktop
```

`npm run dev` 只启动 Vite；普通浏览器不具备 Windows 后端，界面不会模拟成功。`scripts/dev.ps1` 可直接启动桌面开发。

## 检查与测试

```powershell
npm run build
npm test
npm run format:check
npm run browser:install # 仅运行配套 Chromium 自动化测试需要；打包不需要下载浏览器
npm run test:browser-login
npm run test:native:recorder # 先构建 debug 桌面程序、退出已有 StartFlow；仅使用合成账号
cargo fmt --manifest-path src-tauri/Cargo.toml -- --check
cargo test --locked --manifest-path src-tauri/Cargo.toml
cargo clippy --locked --manifest-path src-tauri/Cargo.toml --all-targets -- -D warnings
```

原生测试使用真实 Windows / WebView2 和隔离临时库，顺序运行；先关闭其他 StartFlow 实例。V1 原生回归会临时注册测试自启，结束后清除。实际按键、显示器插拔、系统登录 / 睡眠等需目标桌面测试。

```powershell
cargo build --locked --manifest-path src-tauri/Cargo.toml --example launch_probe
# 必须在普通 Cargo 检查之后重建内嵌前端的桌面调试程序
npm run build:native-test
npm run test:native:login-workflow # 第五阶段，真实完整工作流与隔离测试应用
npm run test:native:desktop-login # 第四阶段回归，临时 Win32 应用与合成凭据
npm run test:native:web-login
npm run test:native:credentials
# 下列是旧版本功能验收脚本，历史结果见各版本报告
npm run test:native:v3
npm run test:native
npm run test:native:v2
npm run test:ui:v2
```

V3 迁移样本 `src-tauri/tests/fixtures/v2-populated.sql` 来自实际 V2 隔离测试程序生成的非空数据库，不读取用户生产数据。V2 回归需要旧 V1 调试程序，重建步骤见 [旧升级说明](docs/UPGRADE-V2.md)。只有调试版接受 `STARTFLOW_TEST_DATA_DIR`；发行版忽略该变量。测试协议端口由测试环境显式启用，不默认开放。

本环境按键注入未被 Windows 派发，完整快捷键回归保留失败证据。可显式设置 `$env:STARTFLOW_TEST_SKIP_INPUT='1'` 继续其余 V2 回归；此时报告为 **partial**，不会把实际按键触发记成通过。移除该变量后可重新执行完整测试。

## Windows 构建

```powershell
npm ci
npm run browser:install
npm run browser:prepare
npm run bundle
# 或包含检查、测试和显式 x64 目标
./scripts/build.ps1
```

默认生成 `src-tauri/target/release/startflow.exe` 和 `src-tauri/target/release/bundle/nsis/StartFlow_3.1.0_x64-setup.exe`。显式 `--target x86_64-pc-windows-msvc` 时位于相应 target 子目录。打包只带 Node 24.16.0 / Playwright 1.64.0 及受控脚本，不包含浏览器本体；终端用户无需安装 Node。不能只复制 EXE；必须保留完整运行时资源。测试配套 Chromium 使用 `.test-runtime/`，不进入安装包。各阶段实际产物以对应阶段报告为准，第一阶段交付文件保留。

`.github/workflows/windows.yml` 使用固定 Node / Rust、锁文件及 Windows runner，执行单元测试和构建，上传 x64 NSIS。CI 不冒充实际 Windows 桌面交互验收。`npm run test:upgrade` 检查现有 V2 / V3 安装的真实原位升级或重新安装与配置保留，不创建或删除用户业务数据。

安装包未配置代码签名，在线自动更新未启用。缺少 WebView2 时安装程序提供微软运行时安装引导。卸载默认保留数据，删除应用数据需用户主动选择。

## 数据、安全与验证范围

当前用户数据通常在 `%APPDATA%\com.startflow.desktop`，以设置显示的实际目录为准。数据库 `startflow.sqlite3`；备份 `backups/`；图片副本 `backgrounds/`；专用登录会话 `browser-profiles/<账号 UUID>`（专用 Chromium）、`browser-profiles/edge/<账号 UUID>` 或 `browser-profiles/chrome/<账号 UUID>`；按需浏览器缓存 `browser-cache/`。不同浏览器类型不共用会话资料，切换后可能需要重新登录；旧目录保留。数据库版本 7、外层导出 Schema 4（登录元数据可备份，密码、会话和本机授权不进入此格式）；旧 Config / Workflow 与新增 Automation Schema 均各自版本 1。

升级前创建一致性 SQLite 备份，迁移事务回滚，未知 / 未来版本拒绝打开，不清空重建用户数据库。所有旧表保留。跨设备导入后，程序路径需要用户检查，DPAPI 信任网络需要重新配置，API Key 必须重新录入。

SSID 只在用户授权后读取当前连接，不扫描附近网络，不采集密码、MAC / BSSID。信任 SSID 用用户作用域 DPAPI 保护，历史仅存信任网络 UUID；API Key 不进入 SQLite、导出包或日志。云端 AI 只在用户配置和确认发送预览后调用，不发送默认运行日志、文件内容或全量应用清单。

没有任意脚本节点、AI 系统执行工具、管理员服务、屏幕 / 键盘监控或遥测。AI 输出与导入文件均按不可信数据校验。窗口恢复可能受第三方窗口限制及正常 Windows 权限限制。

[升级和回退](docs/UPGRADE-V3.md) · [架构](docs/V3-ARCHITECTURE.md) · [安全与隐私](docs/V3-SECURITY-PRIVACY.md) · [实际测试结果](docs/V3-TEST-RESULTS.md) · [Windows 验收步骤](docs/V3-WINDOWS-VALIDATION.md) · [已知限制与下一阶段](docs/V3-KNOWN-LIMITATIONS.md)

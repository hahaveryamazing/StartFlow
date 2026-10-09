# StartFlow 3.1.0 · 第一阶段

**StartFlow 智能工作中心 · Intelligent Workspace Automation**

Windows 本地桌面程序，沿用 Tauri 2、React、TypeScript、Rust 和 SQLite。V3 在既有启动场景、可视化工作流、托盘调度和窗口布局上增加真实设备环境感知、规则决策、模拟器与受控 AI 配置草稿。核心功能离线运行，没有云端账号体系、遥测或默认数据上传。

## V3.1 第一阶段：账号与凭据

在原有 V3.0 架构上增量添加网页 / Windows 应用账号管理。同一目标支持多个账号；Rust 通过 Windows Credential Manager 保存、更新、删除和检查密码。SQLite 仅存元数据及 UUID 引用。密码不提供读取 IPC，不进入普通 JSON、浏览器存储、日志或备份。本阶段不开发自动登录。

数据库升级为版本 4，迁移前备份，失败回滚。普通配置导入不会删除账号；普通 JSON 导出不包含账号或凭据。密码属于当前 Windows 用户，跨设备恢复需要重新录入。详见 [阶段交付与测试报告](docs/V3.1-CREDENTIALS.md)。

## 安装与使用

V3.0 稳定安装包保留在 `release/StartFlow_3.0.0_x64-setup.exe`；其 V2 原位升级结果见原有 V3 测试报告。V3.1 第一阶段安装包已实际构建，位于 `release/StartFlow_3.1.0_x64-setup.exe`。构建和验证范围见阶段报告；未执行安装或替换已安装的生产应用。升级自动备份数据库，保留旧场景、任务、工作流、布局、快捷键、主题、调度和日志；不主动开启 Windows 登录自启。

首次升级后智能自动化、Wi-Fi 感知、持续应用检测与 AI 默认关闭。先在系统设置的「隐私与环境感知」中选择需要的能力，再创建规则，用模拟器确认结果。新规则默认禁用且采用请求确认；选择自动执行会要求明确确认。关闭主窗口默认隐藏到托盘，Rust 服务继续运行；彻底退出后不会独立执行计划。

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
npm run desktop
```

`npm run dev` 只启动 Vite；普通浏览器不具备 Windows 后端，界面不会模拟成功。`scripts/dev.ps1` 可直接启动桌面开发。

## 检查与测试

```powershell
npm run build
npm test
npm run format:check
cargo fmt --manifest-path src-tauri/Cargo.toml -- --check
cargo test --locked --manifest-path src-tauri/Cargo.toml
cargo clippy --locked --manifest-path src-tauri/Cargo.toml --all-targets -- -D warnings
```

原生测试使用真实 Windows / WebView2 和隔离临时库，顺序运行；先关闭其他 StartFlow 实例。V1 原生回归会临时注册测试自启，结束后清除。实际按键、显示器插拔、系统登录 / 睡眠等需目标桌面测试。

```powershell
cargo build --locked --manifest-path src-tauri/Cargo.toml --example launch_probe
# 必须在普通 Cargo 检查之后重建内嵌前端的桌面调试程序
npm run tauri -- build --debug --no-bundle
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
npm run bundle
# 或包含检查、测试和显式 x64 目标
./scripts/build.ps1
```

默认生成 `src-tauri/target/release/startflow.exe` 和 `src-tauri/target/release/bundle/nsis/StartFlow_3.1.0_x64-setup.exe`。显式 `--target x86_64-pc-windows-msvc` 时位于相应 target 子目录。本次交付副本在 `release/`。

`.github/workflows/windows.yml` 使用固定 Node / Rust、锁文件及 Windows runner，执行单元测试和构建，上传 x64 NSIS。CI 不冒充实际 Windows 桌面交互验收。`npm run test:upgrade` 检查现有 V2 / V3 安装的真实原位升级或重新安装与配置保留，不创建或删除用户业务数据。

安装包未配置代码签名，在线自动更新未启用。缺少 WebView2 时安装程序提供微软运行时安装引导。卸载默认保留数据，删除应用数据需用户主动选择。

## 数据、安全与验证范围

当前用户数据通常在 `%APPDATA%\com.startflow.desktop`，以设置显示的实际目录为准。数据库 `startflow.sqlite3`；备份 `backups/`；图片副本 `backgrounds/`。数据库版本 4、外层导出 Schema 3（账号不进入此格式）；旧 Config / Workflow 与新增 Automation Schema 均各自版本 1。

升级前创建一致性 SQLite 备份，迁移事务回滚，未知 / 未来版本拒绝打开，不清空重建用户数据库。所有旧表保留。跨设备导入后，程序路径需要用户检查，DPAPI 信任网络需要重新配置，API Key 必须重新录入。

SSID 只在用户授权后读取当前连接，不扫描附近网络，不采集密码、MAC / BSSID。信任 SSID 用用户作用域 DPAPI 保护，历史仅存信任网络 UUID；API Key 不进入 SQLite、导出包或日志。云端 AI 只在用户配置和确认发送预览后调用，不发送默认运行日志、文件内容或全量应用清单。

没有任意脚本节点、AI 系统执行工具、管理员服务、屏幕 / 键盘监控或遥测。AI 输出与导入文件均按不可信数据校验。窗口恢复可能受第三方窗口限制及正常 Windows 权限限制。

[升级和回退](docs/UPGRADE-V3.md) · [架构](docs/V3-ARCHITECTURE.md) · [安全与隐私](docs/V3-SECURITY-PRIVACY.md) · [实际测试结果](docs/V3-TEST-RESULTS.md) · [Windows 验收步骤](docs/V3-WINDOWS-VALIDATION.md) · [已知限制与下一阶段](docs/V3-KNOWN-LIMITATIONS.md)

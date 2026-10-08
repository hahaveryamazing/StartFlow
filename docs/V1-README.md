# StartFlow 1.0.0

**Windows 智能工作启动中心** — Your Workspace, Ready in Seconds.

StartFlow 是实际运行的 Tauri 2 桌面应用。网页、EXE、LNK 和文件夹由 Rust 调用 Windows 系统能力打开；调度在后台 Rust 进程中运行；配置、关系、执行记录和日期去重保存到当前用户的 SQLite 数据库。没有 Electron、Python 核心运行时、云服务、账号或遥测。

## 已实现

- **工作台**：真实场景 / 任务数量、今日自动次数、最近结果、常用场景一键运行、今日计划、任务级最近记录及详情。
- **启动场景**：创建、编辑、删除、复制、启停、八种图标、任意强调色、任务复用、鼠标和键盘排序、运行状态与上次启动时间。实体与关联均使用 UUID。
- **任务管理**：网页 / 程序 / 文件夹筛选、搜索、编辑、启停、删除、所属场景、单独测试。系统文件选择器支持 EXE、LNK 和文件夹；程序路径、参数数组、工作目录分开存储。
- **Windows 启动**：默认浏览器使用 ShellExecuteW；指定浏览器和 EXE 使用 CreateProcess 对应的 Rust Command；LNK 和文件夹使用系统关联。中文、空格和参数引号不拼接成 shell 命令。
- **执行引擎**：稳定顺序、0～60 秒任务延迟、网络接口等待 30 秒超时、完整 EXE 路径进程检测、失败隔离、同场景防重入，pending / running / launch_requested / skipped / failed 和场景 partial 汇总。
- **计划调度**：登录、每日和选定星期规则；0～120 秒登录延迟；关闭 / 30 / 120 分钟补执行；墙上时间重新判断；睡眠恢复后的窗口检查；本地自然日和规则发生日期的事务去重。主窗口隐藏时继续调度。
- **系统集成**：官方登录自启插件及实际状态查询、单实例、真实托盘菜单、最近场景、默认场景、自动任务暂停 / 恢复、隐藏 / 退出关闭行为和 Windows 通知。
- **运行日志**：场景 / 任务名称快照、触发方式、开始 / 结束、耗时、错误中文提示；日期、场景和结果筛选；后台分页查询与全部匹配记录统计；清空日志不会清除自动去重记录。
- **设置**：深色 / 浅色 / 跟随系统、主题强调色、动画、默认场景、通知、登录显示主窗口、关闭行为、暂停自动任务；JSON 导出、导入预检、覆盖确认与事务应用；数据目录打开。
- **首次引导**：欢迎、创建场景、添加任务、选择启动方式、进入工作台；可跳过。首次安装不自动开启 Windows 自启。
- **工程交付**：严格 TypeScript、Zod + React Hook Form、Zustand、Radix / shadcn 风格持有源码组件、Tailwind 4、Lucide、Motion、dnd-kit；Rust 模块分离；NSIS 当前用户安装；锁文件及 Windows CI。

## 行为说明

“请求已提交”只表示 Windows 接受了启动请求，不能证明第三方应用已经完全就绪。StartFlow 不检测第三方浏览器的现有标签页。

登录自启指 **Windows 用户登录后** 启动，不是在未登录的系统会话中运行。`--autostart` 区分登录启动与手动启动。初始化后新增的登录规则等待下次登录，不会将创建规则当作新的登录事件。

同一场景最多自动执行一次 / 实际执行的本地自然日。跨午夜补执行对应前一天的计划，同时消耗今天的额度；手动启动不受日期限制，但不能与同场景正在执行的实例重入。

彻底退出后没有独立服务或 Windows Task Scheduler 任务，定时执行会暂停。再次启动后，按补执行窗口和去重记录判断。隐藏到托盘则继续运行。

JSON 导入不会直接运行内容，导入后自动任务强制暂停，需主动恢复。Windows 自启注册不随 JSON 导入或导出。启用过去时间的计划或恢复自动任务，可能在补执行窗口内立即提交任务。

已运行检测不降级为进程名称比较；权限受限的进程可能无法读取完整路径，LNK 不检测其目标进程。网络等待检查可用的非回环网络接口，不保证互联网或目标网站可达。

## 开发与运行

环境：Windows 10/11 x64、Node.js 24.16.0、Rust 1.99.0、Visual Studio 2022 或更新版本的“使用 C++ 的桌面开发”及 Windows SDK、Microsoft Edge WebView2 Evergreen Runtime。

```powershell
$env:Path = "$env:USERPROFILE\.cargo\bin;$env:Path"
npm ci
npm run desktop
```

也可运行 `./scripts/dev.ps1`。`npm run desktop` 启动真正的桌面程序。`npm run dev` 仅启动前端服务器，浏览器中会明确提示无法访问本地桌面服务，不提供伪造的业务数据。

## 检查与测试

```powershell
npm run build
npm test
npm run format:check
cargo fmt --manifest-path src-tauri/Cargo.toml -- --check
cargo test --locked --manifest-path src-tauri/Cargo.toml
cargo clippy --locked --manifest-path src-tauri/Cargo.toml --all-targets -- -D warnings
```

真实 Windows 集成测试使用本地 WebView2 调试连接、实际 Tauri IPC、实际 SQLite、受控原生 EXE 回执和 Win32 窗口检查。不是后端调用模拟。

```powershell
npm run tauri -- build --debug --no-bundle
cargo build --locked --manifest-path src-tauri/Cargo.toml --example launch_probe
npm run test:native
```

运行集成测试前关闭其它 StartFlow 实例。脚本会打开必应、参考网页和测试文件夹，临时启用并关闭测试程序的登录自启，使用临时数据库，最后退出测试进程。报告和实际界面截图在 `test-results/`；测试 EXE 示例不进入安装包。调试版本才接受 `STARTFLOW_TEST_DATA_DIR`；发行版本忽略此变量。WebView2 9223 调试端口仅测试脚本通过环境参数设置，发行程序不会主动开启端口。

自动化结果与尚待人工验收项目见 [测试说明](docs/TESTING.md) 和 [实际测试结果](docs/TEST-RESULTS.md)。

`node scripts/installer-smoke.mjs` 用于干净机器的安装冒烟测试，若已存在安装则拒绝覆盖。它会安装、运行、卸载、重新安装真实发行程序，读取空的生产配置并验证默认保留数据，最后保留安装。普通开发不必运行此脚本。

## Windows 安装包

```powershell
npm ci
npm run bundle
```

当前平台构建路径：

```text
src-tauri/target/release/bundle/nsis/StartFlow_1.0.0_x64-setup.exe
```

显式指定目标：

```powershell
npm run bundle -- --target x86_64-pc-windows-msvc
```

对应路径为 `src-tauri/target/x86_64-pc-windows-msvc/release/bundle/nsis/`。`./scripts/build.ps1` 安装锁定依赖、运行测试并生成 x64 NSIS 包。GitHub Actions 工作流位于 `.github/workflows/windows.yml`，产物作为构建附件上传。

NSIS 采用当前用户安装，无需应用自身申请管理员权限。首次安装机器需有 WebView2；缺少时安装包提供微软运行时下载引导。已安装运行时后，StartFlow 核心离线可用。发行包尚未配置代码签名证书。

卸载默认保留用户数据；卸载界面有明确的“删除应用数据”选项，只有主动勾选才删除数据。卸载会清理 StartFlow 的登录自启注册。

## 本地数据

数据库文件为 `startflow.sqlite3`，位于 Tauri 当前用户 `app_data_dir` 下的 `com.startflow.desktop` 目录，在设置页面可查看准确路径并打开。不会写入安装目录。运行中的数据库采用 WAL；常规备份配置请使用 JSON 导出，完整备份数据库应先退出程序后复制数据目录。

schema 版本记录在 `migrations`。三个配置实体表将常用索引字段单列，其他经过类型验证的字段保存为 JSON payload；关系、执行、日志、设置和自动去重表独立存储。说明见 [工程架构](docs/ARCHITECTURE.md)。

## V1.1 / V2.0

V1.1 可增加签名发布、日志归档与保留策略、任务取消、场景排序、更多图标、无需打开主窗口的执行进度面板。

V2.0 可考虑 Windows Task Scheduler 独立注册、复杂条件规则和窗口布局恢复。AI、云同步、账号、自动登录网站和任意脚本执行均未纳入本版。

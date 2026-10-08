# StartFlow 1.0.0 实际交付验证

验证日期：2026-10-08，Asia/Shanghai。环境：Windows 11 x64（10.0.26300），Node.js 24.16.0，npm 11.13.0，Rust 1.99.0，MSVC / Windows SDK，WebView2 154.0.4258.62。

## 执行结果

| 命令 / 检查 | 真实结果 |
|---|---|
| `npm run build` | 通过；严格 TypeScript 检查与 Vite 生产构建 |
| `npm test` | 8 / 8 通过；场景创建、编辑、运行、禁用、错误反馈及任务输入 |
| `npm run format:check` | 通过 |
| `cargo fmt --manifest-path src-tauri/Cargo.toml --check` | 通过 |
| `cargo test --locked --manifest-path src-tauri/Cargo.toml` | 17 / 17 通过 |
| `cargo clippy --locked --manifest-path src-tauri/Cargo.toml --all-targets -- -D warnings` | 通过，无警告 |
| `npm run tauri -- build --debug --no-bundle` | 通过，真实 Windows 调试 EXE |
| `node scripts/native-smoke.mjs` | 26 / 26 通过，真实 WebView2、Rust IPC、Windows API 和 SQLite |
| `npm run bundle` | 通过，真实 Windows x64 发行 EXE 和 NSIS 安装包 |
| `node scripts/installer-smoke.mjs` | 4 / 4 通过，安装 / 发行运行 / 保留数据卸载 / 重新安装 |

前端用例使用测试环境中的接口替身验证交互；原生测试另行使用实际后端，没有将替身结果当作 Windows 集成结果。

Rust 测试覆盖 URL 与路径安全、未知字段、设置约束、Windows 参数引用、真实全路径进程检测、补执行窗口、指定星期、跨日期、夏令时缺失 / 重叠时间、亚秒提前触发回归、SQLite 初始化、无效导入、日期持久化去重和事务回滚。

原生测试验证真实 EXE 在中文空格路径下收到准确参数数组及工作目录；LNK 的目标确实写入回执；两网页和 EXE 依序提交，错误程序未阻止后续任务；同路径运行程序被跳过；正在执行的场景拒绝重入。默认浏览器及文件夹自动化结果表示系统接受了请求，目标窗口内容尚待人工观察。

真实 WM_CLOSE 隐藏主窗口后，未来时间的规则由 Rust 到点执行并持久化。重复启动恢复同一窗口，第二进程退出。自动规则当日去重、手动运行不受日期限制、重启后主题 / 关系 / 历史保留、清空日志后去重保留均通过。

登录自启写入、查询、关闭的 Windows 注册机制已实际测试。使用 `--autostart` 启动真实进程，验证隐藏窗口及延迟；新增登录规则不会制造新的登录事件。这仍不是实际退出 Windows 再重新登录的验证。

## 安装检查

检查前不存在 StartFlow 安装。静默安装至 `%LOCALAPPDATA%\StartFlow\StartFlow.exe`，发行程序显示首次引导，配置为空、深色主题、登录自启关闭。生产数据目录为 `%APPDATA%\com.startflow.desktop`。

正常退出后静默卸载，安装 EXE 被移除，数据库保留且 SHA256 完全一致。再次安装后配置和数据位置一致。机器现保留安装程序；未加入测试场景、任务或调度。

静默测试未验证安装 / 卸载的每个可视化界面步骤、明确勾选删除数据选项或 Windows 安全软件提示。默认数据保留逻辑同时检查了实际生成的 NSIS 脚本。

## 产物与证据

- 原始安装包：`src-tauri/target/release/bundle/nsis/StartFlow_1.0.0_x64-setup.exe`。
- 交付副本：`release/StartFlow_1.0.0_x64-setup.exe`。
- SHA256：`6AC5401039A20D3CD78F00A43F08CA00BAA164A49E3DB9B99933CACA3A860EF4`。
- 原生检查逐项证据：[native-test-results.json](native-test-results.json)。
- 安装检查逐项证据：[installer-test-results.json](installer-test-results.json)。
- 实际界面截图位于 `docs/screenshots/`；工作台截图使用隔离测试数据库，安装首次引导截图使用空的生产数据库。
- GitHub Actions Windows 构建流程已配置，本次没有触发远端运行。

## 尚待人工验证及已知限制

以下项目没有标记通过：真实 Windows 重新登录、真实睡眠恢复、修改系统时区、托盘鼠标点击全部菜单、原生文件选择器交互、Windows 通知显示、目标浏览器 / 资源管理器窗口内容、安装可视化流程。操作步骤在 [TESTING.md](TESTING.md)。

WebView2 调试连接退出时曾输出 Chromium 注销窗口类 Error 1412 诊断；程序退出、重启和持久化检查均通过。未将该调试日志当作功能通过或失败的依据。

没有配置代码签名证书。计划依赖 StartFlow 后台进程；完全退出后不继续执行。网络接口存在不保证目标网站可达，提交启动请求不等于目标软件就绪。权限受限进程的全路径可能不可读取，LNK 目标不做已运行检测。上述行为见 README，未宣称超出本版实现能力。

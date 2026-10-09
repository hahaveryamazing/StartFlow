# V3 实际测试与构建结果

日期：2026-10-08。环境：Windows 11 x64 10.0.26300、Asia/Shanghai、Node 24.16.0、Rust 1.99.0、MSVC / Windows SDK、WebView2 154。实际执行命令与结果如下；没有将历史 V2 测试或 Mock 结果冒充 V3 实机通过。

## 自动化检查

| 命令 | 实际结果 |
|---|---|
| `npm run build` | 严格 TypeScript 与 Vite 构建通过 |
| `npm test` | 17 项通过，3 个文件；场景编辑 / 运行、工作流验证、V3 安全默认值、条件编辑、模拟器调用和模板禁用草稿 |
| `npm run format:check` | 通过 |
| `cargo fmt --manifest-path src-tauri/Cargo.toml -- --check` | 通过 |
| `cargo test --locked --manifest-path src-tauri/Cargo.toml` | 50 项单元测试 + 4 项集成测试，共 54 项通过 |
| `cargo clippy --locked --manifest-path src-tauri/Cargo.toml --all-targets -- -D warnings` | 通过，无警告 |
| `npm run tauri -- build --debug --no-bundle` | 实际 Windows 桌面调试程序构建通过 |
| `npm run bundle` | 实际 Release x64 NSIS 构建通过 |

Rust 覆盖：四值条件、权限 unknown、跨午夜、可注入时钟、冷却、稳定性、防抖、互斥和优先级、运行中场景、禁用目标、覆盖到期 / 暂停、持久化事件声明及历史清理、原规则历史回放、同引擎 Dry Run、真实 V2 全表迁移 / 备份一致性、迁移异常回滚、未来库保护、AI Schema / Provider / 地址约束，以及 V1 / V2 原有启动、调度、图验证、取消、参数和备份测试。

最后审查修复纯定时规则的两个边界：环境重新评估不得绕过计划时间 / 补执行窗口；初始化尚未稳定或处于暂停时不提前领取计划。新增固定时钟测试及原生定时触发测试。

## 原生与界面测试

| 命令 / 报告 | 结果和范围 |
|---|---|
| `npm run test:native` / [V1 回归](v3-v1-regression-results.json) | 26 项通过：真实默认浏览器请求、EXE 回执 / 中文空格 / 参数、LNK、文件夹、顺序 / 失败隔离、进程路径、Windows 自启注册查询、单实例、日志 / 导入、托盘隐藏后到点执行、模拟登录参数、重启与日期去重 |
| `npm run test:native:v2` / [完整测试失败记录](v3-hotkey-input-failure.json) | 已验证前 12 项，实际 Windows 注入热键未触发，保留 Timeout 失败，不记通过 |
| `$env:STARTFLOW_TEST_SKIP_INPUT='1'; npm run test:native:v2` / [V2 回归](v3-v2-regression-results.json) | **partial**：18 项通过、1 项未验证。其余真实工作流 / 条件分支 / 取消 / 隐藏后台 / 两窗口位置恢复 / 缺失屏回退 / 快捷键注册冲突回滚 / 命令面板 / 主题 / 备份与中断恢复通过；未验证项为实际热键按键触发 |
| `npm run test:ui:v2` / [V2 界面](v3-v2-ui-results.json) | 6 项通过：编辑器保存 / 未保存提示、正式执行模式确认、外观、快捷键录制和真实注册、备份替换二次确认、旧八入口布局 |
| `npm run test:native:v3` / [V3 原生](v3-native-results.json) | 17 项通过：非空 V2 真库升级、真实 Provider、unknown / Dry Run、确认一次、EXE 和自然日去重、Rust 定时实际执行、受控崩溃恢复、暂停、模式覆盖、DPAPI / WLAN、选定路径进程运行 / 停止、AI 协议 / 凭据 / 安全 Schema、完整备份、重启、V3 页面和短时采样 |
| `npm run test:upgrade` / [首次升级](v3-installer-results.json) | 3 项通过：真实 V2 NSIS 原位升级、生产配置 / 历史 / 自启 / V2 扩展保留、安装发行版重启 |
| 再次 `npm run test:upgrade` / [最终发行版安装](v3-release-reinstall-results.json) | 最终 V3 安装包实际安装和重启，配置保持一致 |

所有原生业务测试使用隔离库和受控 EXE，AI 协议服务明确是测试服务，不是真实模型。V2 模板布局在两个真实 WinForms 窗口上移动 / 恢复后读取坐标；“缺失显示器”用不存在标识验证回退，不能替代物理拔屏。

V3 非空样本含 1 个旧场景、5 个任务、1 个计划、1 个工作流、1 个布局、2 个快捷键、12 次运行；与真实 V2 程序输出固化样本一致。迁移前副本保留版本 2，V3 外键检查无异常。

独立 Win32 `RegisterHotKey` 可以注册但同宿主 `keybd_event` 不产生热键消息；当前 WTS 会话实际采样为 locked。因此实际按键触发仍待解锁桌面物理交互验证。UI Enter 搜索执行通过不等于全局热键通过。

## 安装产物

真正生成并复制到 `release/`：

- `StartFlow_3.0.0_x64-setup.exe`：NSIS 当前用户安装程序，文件版本 3.0.0。
- `StartFlow_3.0.0.exe`：Windows x64 Release 主程序，文件版本 3.0.0。

最终 SHA-256、字节数与当前源代码分支保存在 [发行产物清单](../release/StartFlow_3.0.0-manifest.json)。原始构建目录是 `src-tauri/target/release/bundle/nsis/` 和 `src-tauri/target/release/`；GitHub Actions 配置可复现 x64 构建。本机真实运行发行版，不声称已代码签名。

## 未验证与限制

真实重新登录、Wi-Fi 切换 / 系统权限拒绝、物理多屏 / 混合缩放、电源切换、系统锁定 / 解锁、睡眠恢复、全局物理按键、长时间整组进程性能、真实 LLM 仍待验证。具体步骤见 [Windows 验收](V3-WINDOWS-VALIDATION.md)。十秒 CPU / Working Set 仅对应 Rust 主进程，不含 WebView2，不是长期性能达标声明。

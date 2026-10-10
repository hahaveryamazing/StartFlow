# 外观改色修复

日期：2026-10-10。

用户反馈：点击原有系统颜色选择器没有反应。当前环境的电脑操作工具无法初始化，没有独立确认该原生选择器的底层失效原因。

## 修改

- 强调色改为应用内颜色面板，通过普通 HTML 控件打开，不依赖 WebView2 的原生 `input[type=color]` 弹窗。提供常用色块、红绿蓝滑杆、颜色代码输入和预览；非法代码不进入样式或配置。
- 设置页编辑时即时预览。离开设置页即清除未保存预览，正式颜色来自 SQLite。
- 原先上方强调色由“保存设置”保存，下方预设由“保存外观设置”保存，容易出现提示成功但颜色没保存。现在两个入口使用同一份草稿与同一条 IPC 命令，事务保存常规设置与主题。
- 选择预设时同步其强调色和深浅模式，也允许随后自定义强调色。
- 新保存路径只更新 `settings` 的 general / v2 行，不重写工作流、登录授权或快捷键，不需要数据库迁移。备份频率及保留数由备份页面管理，不被外观草稿覆盖。
- `save_settings` 的主题参数为可选值，保留现有调用兼容性。托盘和快捷键仍使用原有常规设置调用。
- 关于页版本显示从历史的 2.0.0 修正为当前 3.1.0。

## 实际测试

- `npm test`：9 个文件，48 项通过，包括颜色面板、预览、两个保存入口、预设、非法颜色、RGB 和保存失败反馈。
- `cargo test --locked --manifest-path src-tauri/Cargo.toml`：100 项通过，包括新增 3 项偏好保存测试：V3 配置保留、事务失败回滚、旧接口兼容、主题与颜色校验、备份偏好保留。
- `cargo clippy --locked --manifest-path src-tauri/Cargo.toml --all-targets -- -D warnings`：通过。
- `npm run build:native-test`：Windows Debug 构建通过。
- `npm run test:native:appearance`：9 项实际 Tauri WebView2 检查通过：面板打开；色块预览且不隐式保存；RGB 滑杆；合法/非法代码；底部保存；预设与顶部保存；浅色自定义色；离开页面保留已保存颜色且旧配置未变化；重启从 SQLite 恢复。

原生检查使用 CDP 点击和按键、隔离的合成数据库，不执行用户任务。它验证实际 WebView2 页面及 Rust IPC，但不等同于物理鼠标输入验收。详细记录见 [appearance-native-results.json](appearance-native-results.json)，界面截图见 [appearance-color-panel.png](appearance-color-panel.png)。

## 安装

Windows x64 NSIS 构建成功，产物 `release/StartFlow_3.1.0_appearance-fix_x64-setup.exe`，31,065,935 字节。用户退出后原位安装，退出码 0；验证安装 EXE 包含当前主脚本、样式和设置页资源标识，随后打开安装后的应用。新颜色面板尚未另行取得用户物理鼠标验收反馈。

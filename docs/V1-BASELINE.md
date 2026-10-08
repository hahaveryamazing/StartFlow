# V2 升级前基线与兼容方案

检查日期：2026-10-08。现有项目为实际 Tauri 2 / React / Rust 桌面程序，不重建项目。

| V1 功能 | 代码证据 | 状态 |
|---|---|---|
| 登录自启、手动 / 登录区别 | lib.rs、commands.rs、autostart 插件 | 已实现；系统注册和参数启动有原生测试，真实重新登录待人工 |
| 网页、EXE、LNK、文件夹 | launcher.rs | 已实现；参数、路径、LNK 回执有原生测试 |
| 场景及排序、任务复用 | SceneEditor.tsx、scene_tasks | 已实现；键盘排序与稳定任务 ID 有测试 |
| 每日 / 每周、补执行、去重 | scheduler.rs、automatic_claims、rule_history | 已实现；隐藏主窗口后到点触发有测试 |
| 托盘、单实例 | tray.rs、single-instance 插件 | 已实现；隐藏与第二实例有测试，鼠标菜单待人工 |
| SQLite、日志、主题 | database.rs、Settings.tsx、App.tsx | 已实现，重启持久化有测试 |
| JSON 导入导出 | commands.rs、Settings.tsx | 已实现，仅替换导入，V2 扩展合并和预览 |

旧测试证据保留于 TEST-RESULTS.md 与 native-test-results.json，属于 V1 验证，不自动当作 V2 回归结果。

## 稳定版本

原工作目录无 Git 提交且所有源码未跟踪。已保留完整现状为基线提交，标签 `startflow-v1.0-baseline`；升级分支 `codex/startflow-v2`。未删除旧安装包。

## 数据升级设计

保留 V1 Config、实体 JSON 和原表。新增工作流、节点、边、场景运行模式、窗口布局、快捷键、V2 外观 / 备份设置、个人模板、备份记录、节点执行日志和工作流执行关联表。

既有数据库升级前采用 SQLite 一致性备份，包含 WAL 已提交内容。DDL 在事务内执行，失败回滚并返回错误；不创建空库替换。未知未来版本拒绝打开。新数据库不需要旧库备份。

V1 的整表删除保存方式改为按 ID UPSERT，删除真正消失的实体，保证未变场景和扩展外键关系保留。原配置 JSON 版本仍为 1；V2 导出封装使用独立 schema_version=2。旧 JSON 导入可转换，系统自启注册仍独立于配置文件。

执行入口继续统一到 engine::submit_scene；V2 根据显式场景绑定选择简单列表或验证后的工作流。两种模式共享 Windows Task Launcher、互斥和自然日去重。迁移不自动激活高级模式，不自动运行导入内容。

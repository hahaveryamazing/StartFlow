# V1 → V2 升级与回退

稳定基线标签 `startflow-v1.0-baseline`，升级分支 `codex/startflow-v2`。原项目无提交，已先完整保存原源码与旧安装程序，再增量开发。

正常升级：结束正在执行的任务，退出 V1，安装 V2。相同用户、安装路径、`com.startflow.desktop` 标识和数据目录继续使用。首次 V2 打开 schema 1 时，SQLite backup API 保存 `backups/upgrade-UUID.sqlite3`，包含 WAL 已提交内容；DDL、外键检查和迁移版本记录处于事务。备份或迁移失败停止打开、回滚，不覆盖为空库。未来版本和无法识别的数据库拒绝打开。

原场景、任务、顺序、规则、日志、主题和系统自启注册保留；迁移不激活高级模式。V1 整表删除保存改为按 ID UPSERT，普通编辑不会级联删除工作流。仍被工作流或模板引用的任务无法直接删除，必须先修改引用。

## JSON 与运行模式

旧 `version:1` JSON 直接兼容。V2 包为 `application:StartFlow`、`schema_version:2`、`exported_at`、`config`（完整旧 Config）、`extension`（workflows / bindings / layouts / shortcuts / theme / templates）、`assets`。工作流自身 `schema_version:1` 与导出 / 数据库版本分开管理。

合并为导入实体分配新 UUID 并重映射关系，不替换名称或路径中的任意文本。保留当前主题与原有快捷键，重复导入组合略过，其余导入组合停用。完整替换要求两次确认，全部快捷键停用。两种方式均有恢复前备份、事务引用校验、自动任务暂停；历史、日期去重和 Windows 自启注册不替换。请检查本机路径再主动启用执行。

转换简单列表创建独立已保存草稿，保留旧列表。启用高级模式需确认；恢复简单模式使用原列表，条件图不扁平化。异常退出标记 interrupted，不恢复中间节点。

常规 JSON 不含执行历史；升级 SQLite 副本含完整历史。应用内恢复升级备份仅恢复配置，当前历史保留。

## 离线完整回退

V1 不能直接读取已经升级到 V2 的数据库。

1. 退出所有 StartFlow，将当前完整数据目录复制到另一安全目录，包含数据库、WAL、SHM、背景和备份。
2. 安装旧 `release/StartFlow_1.0.0_x64-setup.exe`，暂不启动。
3. 确认数据目录绝对路径，将当前数据库与对应 `-wal` / `-shm` 移到已确认的安全副本目录，避免旧 WAL 重放；不要删除唯一副本。
4. 将所选升级前 SQLite 副本复制为 `startflow.sqlite3`，启动 V1 检查。V2 才创建的工作流仍保存在另存的 V2 数据副本中。

软件不会自动跨版本降级或未经确认恢复中断流程。

## 重建原生 V1 测试工具

本机的 `release/StartFlow_1.0.0-debug.exe` 是保存的真实基线，不进入 V2 安装包。如需重建，在独立命名目录检出稳定标签：

```powershell
git worktree add --detach ../StartFlow-v1-regression startflow-v1.0-baseline
Set-Location ../StartFlow-v1-regression
npm ci
npm run tauri -- build --debug --no-bundle
```

将该目录 `src-tauri/target/debug/startflow.exe` 复制到升级项目 `release/StartFlow_1.0.0-debug.exe`，返回升级目录，按 README 执行原生测试。单元迁移测试另外保留来自原 V1 源码的 SQL fixture，无需基线二进制。

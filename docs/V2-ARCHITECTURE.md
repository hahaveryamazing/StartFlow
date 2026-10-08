# V2 架构

保留 V1 commands / models / database / launcher / scheduler / tray，增量扩展。

```text
登录 / 定时 / 托盘 / 手动 / 快捷键
            ↓
engine::submit_scene（互斥、有界并发、日期事务）
            ↓
简单列表 / workflow::executor（显式绑定）
            ↓
runtime::task + conditions + window_manager + notification
            ↓
V1 launcher + Windows API
```

## 后端职责

- workflow/models：类型化业务节点与边，编辑器坐标不参与执行；validator：引用、参数、DAG、明确分支、单入边与无环。编辑器另外校验本机路径，导入允许其它机器路径暂不可用，运行时记录错误。
- workflow/executor：顺序推进选中分支，复用旧启动器；真实节点日志、跳过未选分支、失败策略和瞬时 PID。
- runtime：每次执行的 Tokio watch 取消通道，等待以 select 中断，不强制终止第三方进程。engine 保留场景 / 自动日期锁，最多 4 个并发；内部简单场景取得目标场景锁，不调用高级工作流，属于父图节点，不额外制造计划领取事件。
- conditions：true / false / error，全部条件都检查以免掩盖系统错误；本地接口与 HTTPS 服务分开，连接 / 总请求 / 网络等待均有超时。
- window_manager：按操作枚举，路径 / PID / 标题匹配，PMv2 线程 DPI、物理工作区和相对坐标、主屏 / 跳过 / 一层备用布局；异步 SetWindowPos 后读取实际位置。窗口查找有截止时间，每次位置核验另限 2 秒，不持续全局轮询。
- shortcuts：官方插件集中注册、标准化去重、失败恢复旧注册、启动错误记录。回调转入工作线程，避免 Windows 事件线程等待数据库 / 注册；配置删除注销组合。
- backups：升级一致性副本、版本化 JSON、结构化 UUID 重映射、管理路径限制、安全图片解码、后台按每日 / 每周备份并保留指定自动份数。
- v2/repository：独立节点 / 边、布局规则、快捷键、模板、主题；调用方事务保存。一般快照只含最近 50 次工作流的节点和活跃节点，历史按 run_id 查询，命令面板只读取必要偏好。
- v2/commands：类型化 IPC、扩展修改串行门、实际注册后保存；数据库失败恢复快捷键。导入先备份再单事务写 V1 与 V2，并校验外键。

execution_runs 继续使用原表。workflow_runs 保存名称 / ID 快照，workflow_execution_logs 保存节点快照、时间、状态、结果和错误；删除配置不会删除历史。退出后未完成日志转为 interrupted / skipped，不从中间节点恢复。

## 数据与前端

保留 V1 Config version 1，数据库迁移到 2。新增 workflows、workflow_nodes、workflow_edges、scene_workflows、window_layouts、window_layout_items、shortcuts、workflow_templates、backup_records、workflow_runs、workflow_execution_logs。外键与索引保护稳定引用，payload 为经过 Schema 验证的字段；迁移备份包括 WAL，失败不前进版本。

前端新增 workflows、workflow-editor（独立 Zustand 撤销栈）、window-layouts、shortcuts、command-palette、themes、backups。React Flow 与页面按需加载；CSS tokens 切换不重建画布；隐藏后停止快照更新，重开同步真实结果；监听器释放。命令面板独立窗口共用既有 Rust 数据库和调度器。

权限仅本地 main / palette，远程内容不载入。图像限制类型、大小和像素，禁止 SVG 活动内容。无任意 shell、管理员服务、UAC 绕过或远程上传。

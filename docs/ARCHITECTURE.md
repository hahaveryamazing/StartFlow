# StartFlow V1.0 架构

React 通过 `services/api.ts` 调用类型明确的 Tauri commands。核心数据从 Rust 的 SQLite 快照读取，不使用 LocalStorage，也没有浏览器演示数据。

Rust 模块：`models` 负责格式和安全边界校验；`database` 负责 schema、事务与持久化；`commands` 负责用户操作；`launcher` 负责 Windows 系统接口；`engine` 负责按序执行与状态；`scheduler` 每秒依据当前本地时间判断规则；`tray` 管理托盘、恢复窗口与退出。

## 存储与迁移

数据库位于 Tauri `app_data_dir`，标识符为 `com.startflow.desktop`。使用 SQLite WAL、foreign_keys、5 秒 busy timeout、FULL synchronous。版本 1 迁移记录在 `migrations` 表。

scenes、tasks、schedules 将常用索引字段独立存储，其余类型明确的字段保存在经验证的 JSON payload 中。scene_tasks 独立关系表使用 UUID 与唯一 `(scene_id,task_id)`，删除配置通过事务维护外键。任务只能在同一场景中关联一次；不同任务可以配置相同 URL。execution_runs 与 execution_logs 使用独立快照，删除场景或任务不影响历史。配置写入在互斥锁中序列化，并在完整校验后使用单一事务替换配置关系。

automatic_claims 使用 `(scene_id,local_date)` 主键，日期采用实际开始执行的本地自然日；rule_history 使用 `(rule_id,local_date)` 主键，日期采用计划应发生的本地自然日。跨午夜补执行仍对应前一天的计划，但消耗今天的自动执行额度；同一计划不会跨日期重复补执行，如果场景在计划原日期已自动执行也不再补执行。领取去重记录、写入执行记录和待执行日志位于同一事务，提交后才派发任务。清空日志、删除规则及导入不清除去重记录。

## 调度语义

后台每秒检查当前墙上时间，不依赖前端的计时器。睡眠恢复、时间修改和再次启动后重新检查今天及昨天的应执行时刻。补执行限 0、30、120 分钟；关闭补执行时仅计划所在分钟有效。不存在的夏令时时刻跳过，重复时刻取第一次，并经日期唯一约束去重。并发场景可以独立运行，同场景互斥。

`--autostart` 由官方自启插件注册，仅该启动方式触发登录规则。初始化时捕获当时已启用的登录规则 ID，之后新建或启用的规则等待下次登录初始化。登录后延迟以软件初始化完成后的单调时间计算，Windows 从登录到派发启动进程本身的延迟不可控制。手动打开不执行登录规则；已有实例收到自动登录参数不会执行新的登录规则。暂停自动任务不影响正在执行的任务及手动启动。

程序彻底退出时没有独立后台服务或 Windows Task Scheduler 任务。仅自启可在下次登录恢复进程。导入后强制暂停自动任务，用户主动恢复后才允许调度；Windows 自启设置不在 JSON 中导入或导出。

## 启动和错误

EXE 用 Rust Command（Windows CreateProcess）传递分离的参数数组及工作目录。默认网址、LNK、文件夹使用 ShellExecuteW 系统关联；LNK 参数字段使用 Windows 标准引号转义，无命令解释器。LNK 目标由 Windows 快捷方式定义，目标参数处理取决于系统关联和目标程序。

已运行检测使用 ToolHelp 枚举进程，再通过 QueryFullProcessImageNameW 和规范化完整路径比较；无法访问的进程忽略，不降级为进程名匹配。LNK 不进行目标运行检测。网络等待检查非回环且运行中的接口，30 秒超时；这是接口就绪检测，不能证明互联网或具体站点可达。

每个任务启动前写入 running，再执行延迟和网络等待；禁用任务 skipped；系统接受启动请求 launch_requested；启动错误 failed 后继续下一个任务。场景汇总可为 partial。启动请求成功不代表软件完全就绪。

若退出或崩溃留下 pending/running，下一次启动将其标记 failed，自动去重记录仍保留，避免再次提交可能已经发出的请求。错误消息采用中文固定提示，不把用户网址、完整路径和参数写入错误信息；必要底层错误仅写入 stderr。

## 安全边界

不调用 cmd、PowerShell 或任意脚本作为程序核心。只允许 http/https、不含账号密码的 URL；程序仅支持本地完整 EXE/LNK 路径，拒绝 UNC 和设备路径。原生对话框选择路径，导入限 UTF-8 JSON 和 10 MB，未知字段拒绝，实体关系和字段范围验证后才提交事务。

WebView 只加载本地资产，没有远程 capability。CSP 禁止 frame/object、远程脚本和资源。前端仅授予事件和文件选择器权限，autostart、opener、notification 等功能在 Rust 中调用。应用不请求管理员权限、不绕过 UAC、不含遥测。

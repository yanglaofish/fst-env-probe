# fst 0.6.0 兼容评审与 Windows 离线包

开始日期：2026-10-14；交付验证日期：2026-10-15。基线为 `main` 的 `320812c`，分支为 `upgrade/fst-0.6.0-offline-20261014`。

## 升级与适配

从官方 `https://registry.npmjs.org` 查询并安装 `@yanglaofish/fishtools@0.6.0`，本机原版本为 0.5.2。插件从 0.1.1 调整为 0.1.2；本轮未发布 npm。

核对官方随包 `manual/docs/releases.md`、`plugin-development.md` 及实现，发现以下事项：

| 检查项 | 处理 |
| --- | --- |
| 有效参数来源 | 补充 `x-fst.fromConfig`，覆盖 timeoutMs、concurrency、allowRemoteMounts 与 snapshotPath；不以固定输入 default 覆盖配置。 |
| 留空含义 | 工具按分组检查，分组默认为全部；detect/report 的分组由配置开关决定。额外目录是合并关系，只声明省略含义，避免误表示为替换配置。 |
| 工具输入联合类型 | 宿主不接受 oneOf 字段上的 x-fst；改为等价的 string/array 类型声明，继续校验数组项为字符串，TUI 仍采用 JSON 输入。 |
| 快照条件 | 保留现有语义：非空白显式路径或配置路径就启用写入；无路径时才由 snapshot 控制。文案和集成测试均覆盖。 |
| 全局插件安装 | 0.5.3 起 CLI 默认用全局插件库。集成测试增加独立 FISHTOOLS_HOME，避免安装测试改动用户插件。离线构建也使用独立工作区与插件库。 |
| 受管执行诊断 | 新 lint 对 lib/run-process.js 的 spawn/execFile 报两条 UNMANAGED_PROCESS 警告，源于保留的独立服务回退。普通动作传入宿主 runProcess；共享服务消费者应传入动作上下文。仅这两条既有诊断可通过测试，新文件或新类型诊断仍失败。 |
| 新业务报告协议 | 属于可选增强。现有结构化结果、print 摘要及 Markdown/JSON 文件仍可用，本轮保留输出字段和工作流绑定契约。 |

插件生产代码仍不导入内部宿主包；SDK 声明和输出 schemaVersion 不变。完整参数来源展示及当前集成测试要求 fst 0.6.0；本轮没有声称重新验证所有历史宿主。

## 验证范围

- Windows x64 / Node 24.15.0 / fst 0.6.0：完整单元测试 106 项，105 通过、1 项平台跳过。
- 真实宿主集成 6 项：声明与限定质量诊断、所有动作及工作流、服务重启、参数来源与真实 TUI 渲染、中文快捷名称、npm 归档隔离安装。
- 参数测试覆盖配置初值、配置修改、显式覆盖、false、恢复继承、原始输入不被改写、预览与动作实际收到的值一致。使用真实 TUI 渲染/输入函数，用户选择由测试适配器模拟，不等同真实终端按键全流程。
- 首次同时运行 unit 和 integration 时，Windows taskkill 回收测试的 1200 毫秒标记断言失败；单独定向及完整单元重跑均通过。该断言对高负载下的回收耗时敏感，本轮未修改生产进程回收代码，不将其表述为已经彻底排除时序风险。
- CI 保留 Ubuntu / Windows / macOS 固定 0.6.0 和官方 latest 的六项矩阵；远端结果见本次 PR/Actions。

## 离线包制作

用户选择 Windows x64。使用干净项目和隔离的全局库，仅安装本插件的 npm 归档，附带 `envprobe-report` 工作流，调用 FST 官方便携打包功能：

```powershell
# FISHTOOLS_HOME 指向独立构建用目录，避免打包用户的插件、配置或业务数据。
$env:FISHTOOLS_HOME = 'E:/Agenttools/tools-plugin/fst-env-probe/.artifacts/offline-build-0.6.0/home'
fst --project ./project portable --target win32-x64 --no-web --plan
fst --project ./project portable --target win32-x64 --no-web --out ./dist
```

交付的 ZIP 是 FST 生成的归档，仅重命名文件，没有手工修改包内载荷或完整性清单。包含 Node 24.15.0、npm、FST 0.6.0、fst-env-probe 0.1.2、离线手册与报告工作流；采用可编辑便携模式，不额外携带 Web。不打包本机探测结果、用户环境配置或被检测的 Python/Docker 等软件。

离线验收在 ZIP 重新解压的独立目录进行：从 PATH 移除开发 Node/npm/fst，使用空白工作区和插件库；通过 Node 预加载器阻断 TCP、TLS、DNS、UDP 和 fetch，并设置无效代理及 npm 离线模式。执行 doctor 完整性检查、141 项能力目录、包内 Node 版本检测及完整报告工作流，均成功且无 Node 联网尝试；报告生成 Markdown/JSON。此验证不是物理断网或外部程序的系统级网络封锁，也不是另一台机器的实际验收。

## 使用

完整解压 ZIP，双击 `run.cmd`，输入 `/envprobe` 进入菜单，或 `/envprobe.check` 直接执行。PowerShell 中：

```powershell
.\fst.cmd run envprobe-report
# 或指定可写工作区
.\fst.cmd --workspace D:\fst-work command envprobe.report
```

返回值 `files` 给出 Markdown/JSON 的实际路径。默认工作区为 `~/.fishtools/workspaces/<包ID>`，业务文件位于 `results/<运行ID>/`。不要单独复制启动脚本或修改包内程序文件；若需另一个操作系统的便携包，应另行导出相应目标。

## 备份与恢复

升级前备份在 `E:/Agenttools/tools-plugin/backups/fst-0.6.0-20261014`：完整用户工作区、完整 0.5.2 宿主程序与官方旧版 npm 归档。恢复命令及工作区恢复步骤见目录中的 `恢复说明.txt`。恢复工作区前先关闭 fst，并另存升级后产生的新数据。

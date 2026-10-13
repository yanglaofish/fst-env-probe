# fst 0.5.2 兼容评审

日期：2026-10-13。基线为 `main` 的 `71080ba`，工作分支为 `upgrade/fst-0.5.2-compat-20261013`。

## 结论与调整范围

官方 npm 源存在的版本为 `0.5.2`，本机已从 `0.5.1` 升级并用 `fst --version` 确认。已有 `fst-env-probe 0.1.1` 可以直接运行，无需迁移生产代码、SDK 声明或已有工作流。

本轮必要维护为：将 CI 固定宿主从 `0.5.0` 更新到 `0.5.2`，保留官方 `latest` 检查；增加中文快捷名称的真实宿主集成测试；补充新入口用法和兼容说明。插件版本保持 `0.1.1`，本轮没有新增 npm 发布。

## 架构变更核对

对照官方 npm 归档内的 `manual/docs/modules.md`、`releases.md`、`terminal-commands.md` 与随包源码，并比较备份的 0.5.1：

| 边界 | 官方变更与本插件影响 |
| --- | --- |
| 十一模块拆分 | core 负责装配；SDK、platform、plugin、workspace 等按职责分离。此拆分在 0.5.1 中已经存在。插件以普通 ESM 导出接入，生产代码没有导入内部 `@mytools/*` 包，也不读取整个 application。 |
| SDK 与工作流 | 0.5.1/0.5.2 的 SDK 目录无差异，官方说明 SDK_VERSION、工作流格式与原动作 ID 保持兼容。本插件 `sdk: ^0.1.0`、输出 schemaVersion 1 可继续使用。 |
| 新命令与中文快捷名称 | 新增 `/commands`、`/shortcuts` 和 `!` 系统命令；命令名支持 Unicode。插件已有 `envprobe.*` 命名不冲突，不需要把中文别名写死进插件定义。 |
| 命令目标身份 | 新宿主的快捷命令同时绑定命令名与提供插件。已验证本插件的动作型命令、独立交互命令和稳定动作 ID 均可绑定，并保留默认参数及重启后的绑定。 |
| 子进程缓冲与回收 | 0.5.2 调整了输出缓冲和超限时的管道处理；插件使用的 `runProcess` 调用和返回结构保持兼容。真实 node/npm 版本探测、全部动作及完整环境探测均通过。 |
| 共享服务与状态目录 | 插件继续使用 `runtime.provides`、`updatePolicy: automatic`、`getService`、`projectDir` 和 `stateDir`。配置重启、持久化、快照及工作流字段绑定已经实际验证。 |
| 隔离文件探测 | `ctx.fs` 已存在于此前版本，不会自动替换插件自己的 `node:fs` 调用。现有远程挂载跳过及等待上限继续有效；进一步迁移隔离文件探测可作为独立增强，本轮没有把等待超时表述为能取消内核 I/O。 |

官方资料中的开发阶段“尚未发布”记录属于历史验收状态；实际发布状态以本轮官方 npm 查询和安装结果为准。

## 本地验证

Windows x64、Node 24.15.0、fst 0.5.2：

- 原有单元及回归测试：106 项，105 通过、1 项按平台跳过，失败为零。
- 原有真实宿主集成测试：4 项全部通过。
- 新增快捷名称测试：在临时工作区绑定中文名称到 `envprobe.check`、`envprobe.which`、`fst-env-probe:check`，核对提供者身份、默认输入、实际输出，并在关闭后重开工作区再次执行通过。
- 默认工作区中的已安装插件直接升级宿主后仍 `ready: true`；完整探测 `ok: true`，141 个检测项中找到 40 个工具、11 个 Python、6 个网卡、1 个加速设备，无采集错误或告警。

集成测试现在要求 fst 至少为 0.5.2，以实际覆盖新的快捷名称 API；这项测试要求不代表插件生产代码提高了最低宿主版本。三平台 CI 同时测试固定 0.5.2 与 npm latest，最终结果以本分支 PR 和主分支 Actions 为准。

## 备份与回退

升级前完整备份位于 `E:\Agenttools\tools-plugin\backups\fst-0.5.2-20261013-155740`：

- `fishtools-home`：`C:\Users\pc\.fishtools` 的完整备份。
- `host-0.5.1`：原全局安装目录副本，供源码对照。
- `yanglaofish-fishtools-0.5.1.tgz`：从官方 npm 源取得的旧版安装归档。

需要回退宿主时执行：

```powershell
npm install -g "E:\Agenttools\tools-plugin\backups\fst-0.5.2-20261013-155740\yanglaofish-fishtools-0.5.1.tgz" --registry=https://registry.npmjs.org
fst --version
```

若还需恢复工作区，先停止 fst 并另存升级后的新数据，再从 `fishtools-home` 恢复。快捷名称集成测试全部使用临时工作区，没有向用户默认工作区添加快捷项。

# 更新日志

本文件记录 fishtools-env-probe 的重要变更。版本号遵循[语义化版本](https://semver.org/lang/zh-CN/)。

## [0.1.0] - 2026-10-12

首个版本。

### 检测能力

- **十个分组**：`system`、`shell`、`language`、`tool`、`container`、`package`、`network`、`gpu`、`env`、`custom`，
  内置 141 个检测项（工具、运行时、容器引擎、包管理器、加速设备等）。
- **八个动作**：`detect`（完整探测）、`check`（任意工具或分组）、`pythons`（全部 Python）、
  `resolve`（按需解析）、`verify`（校验环境要求）、`report`（生成报告）、`catalog`（能力清单）、
  `status`（共享服务状态）。
- **20 个斜杠入口**：`/envprobe.check`、`/envprobe.list`、十个分组各一个、`/envprobe.python`、
  `/envprobe.which`、`/envprobe.service`，以及全部动作入口。
- **多版本安装枚举**：识别 PATH 之外由版本管理器安装的解释器与工具——nvm、fnm、volta、n、
  sdkman、`/usr/lib/jvm`、pyenv、uv、mise、rustup、rbenv、rvm、phpenv 等。
  每个安装各自带上版本，`candidates` 给出全部命中位置，`installations` 给出逐个明细。
- **Python 专题**：合并 PATH、`py` 启动器登记的版本（解析 `py -0p`）与 conda 各环境，
  带符号链接解析后的真实路径。

### 交付方式

- 输出 `paths` 与 `flags` 可直接绑定给其他插件的输入字段（零耦合）。
- 结果可写入快照文件（插件 `stateDir`，路径由返回值给出），任何插件或外部脚本都能读。
- 可发布为 Cordis 共享服务 `env.probe`：本包声明 `provides: ['env.probe']`，
  其他插件声明 `dependencies` + `runtime.inject` 后即可在代码里 `getService('env.probe').pathOf('python')`。
  代价仅限于"在常驻 TUI/Web 里改本插件配置或装卸插件需先进入维护模式"，工作流与 CLI 均不受影响。

### 可靠性

- **目录扫描全部异步**并带每目录超时（默认 3 秒），不使用同步文件系统调用，不会卡住宿主事件循环。
- **默认跳过远程挂载点**（NFS、CIFS、SMB、SSHFS、autofs、9p、ceph 等；Windows 上还有 UNC 与网络驱动器）：
  这类路径上的文件系统调用可能永不返回。跳过与超时全部写进 `warnings` 与 `scan`，
  `flags.incompleteScan` 同时置位——**不会静默漏检**。
- 采集失败的分组进入 `errors` 并让 `ok` 为 false，`flags.probeFailed` 供条件判断使用。
- 92 个单元测试：覆盖版本解析与范围匹配、可执行文件解析、挂载识别、安装目录展开、
  Python 启动器解析、代理凭据脱敏、四个分组的独立采集，以及动作端到端。

### 依赖

- 零第三方依赖，只使用 Node 内置模块。

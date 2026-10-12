# fst-env-probe

Fishtools 的跨平台环境探测插件。只做一件事：**把当前机器上有什么、在哪里，查清楚并用稳定的字段名报出来**。

不安装、不修改、不修复任何环境；不依赖任何第三方 npm 包（只用 Node 内置模块）；不依赖其他插件，也不要求其他插件依赖它。

[![Node](https://img.shields.io/badge/node-%3E%3D24.15.0-brightgreen)](https://nodejs.org)
[![License](https://img.shields.io/badge/license-MIT-blue)](LICENSE)
[![Tests](https://img.shields.io/badge/tests-92%20passing-brightgreen)](test)
[![Dependencies](https://img.shields.io/badge/dependencies-0-brightgreen)](package.json)

一个包提供全部能力：十个分组的检测项、19 个斜杠入口、工作流动作，以及可选的 Cordis 共享服务 `env.probe`。

---

## 设计定位：插件之间零耦合，耦合只发生在工作流里

Fishtools 的插件是一部部「动作 + 输入/输出 schema」的独立零件，编排由工作流负责。本插件严格遵守这条线：

| 提供路径的方式 | 做法 | 插件间耦合 |
| --- | --- | --- |
| **工作流绑定**（首选） | 把 `steps.probe.output.paths.python` 绑到下一步插件的输入字段 | 零耦合：两个插件互不认识 |
| **快照文件** | 探测结果写入插件的 `stateDir`；实际路径由返回值 `snapshotPath` 给出，任何插件或外部脚本都能读 | 零耦合：只共享一个文件格式 |
| **共享服务**（可选） | 本包已把探测能力发布为 `env.probe`，其他插件可 `getService('env.probe').pathOf('python')` | 需消费方声明 `dependencies` + `runtime.inject` |
| **斜杠直达** | TUI 里 `/envprobe.check`、`/envprobe.python`、`/envprobe.network` … 直接查任意工具或分组 | 无 |
| **独立命令** | `fst command envprobe.detect`、`fst command envprobe.check` | 无 |

本包声明了 `runtime`（`provides: ['env.probe']`）。宿主据此认为项目里存在"运行时插件"，但实际影响范围很窄：

- **不受影响**：工作流运行、命令、动作、服务调用，以及 CLI 的 `fst plugin add` / `link` / `remove` / `configure`
  （这四个命令内部都带了管理/维护模式，逐行可查：`core/bin/fst.js` 的 38/39/40/71 行）。
- **受影响**：在常驻 TUI/Web 会话里**保存本插件配置**或**装卸插件**时，需要先在插件菜单里
  点一下「进入维护模式（停止有状态服务）」。

如果你完全不想要这个约束，把插件定义里的 `runtime` 那一段删掉即可——探测动作与工作流绑定完全不依赖它，
代价只是其他插件不能再通过 `getService('env.probe')` 取路径。

> 关于维护模式：0.4.0 起 `fst plugin add/link/remove/configure` 已自动使用管理模式；只有常驻 TUI/Web 的插件管理与配置修改仍需手动进入维护模式，且只在装了声明 `runtime` 的插件时才有这个要求。

## 安装

```sh
# 开发时用引用模式：改源码后重启 fst 即生效，不必反复重装
fst plugin link "D:\个人材料\Agent\Fishtools\plugins\fst-env-probe"

# 检查声明（不执行动作、不启动运行时服务）
fst plugin validate "D:\个人材料\Agent\Fishtools\plugins\fst-env-probe"

# 分发或稳定使用时用复制安装
fst plugin add "D:\个人材料\Agent\Fishtools\plugins\fst-env-probe"

fst plugin list
```

`add` 是复制安装（改了源码要重新 `add` 才生效），`link` 是源码引用（改完重启 `fst` 即生效）。反复 `add` 会留下旧安装批次，可用 `fst plugin gc` 先预览、再 `fst plugin gc --apply` 备份清理。

安装后：

```sh
fst command envprobe.detect                      # 全量探测，输出 JSON
fst command envprobe.report                      # 生成 Markdown/JSON 报告
fst command envprobe.resolve --input req.json    # 按需解析指定工具的路径
fst command envprobe.verify  --input req.json    # 校验环境要求
fst command envprobe.catalog                     # 列出可检测项
```

TUI 里也可以：`/fst-env-probe` 进入插件二级菜单，或直接输入 `/envprobe.detect`、`/envprobe.which`。

## 斜杠入口（TUI 里直接敲）

19 个入口，覆盖全部检测项：

| 入口 | 作用 | CLI 也能用 |
| --- | --- | --- |
| `/envprobe.check` | **通用查询**：任意工具标识或任意命令名（含未内置的内网 CLI），可一次给多个 | 是 |
| `/envprobe.list` | 列出全部检测项的检查结果 | 仅 TUI |
| `/envprobe.system`、`/envprobe.shell`、`/envprobe.language`、`/envprobe.tool`、`/envprobe.container`、`/envprobe.package`、`/envprobe.network`、`/envprobe.gpu`、`/envprobe.env`、`/envprobe.custom` | 每个检测分组一个快捷入口，进去不用填参数 | 仅 TUI |
| `/envprobe.python` | 全部 Python：PATH、`py` 启动器登记的版本、conda 环境；带路径、真实路径、版本、来源与默认标记 | 是 |
| `/envprobe.which` | 交互输入一个名字 → 路径 | 仅 TUI |
| `/envprobe.detect`、`/envprobe.report`、`/envprobe.resolve`、`/envprobe.verify`、`/envprobe.catalog` | 完整探测 / 报告 / 按需解析 / 校验 / 能力清单 | 是 |

`check` 列出的是**每个安装及其版本**，不只是 PATH 上的第一个：

```
✓ Python
    [主] 3.13.13   D:\Miniforge3\python.exe
    [次] 3.12.7    C:\Users\...\Programs\Python\Python312\python.exe
✓ Node.js
    [主] 24.11.1   C:\Program Files\nodejs\node.exe
✗ Java  未找到命令：java
```

除了 PATH 与平台已知目录，它还会去找**多版本安装**：nvm/fnm 的 node、sdkman/`/usr/lib/jvm` 的 java、
pyenv/uv/mise 的 python、rustup 的 toolchain、rbenv 的 ruby 等（见「扩充检测能力」的 `installPatterns`）。

## 动作

| 动作 | 能力标识 | 用途 |
| --- | --- | --- |
| 检查任意环境项 | `fst-env-probe:check` | 按工具标识或任意命令名检查，或按分组列出；给出**每个安装及其版本**、真实路径与全部候选 |
| 列出本机所有 Python | `fst-env-probe:pythons` | 全部 Python（PATH、`py` 启动器登记的版本、conda 环境）；`primary` 可直接绑定给其他插件 |
| 探测当前环境 | `fst-env-probe:detect` | 采集全部分组，返回结构化报告；`paths` / `flags` 可直接绑定给其他插件 |
| 解析工具路径 | `fst-env-probe:resolve` | 只解析指定的工具（含候选命令名与版本范围），返回 `paths`；必需项缺失时 `ok:false` 而不是抛错 |
| 校验环境要求 | `fst-env-probe:verify` | 逐项校验存在性、版本范围与附加子命令，返回 `ok` 与逐项明细 |
| 生成环境报告 | `fst-env-probe:report` | 一次探测后写出 Markdown + JSON 报告，同时返回 `paths` / `flags` |
| 列出可检测项 | `fst-env-probe:catalog` | 列出分组与工具，确认某个工具在不在支持范围 |

判定预设（工作流条件里可直接选）：

- `detect`：`找到 Python`、`找到 Node.js`、`找到 conda`、`找到 Git`、`找到 docker`、`找到 kubectl`、`存在 kubeconfig`、`检测到加速设备`、`检测到昇腾 NPU`、`容器守护进程可用`
- `resolve`：`全部解析成功`
- `verify`：`环境要求全部满足`
- `report`：`报告已生成`、`找到 Python`、`检测到加速设备`

## 检测范围

| 分组 | 内容 |
| --- | --- |
| `system` | 操作系统、发行版、内核、架构、主机名、用户、时区、运行时长、虚拟化/容器判定、CPU、内存、磁盘 |
| `shell` | PowerShell 5.1 / pwsh 7、cmd、bash、sh、zsh、fish、dash、ksh、Git Bash、WSL 发行版 |
| `language` | Python、pip、conda/mamba/micromamba、uv、poetry、Node/npm/npx/pnpm/yarn/bun/deno、Java/javac/Maven/Gradle、Go、rustc/cargo、.NET、gcc/g++/clang、make/cmake/ninja、Perl、Ruby、PHP、R、Julia、Lua、Swift、Kotlin |
| `tool` | git、git-lfs、gh、svn、hg、curl、wget、tar/zip/unzip/7z/zstd、OpenSSH、rsync、openssl、jq/yq、rg/fd、vim/nano、Pandoc、LibreOffice、ImageMagick、Ghostscript、FFmpeg、Terraform、Ansible、AWS/Azure/GCloud CLI、nvcc、nvidia-smi |
| `container` | docker、docker compose、podman、nerdctl、buildah、skopeo、ctr、crictl、kubectl、helm、kustomize、k9s、kind、minikube、kubeadm、istioctl、oc；并读取容器引擎信息与 kubeconfig 上下文/集群可达性 |
| `package` | yum、dnf、microdnf、apt、apt-get、apk、zypper、pacman、rpm、dpkg、brew、choco、winget、scoop、snap、flatpak、nix、port |
| `network` | 网卡列表（名称/描述/MAC/MTU/速率/状态/IPv4/IPv6/前缀）、网关、DNS、主机名、主地址、系统代理与环境变量代理、ip/ifconfig/ping/dig/nslookup/traceroute/netstat/ss/lsof/iperf3/nc/telnet/nmap |
| `gpu` | NVIDIA（型号/显存/驱动/温度/利用率）、昇腾 NPU（npu-smi 数量与设备）、ROCm、Intel XPU |
| `env` | PATH 条目与重复项、JAVA_HOME、CONDA_PREFIX、CUDA_HOME、KUBECONFIG、各类代理变量等 |
| `custom` | 来自插件配置 `extraProbes` 的自定义检测项 |

## 输出结构

`detect` / `report` 的关键字段：

```
{
  ok, schemaVersion, generatedAt, platformTarget, durationMs,
  platform,    // os/kernel/distro/host/user/timezone/virtual
  hardware,    // cpu/memory/disks
  shells,      // default/available/gitBash/wsl
  tools,       // {工具 id: {found,path,source,version,versionRaw,error,note,candidates}}
  paths,       // {工具 id: 绝对路径}  ← 只有找到的才有键，给其他插件绑定用
  flags,       // {工具 id: 布尔} + 聚合标志 gpu/npu/kubeconfig/containerDaemon/python/node/git/shell/...
  containers,  // engines[] + k8s{}
  inventory,   // pythons[] + conda{envs[]}
  network,     // adapters[]/gateways/dnsServers/primary/proxies
  gpu,         // devices[]/vendors/details
  env,         // selected/pathEntries/pathDuplicates
  groups,      // 各分组耗时与错误
  warnings,    // 非致命问题（含"跳过了哪些远程挂载点""哪些目录超时"）
  errors,      // 采集失败的分组明细；非空时 ok 为 false、flags.probeFailed 为 true
  scan,        // 扫描范围：读了多少目录、跳过/超时的位置；flags.incompleteScan 标记结果可能不完整
  summary      // 统计数字
}
```

**给其他插件送路径的三种写法：**

```yaml
# 1) 工作流绑定（零耦合）
- id: probe
  action: fst-env-probe:detect
  with: { toolIds: [python, pip] }
- id: run
  action: '@mytools/examples:pythonEcho'
  with:
    executable: { $ref: steps.probe.output.paths.python }
    text: 'hello'
```

```yaml
# 2) 先校验、拿版本，再送出去
- id: need
  action: fst-env-probe:verify
  with:
    requirements:
      - { id: python, version: '>=3.10' }
      - { id: docker, label: '容器引擎' }
- id: guard
  when: { left: { $ref: steps.need.output.ok }, op: eq, right: false }
  stop: { reason: 环境不满足要求，请查看校验明细 }
```

```jsonc
// 3) 快照文件：路径以返回值 snapshotPath 为准（默认写在插件 stateDir 下）
//    例：<项目>/.flow/plugin-state/<插件ID摘要>/environment-latest.json
{"paths": {"python": "D:\\Miniforge3\\python.exe", "git": "D:\\Git\\cmd\\git.exe"}, ...}
```

`resolve` 的 `paths` 与 `verify` 的 `paths` 同理，键就是你请求的工具标识，可以直接绑定。

## 配置

项目 `flow.project.json` 的 `config` 下按插件 ID 存配置；也可用 `fst --config 覆盖.json`：

```json
{
  "fst-env-probe": {
    "timeoutMs": 8000,
    "concurrency": 6,
    "cacheTtlSeconds": 300,
    "groups": { "gpu": false },
    "extraPaths": ["D:\\tools\\bin"],
    "snapshotPath": "D:\\env-snapshots\\current.json",
    "extraProbes": [
      {
        "id": "mycli",
        "title": "我们的内部 CLI",
        "group": "tool",
        "names": ["mycli", "mycli-cli"],
        "versionArgs": [["--version"], ["-v"]],
        "versionPattern": "mycli v(\\d+\\.\\d+\\.\\d+)",
        "pathHints": ["D:\\internal\\bin"],
        "note": "内网工具，不在 PATH 里"
      }
    ]
  }
}
```

| 键 | 说明 |
| --- | --- |
| `timeoutMs` | 单个版本命令超时，默认 8000 |
| `concurrency` | 并发进程数，默认 6 |
| `cacheTtlSeconds` | 探测结果缓存（仅影响以服务方式复用时），默认 300；0 表示不缓存 |
| `groups` | 默认关闭某些分组，例如 `{"gpu": false}` |
| `extraPaths` | 追加搜索目录，插在 PATH 之后、平台已知目录之前；只放本地目录（见下条） |
| `allowRemoteMounts` | 是否允许扫描远程挂载点，默认 `false`。默认跳过 NFS/CIFS/UNC 等（那里的文件系统调用可能永不返回）；打开后在 `scanTimeoutMs` 内尝试 |
| `scanTimeoutMs` | 单个目录读取超时，默认 3000 毫秒；超过即放弃该目录并记入告警 |
| `snapshotPath` | 固定快照路径：绝对路径按原样使用；相对路径以项目目录为基准且不能越界（`../` 会被拒绝）。留空则写入插件的 `stateDir` |
| `extraProbes` | 自定义探测器，**新增检测项无需改代码** |

## 扩充检测能力

两种方式，按需要选：

1. **不改代码**：在 `config.extraProbes` 里加一条（上例）。适合内网工具、私有 CLI、临时验证。
2. **改内置清单**：在 `lib/catalog.js` 的 `TOOL_SPECS` 数组里加一行：

   ```js
   { id: 'mytool', title: '我的工具', group: 'tool', cmd: { default: ['mytool'] }, version: [['--version']] },
   ```

   然后重装插件（`fst plugin add <插件目录>`）。`paths` / `flags` / 报告分节 / 输出 schema 会自动包含它。

要新增一整个分组（例如「数据库客户端」），在 `lib/catalog.js` 的 `GROUPS` 里加一项，再在 `lib/detect.js` 里挂上对应采集器。

**3. 补充多版本安装目录**：如果某个工具的安装不在 PATH 上（nvm、sdkman、pyenv、rustup 这类版本管理器），
给它声明 `installPatterns`，`check` / `detect` / `/envprobe.python` 就都能发现。内置清单里已为
python、pip、node、java、go、rustc、cargo、ruby、dotnet、php 声明；其他工具可以在插件配置里补：

```json
{
  "fst-env-probe": {
    "extraProbes": [
      {
        "id": "node",
        "names": ["node"],
        "installPatterns": {
          "default": ["~/.nvm/versions/node/*/bin/node", "/opt/nodejs/*/bin/node"],
          "win32": ["%APPDATA%\\nvm\\v*\\node.exe"]
        }
      }
    ]
  }
}
```

段落里一个 `*` 匹配一层目录，`Python*` / `jdk*` 这种前后缀也支持；命中项会带上 `source: "installation"`，
并且每个安装各自的版本都会被探测。

## 安全与信任边界

探测结果会落进报告文件与快照，而它所有输入字段都能被工作流绑定，所以把边界写清楚：

- **代理凭据会被脱敏**：`HTTP_PROXY` / `HTTPS_PROXY` / `ALL_PROXY` 等值里的 `user:password@` 会先改写成 `***@` 再进报告、快照与日志。报告仍包含主机名、用户名、MAC 地址与各类路径，分享前请自行评估。
- **候选命令名不允许路径**：`resolve` / `verify` 的 `tools[].names` 只接受纯命令名（`[A-Za-z0-9._-]`），写 `C:\...\x.exe` 或 `../x` 会被直接拒绝。要探测 PATH 之外的目录请用 `extraPaths`，并只指向可信位置——那里的同名程序会被执行版本命令。
- **附加命令只对已注册工具生效**：`verify` 的 `requirements[].command` / `args` 会以目标工具的身份执行任意参数，因此只对内置或配置注册表里的工具启用；未注册的 id 返回 `command_skipped`。不要把这些字段绑定到不可信来源的输入。
- **快照路径**：绝对路径按你的意图写入；相对路径以项目目录为基准并拒绝 `../` 逃逸。同名文件会被覆盖，请确认路径属于你自己。
- **工具标识做了原型污染防护**：标识会成为输出对象的键，`__proto__` / `constructor` / `prototype` 之类会被拒绝。
- **只读探测**：不安装、不修改、不修复环境。唯一的"写"是你让它写的报告与快照；唯一可能的外部请求是 `kubectl version`（只读版本查询，3 秒超时）。

## 平台与限制

- 声明支持 `win32` / `linux` / `darwin`（x64、arm64）。**Windows 已实机验证**；Linux/macOS 的采集分支按各平台的标准命令实现（`ip -j`、`/etc/os-release`、`/proc/*`、`df -kP`、`sw_vers`、`ifconfig`、`netstat -rn`、`scutil --dns`），但尚未在这些平台实机跑过，首次使用请以 `warnings` 字段为准。
- Windows 上优先使用 `pwsh`（PowerShell 7），回退到 Windows PowerShell 5.1；命令通过 `-EncodedCommand` 传入并强制 UTF-8 输出，避免中文乱码。
- Windows 上不把无扩展名的 shell 脚本当可执行文件（例如 `C:\Program Files\nodejs\npm`），而是优先选 `npm.cmd`，否则进程无法直接启动。
- Windows 上若只有 Git for Windows 附带的 `bash.exe`（不在 PATH 中），会自动补链为 `paths.bash` / `flags.bash`，下游插件照样能拿到 `bash` 路径。
- 微软商店的 `python.exe` 别名（`WindowsApps` 目录）会被识别并降低优先级，同时在 `tools.<id>.shim` 里标出。
- `npu-smi info` 的文本格式随驱动版本变化，本插件做尽力解析：`details.ascend.claimCount` 是工具自己报告的数量，`detectedCount` 是解析出的数量，两者不一致时会给出告警。
- WSL：`wsl -l -v` 与 `wsl --version` 是只读查询；`wsl -e uname -r` 会**真正启动发行版**（占资源、可能触发初始化），因此只在 `deep: true` 时执行。WSL 的输出编码随版本而异（默认 UTF-16LE），探测时两种解码都会试一次并取可读的那个。
- 目录扫描全部是**异步 + 每目录超时**（默认 3 秒），不使用同步文件系统调用，不会卡住宿主事件循环。
- **默认跳过远程挂载点**：Linux 读 `/proc/self/mounts` 识别 nfs/nfs4/cifs/smb3/sshfs/fuse 网络类/autofs/9p/ceph 等，macOS 解析 `mount` 输出，Windows 识别 UNC 与网络驱动器。这类路径上的文件系统调用可能**永不返回**（Linux NFS hard mount 是内核级不可中断睡眠，连 `kill -9` 都无效），所以默认不去碰；跳过了哪些、哪些目录超时，一律写进 `warnings` 与 `scan`，`flags.incompleteScan` 同时置位——不会静默少给结果。工具确实装在远程挂载上时，用 `allowRemoteMounts: true` 让它在超时内尝试。
- 探测过程只读：不会安装、升级、修复任何环境，也不会改动系统配置。
- 宿主声明要求 Node ≥ 24.15.0；在更低版本上 `npm` 安装时会打印 `EBADENGINE` 警告，插件本身只用到 Node 内置模块。

## 开发

```sh
node --test                                   # 85 个单元测试（1 个按平台跳过）
fst plugin validate "D:\...\plugins\fst-env-probe"   # 检查声明（不执行动作）
npm pack --dry-run                            # 确认打包内容
```

目录：

```
index.js              插件定义：动作、命令、配置 schema
lib/catalog.js        探测器注册表（加一行即新增一个检测项）
lib/which.js          跨平台可执行文件解析（PATH/PATHEXT/已知目录/商店别名/多版本安装目录/超时与跳过）
lib/mounts.js         远程与网络挂载点识别（Linux /proc/self/mounts、macOS mount、Windows 网络驱动器）
lib/exec.js           受管进程封装、PowerShell JSON 桥、有界并发
lib/version.js        迷你版本解析与范围匹配（零依赖）
lib/redact.js         代理凭据脱敏
lib/run-process.js    无宿主上下文时的进程调用回退（共享服务用）
lib/groups/system.js  系统、硬件、环境变量
lib/groups/toolchain.js 工具链与 Shell
lib/groups/network.js 网卡、IP、网关、DNS、代理
lib/groups/platform.js 容器/K8s、conda 与 Python 清单、加速设备
lib/detect.js         编排、缓存、按需解析、快照
lib/schema.js         输入输出 JSON Schema（paths/flags 键由注册表派生）
lib/render.js         Markdown 报告
test/                 9 个测试文件，覆盖解析、版本、脱敏、挂载识别、Python 解析、采集与动作端到端
```

## 许可证

MIT，见 [LICENSE](LICENSE)。

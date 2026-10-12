# fishtools-env-probe

[Fishtools](https://www.npmjs.com/package/@yanglaofish/fishtools) 的跨平台环境探测插件。

只做一件事：**把当前机器上有什么、在哪里，查清楚并用稳定的字段名报出来**。
不安装、不修改、不修复任何环境；零第三方依赖（只用 Node 内置模块）；不依赖其他插件，也不要求其他插件依赖它。

[![Node](https://img.shields.io/badge/node-%3E%3D24.15.0-brightgreen)](https://nodejs.org)
[![License](https://img.shields.io/badge/license-MIT-blue)](LICENSE)
[![Tests](https://img.shields.io/badge/tests-92%20passing-brightgreen)](fishtools-env-probe/test)
[![Dependencies](https://img.shields.io/badge/dependencies-0-brightgreen)](fishtools-env-probe/package.json)

## 能力概览

| 能力 | 说明 |
| --- | --- |
| **十个检测分组** | 系统与主机、Shell、语言运行时、通用工具、容器与 K8s、包管理器、网络、加速设备、环境变量、自定义；内置 141 个检测项 |
| **斜杠直达** | `/envprobe.check`、`/envprobe.list`、每个分组一个入口、`/envprobe.python`、`/envprobe.which` 等 20 个入口 |
| **每个安装都带版本** | 同一个命令有多个安装时全部列出，并各自探测版本；能发现 PATH 之外由 nvm、fnm、sdkman、pyenv、uv、mise、rustup、rbenv 等安装的解释器与工具 |
| **给其他插件供路径** | 输出 `paths` / `flags` 可直接绑定给下一步插件的输入字段（零耦合）；或让其他插件用共享服务 `env.probe` 在代码里 `pathOf('python')` |
| **工作流入口** | `detect` / `check` / `verify` / `report` 等动作可直接编排，也可作为独立命令调用 |

## 安装

```sh
git clone https://github.com/yanglaofish/fishtools-env-probe.git

# 复制安装
fst plugin add "./fishtools-env-probe"

# 或在开发时引用源码（改动后重启 fst 生效）
fst plugin link "./fishtools-env-probe"

fst command envprobe.detect
```

TUI 里直接敲 `/envprobe.check`（查任意工具，含未内置的命令名）、`/envprobe.python`、`/envprobe.network` …

## 文档

检测项清单、输出结构、配置项、安全与信任边界、扩展检测能力的方式（含自定义探测器的
`installPatterns`），都写在 [**fishtools-env-probe/README.md**](fishtools-env-probe/README.md)。
变更记录见 [CHANGELOG.md](fishtools-env-probe/CHANGELOG.md)。

## 开发与测试

```sh
cd fishtools-env-probe
npm test        # node --test，92 个用例（1 个按平台跳过）
```

CI 在 **Ubuntu / Windows / macOS** 三个平台各跑一遍（[.github/workflows/test.yml](.github/workflows/test.yml)）——
插件默认对远程挂载点、异步扫描与各平台采集分支的处理，都靠它来守。

## 设计取向

- **不做超出探测的事**：不安装软件、不改环境变量、不修复任何东西，只读不写（除非你显式要求写快照）。
- **失败要说出来**："没检测到"与"没能查到"必须可区分：采集失败进入 `errors` 并让 `ok` 为 false；
  跳过的远程挂载点、读取超时的目录都写进 `warnings` 与 `scan`，`flags.incompleteScan` 同时置位。
- **不阻塞宿主**：目录扫描全部异步 + 每目录超时，且默认跳过远程挂载点（那里的文件系统调用可能永不返回）。

## 许可证

MIT，见 [LICENSE](LICENSE)。

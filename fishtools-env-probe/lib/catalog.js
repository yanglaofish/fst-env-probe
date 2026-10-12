// 探测器注册表：内置清单 + 用户自定义探测器。
// 扩充检测能力有两种方式：改这里的清单，或在插件配置 extraProbes 里追加条目。
import { isValidPattern } from './version.js';

export const GROUPS = [
  { id: 'system', title: '系统与主机', description: '操作系统、内核、发行版、架构、主机名、用户、时区、CPU、内存、磁盘' },
  { id: 'shell', title: 'Shell 与脚本解释器', description: 'PowerShell、cmd、bash、zsh、Git Bash、WSL' },
  { id: 'language', title: '语言与运行时', description: 'Python/pip/conda、Node/npm、Java、Go、Rust、.NET、C/C++ 工具链' },
  { id: 'tool', title: '通用命令行工具', description: 'git、curl、压缩、SSH、文档与媒体处理工具' },
  { id: 'container', title: '容器与 K8s', description: 'docker/podman 引擎、kubectl/helm 与集群上下文' },
  { id: 'package', title: '包管理器', description: 'yum/dnf/apt/apk/zypper/pacman/brew/choco/winget/scoop' },
  { id: 'network', title: '网络', description: '网卡、IP、网关、DNS、代理与网络诊断工具' },
  { id: 'gpu', title: '加速设备', description: 'NVIDIA、昇腾 NPU、ROCm、Intel XPU' },
  { id: 'env', title: '环境变量', description: 'PATH、JAVA_HOME、CONDA_PREFIX、代理等关键变量' },
  { id: 'custom', title: '自定义探测器', description: '来自插件配置 extraProbes 的额外检测项' },
];

export const GROUP_IDS = GROUPS.map((group) => group.id);

const V = [['--version']];

// 多版本安装目录：这些工具的安装常常不在 PATH 上（nvm、fnm、sdkman、pyenv、rustup、mise…）。
// 段落里一个 `*` 匹配一层目录，`Python*` / `jdk*` 这种前后缀也支持。
// 新增工具只要在这里补一条；用户也可以用 config.extraProbes[].installPatterns 自己加。
const INSTALL_PATTERNS = {
  python: {
    win32: [
      '%LOCALAPPDATA%\\Programs\\Python\\Python*\\python.exe',
      '%USERPROFILE%\\miniconda3\\envs\\*\\python.exe',
      '%USERPROFILE%\\anaconda3\\envs\\*\\python.exe',
      '%ProgramData%\\miniconda3\\envs\\*\\python.exe',
      '%ProgramData%\\anaconda3\\envs\\*\\python.exe',
    ],
    default: [
      '~/.pyenv/versions/*/bin/python',
      '~/.local/share/mise/installs/python/*/bin/python',
      '/usr/local/python/*/bin/python',
      '/opt/python/*/bin/python',
      '~/miniconda3/envs/*/bin/python',
      '~/anaconda3/envs/*/bin/python',
      '/opt/conda/envs/*/bin/python',
    ],
  },
  pip: {
    win32: [
      '%USERPROFILE%\\miniconda3\\envs\\*\\Scripts\\pip.exe',
      '%ProgramData%\\miniconda3\\envs\\*\\Scripts\\pip.exe',
    ],
    default: ['~/miniconda3/envs/*/bin/pip', '~/anaconda3/envs/*/bin/pip', '/opt/conda/envs/*/bin/pip'],
  },
  node: {
    win32: [
      '%APPDATA%\\nvm\\v*\\node.exe',
      '%LOCALAPPDATA%\\fnm\\node-versions\\*\\installation\\node.exe',
    ],
    default: [
      '~/.nvm/versions/node/*/bin/node',
      '~/.local/share/mise/installs/node/*/bin/node',
      '~/.volta/tools/image/node/*/bin/node',
      '/usr/local/n/versions/node/*/bin/node',
      '/opt/nodejs/*/bin/node',
    ],
  },
  java: {
    win32: [
      '%ProgramFiles%\\Java\\*\\bin\\java.exe',
      '%ProgramFiles%\\Eclipse Adoptium\\jdk*\\bin\\java.exe',
      '%ProgramFiles%\\Microsoft\\jdk*\\bin\\java.exe',
      '%ProgramFiles%\\Zulu\\zulu-*\\bin\\java.exe',
    ],
    default: [
      '~/.sdkman/candidates/java/*/bin/java',
      '/usr/lib/jvm/*/bin/java',
      '/opt/java/*/bin/java',
      '~/.jenv/versions/*/bin/java',
    ],
  },
  go: {
    win32: ['%ProgramFiles%\\Go\\bin\\go.exe', '%LOCALAPPDATA%\\Programs\\Go\\bin\\go.exe'],
    default: ['/usr/local/go*/bin/go', '/opt/go/*/bin/go', '~/.local/share/mise/installs/go/*/bin/go'],
  },
  rustc: { default: ['~/.rustup/toolchains/*/bin/rustc'] },
  cargo: { default: ['~/.rustup/toolchains/*/bin/cargo'] },
  ruby: {
    win32: ['%USERPROFILE%\\.rbenv\\versions\\*\\bin\\ruby.exe'],
    default: ['~/.rbenv/versions/*/bin/ruby', '~/.rvm/rubies/*/bin/ruby'],
  },
  dotnet: {
    win32: ['%ProgramFiles%\\dotnet\\dotnet.exe'],
    default: ['/usr/share/dotnet/dotnet', '/usr/local/share/dotnet/dotnet', '~/.dotnet/dotnet'],
  },
  php: {
    win32: ['%ProgramFiles%\\php*\\php.exe', '%USERPROFILE%\\scoop\\apps\\php\\current\\php.exe'],
    default: ['/usr/local/php/*/bin/php', '/opt/php/*/bin/php', '~/.phpenv/versions/*/bin/php'],
  },
};

/** 内置工具清单：新增一个检测项就加一行。 */
const TOOL_SPECS = [
  // ---------- Shell ----------
  { id: 'powershell', title: 'Windows PowerShell', group: 'shell', cmd: { win32: ['powershell'] }, version: [['-NoProfile', '-NonInteractive', '-Command', '$PSVersionTable.PSVersion.ToString()']], note: 'Windows 内置版本（通常 5.1）' },
  { id: 'pwsh', title: 'PowerShell 7+', group: 'shell', cmd: { default: ['pwsh'] }, version: [['-NoProfile', '-NonInteractive', '-Command', '$PSVersionTable.PSVersion.ToString()']] },
  { id: 'cmd', title: '命令提示符 cmd', group: 'shell', cmd: { win32: ['cmd'] }, version: [['/c', 'ver']], parse: { pattern: '(\\d+\\.\\d+\\.\\d+\\.\\d+)' } },
  { id: 'bash', title: 'Bash', group: 'shell', cmd: { default: ['bash'] }, version: [['--version']] },
  { id: 'sh', title: 'POSIX sh', group: 'shell', cmd: { default: ['sh'] } },
  { id: 'zsh', title: 'Zsh', group: 'shell', cmd: { default: ['zsh'] }, version: [['--version']] },
  { id: 'fish', title: 'Fish', group: 'shell', cmd: { default: ['fish'] }, version: [['--version']] },
  { id: 'dash', title: 'dash', group: 'shell', cmd: { default: ['dash'] } },
  { id: 'ksh', title: 'KornShell', group: 'shell', cmd: { default: ['ksh'] } },
  { id: 'wsl', title: 'WSL', group: 'shell', cmd: { win32: ['wsl'] }, version: [['--version']] },

  // ---------- 语言与运行时 ----------
  { id: 'python', title: 'Python', group: 'language', cmd: { win32: ['python', 'python3'], default: ['python3', 'python'] }, version: [['--version'], ['-V']] },
  { id: 'pip', title: 'pip', group: 'language', cmd: { win32: ['pip', 'pip3'], default: ['pip3', 'pip'] }, version: [['--version']] },
  { id: 'conda', title: 'Conda', group: 'language', cmd: { win32: ['conda'], default: ['conda'] }, version: [['--version']] },
  { id: 'mamba', title: 'Mamba', group: 'language', cmd: { default: ['mamba'] }, version: [['--version']] },
  { id: 'micromamba', title: 'Micromamba', group: 'language', cmd: { default: ['micromamba'] }, version: [['--version']] },
  { id: 'uv', title: 'uv', group: 'language', cmd: { default: ['uv'] }, version: [['--version']] },
  { id: 'poetry', title: 'Poetry', group: 'language', cmd: { default: ['poetry'] }, version: [['--version']] },
  { id: 'pipx', title: 'pipx', group: 'language', cmd: { default: ['pipx'] }, version: [['--version']] },
  { id: 'node', title: 'Node.js', group: 'language', cmd: { default: ['node'] }, version: [['-v'], ['--version']] },
  { id: 'npm', title: 'npm', group: 'language', cmd: { default: ['npm'] }, version: [['-v'], ['--version']] },
  { id: 'npx', title: 'npx', group: 'language', cmd: { default: ['npx'] }, version: [['--version']] },
  { id: 'pnpm', title: 'pnpm', group: 'language', cmd: { default: ['pnpm'] }, version: [['-v'], ['--version']] },
  { id: 'yarn', title: 'Yarn', group: 'language', cmd: { default: ['yarn'] }, version: [['-v'], ['--version']] },
  { id: 'bun', title: 'Bun', group: 'language', cmd: { default: ['bun'] }, version: [['--version']] },
  { id: 'deno', title: 'Deno', group: 'language', cmd: { default: ['deno'] }, version: [['--version']] },
  { id: 'java', title: 'Java', group: 'language', cmd: { default: ['java'] }, version: [['-version']], note: '版本输出走 stderr' },
  { id: 'javac', title: 'javac', group: 'language', cmd: { default: ['javac'] }, version: [['-version']] },
  { id: 'mvn', title: 'Maven', group: 'language', cmd: { default: ['mvn'] }, version: [['-v']] },
  { id: 'gradle', title: 'Gradle', group: 'language', cmd: { default: ['gradle'] }, version: [['--version']] },
  { id: 'go', title: 'Go', group: 'language', cmd: { default: ['go'] }, version: [['version']] },
  { id: 'rustc', title: 'rustc', group: 'language', cmd: { default: ['rustc'] }, version: [['--version'], ['-V']] },
  { id: 'cargo', title: 'cargo', group: 'language', cmd: { default: ['cargo'] }, version: [['--version'], ['-V']] },
  { id: 'dotnet', title: '.NET', group: 'language', cmd: { default: ['dotnet'] }, version: [['--version'], ['--list-sdks']] },
  { id: 'gcc', title: 'GCC', group: 'language', cmd: { default: ['gcc'] }, version: [['--version']] },
  { id: 'gpp', title: 'G++', group: 'language', cmd: { default: ['g++'] }, version: [['--version']] },
  { id: 'clang', title: 'Clang', group: 'language', cmd: { default: ['clang'] }, version: [['--version']] },
  { id: 'make', title: 'make', group: 'language', cmd: { default: ['make'] }, version: [['--version']] },
  { id: 'cmake', title: 'CMake', group: 'language', cmd: { default: ['cmake'] }, version: [['--version']] },
  { id: 'ninja', title: 'Ninja', group: 'language', cmd: { default: ['ninja'] }, version: [['--version']] },
  { id: 'perl', title: 'Perl', group: 'language', cmd: { default: ['perl'] }, version: [['-v']] },
  { id: 'ruby', title: 'Ruby', group: 'language', cmd: { default: ['ruby'] }, version: [['-v'], ['--version']] },
  { id: 'php', title: 'PHP', group: 'language', cmd: { default: ['php'] }, version: [['-v'], ['--version']] },
  { id: 'rlang', title: 'R', group: 'language', cmd: { default: ['R'] }, version: [['--version']] },
  { id: 'julia', title: 'Julia', group: 'language', cmd: { default: ['julia'] }, version: [['--version']] },
  { id: 'lua', title: 'Lua', group: 'language', cmd: { default: ['lua'] }, version: [['-v']] },
  { id: 'swift', title: 'Swift', group: 'language', cmd: { default: ['swift'] }, version: [['--version']] },
  { id: 'kotlin', title: 'Kotlin', group: 'language', cmd: { default: ['kotlin'] }, version: [['-version']] },

  // ---------- 通用工具 ----------
  { id: 'git', title: 'Git', group: 'tool', cmd: { default: ['git'] }, version: [['--version']] },
  { id: 'git-lfs', title: 'Git LFS', group: 'tool', cmd: { default: ['git-lfs'] }, version: [['version']] },
  { id: 'gh', title: 'GitHub CLI', group: 'tool', cmd: { default: ['gh'] }, version: [['--version']] },
  { id: 'svn', title: 'Subversion', group: 'tool', cmd: { default: ['svn'] }, version: [['--version', '--quiet']] },
  { id: 'hg', title: 'Mercurial', group: 'tool', cmd: { default: ['hg'] }, version: [['--version']] },
  { id: 'curl', title: 'curl', group: 'tool', cmd: { default: ['curl'] }, version: V },
  { id: 'wget', title: 'wget', group: 'tool', cmd: { default: ['wget'] }, version: V },
  { id: 'tar', title: 'tar', group: 'tool', cmd: { default: ['tar'] }, version: V },
  { id: 'zip', title: 'zip', group: 'tool', cmd: { default: ['zip'] }, version: [['-v']] },
  { id: 'unzip', title: 'unzip', group: 'tool', cmd: { default: ['unzip'] }, version: [['-v']] },
  { id: 'sevenzip', title: '7-Zip', group: 'tool', cmd: { win32: ['7z'], default: ['7z', '7za'] }, version: [['i']], parse: { pattern: '(\\d+\\.\\d+)' } },
  { id: 'rar', title: 'RAR/unrar', group: 'tool', cmd: { win32: ['WinRAR', 'unrar'], default: ['unrar'] }, version: [['-inul']], note: 'unrar 无版本输出时仅报告路径' },
  { id: 'zstd', title: 'zstd', group: 'tool', cmd: { default: ['zstd'] }, version: [['--version']] },
  { id: 'ssh', title: 'OpenSSH client', group: 'tool', cmd: { default: ['ssh'] }, version: [['-V']], note: '版本输出走 stderr' },
  { id: 'scp', title: 'scp', group: 'tool', cmd: { default: ['scp'] } },
  { id: 'sftp', title: 'sftp', group: 'tool', cmd: { default: ['sftp'] } },
  { id: 'rsync', title: 'rsync', group: 'tool', cmd: { default: ['rsync'] }, version: V },
  { id: 'openssl', title: 'OpenSSL', group: 'tool', cmd: { default: ['openssl'] }, version: [['version']] },
  { id: 'jq', title: 'jq', group: 'tool', cmd: { default: ['jq'] }, version: V },
  { id: 'yq', title: 'yq', group: 'tool', cmd: { default: ['yq'] }, version: V },
  { id: 'tree', title: 'tree', group: 'tool', cmd: { default: ['tree'] } },
  { id: 'rg', title: 'ripgrep', group: 'tool', cmd: { default: ['rg'] }, version: V },
  { id: 'fd', title: 'fd', group: 'tool', cmd: { default: ['fd'] }, version: V },
  { id: 'vim', title: 'Vim', group: 'tool', cmd: { default: ['vim'] }, version: V },
  { id: 'nano', title: 'nano', group: 'tool', cmd: { default: ['nano'] }, version: [['--version']] },
  { id: 'sed', title: 'sed', group: 'tool', cmd: { default: ['sed'] }, version: [['--version']] },
  { id: 'awk', title: 'awk', group: 'tool', cmd: { default: ['awk'] }, version: [['--version']] },
  { id: 'pandoc', title: 'Pandoc', group: 'tool', cmd: { default: ['pandoc'] }, version: V },
  { id: 'soffice', title: 'LibreOffice', group: 'tool', cmd: { win32: ['soffice'], default: ['soffice', 'libreoffice'] }, version: [['--version']] },
  { id: 'magick', title: 'ImageMagick', group: 'tool', cmd: { win32: ['magick'], default: ['magick', 'convert'] }, version: [['--version']] },
  { id: 'gs', title: 'Ghostscript', group: 'tool', cmd: { default: ['gs'] }, version: V },
  { id: 'ffmpeg', title: 'FFmpeg', group: 'tool', cmd: { default: ['ffmpeg'] }, version: [['-version']] },
  { id: 'ffprobe', title: 'FFprobe', group: 'tool', cmd: { default: ['ffprobe'] }, version: [['-version']] },
  { id: 'terraform', title: 'Terraform', group: 'tool', cmd: { default: ['terraform'] }, version: [['version']] },
  { id: 'ansible', title: 'Ansible', group: 'tool', cmd: { default: ['ansible'] }, version: V },
  { id: 'aws', title: 'AWS CLI', group: 'tool', cmd: { default: ['aws'] }, version: V },
  { id: 'az', title: 'Azure CLI', group: 'tool', cmd: { default: ['az'] }, version: V },
  { id: 'gcloud', title: 'Google Cloud CLI', group: 'tool', cmd: { default: ['gcloud'] }, version: V },
  { id: 'nvcc', title: 'CUDA nvcc', group: 'tool', cmd: { default: ['nvcc'] }, version: V },
  { id: 'nvidia-smi', title: 'NVIDIA SMI', group: 'gpu', cmd: { default: ['nvidia-smi'] }, version: V },

  // ---------- 容器与 K8s ----------
  { id: 'docker', title: 'Docker CLI', group: 'container', cmd: { default: ['docker'] }, version: V },
  { id: 'docker-compose', title: 'Docker Compose', group: 'container', cmd: { default: ['docker-compose'] }, version: V },
  { id: 'podman', title: 'Podman', group: 'container', cmd: { default: ['podman'] }, version: V },
  { id: 'nerdctl', title: 'nerdctl', group: 'container', cmd: { default: ['nerdctl'] }, version: V },
  { id: 'buildah', title: 'Buildah', group: 'container', cmd: { default: ['buildah'] }, version: V },
  { id: 'skopeo', title: 'Skopeo', group: 'container', cmd: { default: ['skopeo'] }, version: V },
  { id: 'ctr', title: 'containerd ctr', group: 'container', cmd: { default: ['ctr'] }, version: V },
  { id: 'crictl', title: 'crictl', group: 'container', cmd: { default: ['crictl'] }, version: V },
  { id: 'kubectl', title: 'kubectl', group: 'container', cmd: { default: ['kubectl'] }, version: [['version', '--client']] },
  { id: 'helm', title: 'Helm', group: 'container', cmd: { default: ['helm'] }, version: [['version']] },
  { id: 'kustomize', title: 'Kustomize', group: 'container', cmd: { default: ['kustomize'] }, version: [['version']] },
  { id: 'k9s', title: 'k9s', group: 'container', cmd: { default: ['k9s'] }, version: [['version']] },
  { id: 'kind', title: 'kind', group: 'container', cmd: { default: ['kind'] }, version: [['version']] },
  { id: 'minikube', title: 'minikube', group: 'container', cmd: { default: ['minikube'] }, version: [['version']] },
  { id: 'kubeadm', title: 'kubeadm', group: 'container', cmd: { default: ['kubeadm'] }, version: [['version']] },
  { id: 'istioctl', title: 'istioctl', group: 'container', cmd: { default: ['istioctl'] }, version: [['version', '--short']] },
  { id: 'oc', title: 'OpenShift CLI', group: 'container', cmd: { default: ['oc'] }, version: [['version', '--client']] },

  // ---------- 包管理器 ----------
  { id: 'yum', title: 'Yum', group: 'package', cmd: { default: ['yum'] }, version: V },
  { id: 'dnf', title: 'DNF', group: 'package', cmd: { default: ['dnf'] }, version: V },
  { id: 'microdnf', title: 'microdnf', group: 'package', cmd: { default: ['microdnf'] }, version: V },
  { id: 'apt', title: 'APT', group: 'package', cmd: { default: ['apt'] }, version: V },
  { id: 'apt-get', title: 'apt-get', group: 'package', cmd: { default: ['apt-get'] }, version: V },
  { id: 'apk', title: 'APK (Alpine)', group: 'package', cmd: { default: ['apk'] }, version: V },
  { id: 'zypper', title: 'Zypper', group: 'package', cmd: { default: ['zypper'] }, version: V },
  { id: 'pacman', title: 'Pacman', group: 'package', cmd: { default: ['pacman'] }, version: V },
  { id: 'rpm', title: 'RPM', group: 'package', cmd: { default: ['rpm'] }, version: V },
  { id: 'dpkg', title: 'dpkg', group: 'package', cmd: { default: ['dpkg'] }, version: V },
  { id: 'brew', title: 'Homebrew', group: 'package', cmd: { default: ['brew'] }, version: V },
  { id: 'choco', title: 'Chocolatey', group: 'package', cmd: { default: ['choco'] }, version: V },
  { id: 'winget', title: 'winget', group: 'package', cmd: { win32: ['winget'] }, version: V },
  { id: 'scoop', title: 'Scoop', group: 'package', cmd: { win32: ['scoop'] } },
  { id: 'snap', title: 'Snap', group: 'package', cmd: { default: ['snap'] }, version: V },
  { id: 'flatpak', title: 'Flatpak', group: 'package', cmd: { default: ['flatpak'] }, version: V },
  { id: 'nix', title: 'Nix', group: 'package', cmd: { default: ['nix'] }, version: V },
  { id: 'port', title: 'MacPorts', group: 'package', cmd: { darwin: ['port'] }, version: [['version']] },

  // ---------- 网络 ----------
  { id: 'ip', title: 'iproute2 (ip)', group: 'network', cmd: { default: ['ip'] }, version: [['-V']] },
  { id: 'ifconfig', title: 'ifconfig (net-tools)', group: 'network', cmd: { default: ['ifconfig'] }, version: V },
  { id: 'ipconfig', title: 'ipconfig', group: 'network', cmd: { win32: ['ipconfig'] } },
  { id: 'ping', title: 'ping', group: 'network', cmd: { default: ['ping'] } },
  { id: 'dig', title: 'dig', group: 'network', cmd: { default: ['dig'] }, version: [['-v']] },
  { id: 'nslookup', title: 'nslookup', group: 'network', cmd: { default: ['nslookup'] } },
  { id: 'traceroute', title: 'traceroute', group: 'network', cmd: { default: ['traceroute'] } },
  { id: 'tracert', title: 'tracert', group: 'network', cmd: { win32: ['tracert'] } },
  { id: 'netstat', title: 'netstat', group: 'network', cmd: { default: ['netstat'] } },
  { id: 'ss', title: 'ss (iproute2)', group: 'network', cmd: { default: ['ss'] }, version: [['-V']] },
  { id: 'lsof', title: 'lsof', group: 'network', cmd: { default: ['lsof'] } },
  { id: 'iperf3', title: 'iperf3', group: 'network', cmd: { default: ['iperf3'] }, version: V },
  { id: 'nc', title: 'netcat', group: 'network', cmd: { default: ['nc', 'netcat'] } },
  { id: 'telnet', title: 'telnet', group: 'network', cmd: { default: ['telnet'] } },
  { id: 'nmap', title: 'Nmap', group: 'network', cmd: { default: ['nmap'] }, version: V },

  // ---------- GPU（命令面） ----------
  { id: 'npu-smi', title: '昇腾 npu-smi', group: 'gpu', cmd: { default: ['npu-smi'] }, note: '设备明细由 GPU 采集器读取' },
  { id: 'rocm-smi', title: 'ROCm SMI', group: 'gpu', cmd: { default: ['rocm-smi'] }, version: V },
  { id: 'xpu-smi', title: 'Intel XPU SMI', group: 'gpu', cmd: { default: ['xpu-smi'] }, version: V },
  { id: 'nvidia-container-cli', title: 'nvidia-container-cli', group: 'gpu', cmd: { default: ['nvidia-container-cli'] }, version: V },
];

function pickCommand(spec, platform) {
  const table = spec.cmd ?? {};
  const names = table[platform] ?? table.default ?? [];
  return Array.isArray(names) ? names : [names];
}

function normalizeVersionArgs(spec) {
  if (!spec.version) return [];
  const args = Array.isArray(spec.version) ? spec.version : [spec.version];
  if (!args.length) return [];
  return Array.isArray(args[0]) ? args : [args];
}

/** 多版本安装目录模式：整段或段内一个 `*` 匹配一层目录。 */
export function normalizeInstallPatterns(value) {
  if (!value || typeof value !== 'object' || Array.isArray(value)) return {};
  const output = {};
  for (const [platform, list] of Object.entries(value)) {
    if (!Array.isArray(list)) continue;
    const items = list.filter((item) => typeof item === 'string' && item.trim());
    if (items.length) output[platform] = items;
  }
  return output;
}

/** 取当前平台适用的安装目录模式；未声明平台专用项时用 default。 */
export function patternsFor(tool, platform) {
  const table = tool?.patterns ?? {};
  const specific = table[platform] ?? table[platformKeyOf(platform)] ?? null;
  return specific ?? table.default ?? [];
}

function platformKeyOf(platform) {
  return platform === 'win32' ? 'win32' : platform === 'darwin' ? 'darwin' : 'linux';
}

function normalizeTool(spec, { source = 'builtin' } = {}) {
  return {
    id: spec.id,
    title: spec.title ?? spec.id,
    group: spec.group ?? 'custom',
    versionArgs: normalizeVersionArgs(spec),
    parse: spec.parse ?? null,
    note: spec.note ?? '',
    searchDirs: Array.isArray(spec.pathHints) ? spec.pathHints : [],
    source,
    cmd: spec.cmd ?? {},
    patterns: normalizeInstallPatterns(spec.installPatterns),
  };
}

// 把安装目录模式挂到对应工具上（表在上方集中维护）。
for (const spec of TOOL_SPECS) {
  const patterns = INSTALL_PATTERNS[spec.id];
  if (patterns) spec.installPatterns = patterns;
}

export const TOOLS = TOOL_SPECS.map((spec) => normalizeTool(spec));
export const TOOL_IDS = TOOLS.map((tool) => tool.id);
export const TOOL_BY_ID = new Map(TOOLS.map((tool) => [tool.id, tool]));

export function commandNamesFor(tool, platform) {
  return pickCommand(tool, platform);
}

const BUILTIN_BUNDLE = { tools: TOOLS, toolIds: TOOL_IDS, toolById: TOOL_BY_ID };
// 配置对象在一次宿主生命周期内稳定，按数组引用缓存合并结果，避免每次检测都重建 140+ 条注册表。
const CUSTOM_BUNDLES = new WeakMap();

/** 把插件配置里的 extraProbes 合并进注册表；同 id 覆盖内置条目。 */
export function withCustomProbes(customProbes = []) {
  if (!Array.isArray(customProbes) || !customProbes.length) return BUILTIN_BUNDLE;
  const cached = CUSTOM_BUNDLES.get(customProbes);
  if (cached) return cached;
  const merged = new Map(TOOL_BY_ID);
  const accepted = [];
  const rejected = [];
  for (const raw of customProbes) {
    const spec = normalizeCustomProbe(raw);
    if (!spec) {
      rejected.push(raw);
      continue;
    }
    merged.set(spec.id, normalizeTool(spec, { source: 'custom' }));
    accepted.push(spec.id);
  }
  const tools = [...merged.values()];
  const bundle = {
    tools,
    toolIds: tools.map((tool) => tool.id),
    toolById: merged,
    accepted,
    rejected,
  };
  CUSTOM_BUNDLES.set(customProbes, bundle);
  return bundle;
}

export function normalizeCustomProbe(raw) {
  if (!raw || typeof raw !== 'object') return null;
  const id = typeof raw.id === 'string' ? raw.id.trim() : '';
  if (!/^[A-Za-z][A-Za-z0-9._-]{0,63}$/.test(id)) return null;
  const names = []
    .concat(raw.names ?? raw.command ?? [])
    .filter((name) => typeof name === 'string' && name.trim())
    .map((name) => name.trim());
  if (!names.length) return null;
  const group = typeof raw.group === 'string' && GROUP_IDS.includes(raw.group) ? raw.group : 'custom';
  const versionInput = raw.versionArgs ?? raw.versionCommand ?? null;
  let version = [];
  if (typeof versionInput === 'string') version = [[versionInput]];
  else if (Array.isArray(versionInput)) {
    version = Array.isArray(versionInput[0]) ? versionInput : [versionInput];
  }
  return {
    id,
    title: typeof raw.title === 'string' && raw.title.trim() ? raw.title.trim() : id,
    group,
    cmd: { default: names },
    version: version.map((args) => (Array.isArray(args) ? args : [args])),
    parse: normalizePattern(raw.versionPattern),
    note: typeof raw.note === 'string' ? raw.note : '自定义探测器',
    pathHints: Array.isArray(raw.pathHints) ? raw.pathHints.filter((item) => typeof item === 'string') : [],
    // 想补 PATH 之外的多版本安装目录（nvm/sdkman/pyenv…）时用它，与内置工具同一套语义。
    installPatterns: normalizeInstallPatterns(raw.installPatterns),
  };
}

const MAX_PATTERN_LENGTH = 200;

/** 自定义版本正则可能写错或过长；无效就退回通用提取，而不是让每次检测都报错。 */
function normalizePattern(value) {
  if (typeof value !== 'string') return null;
  const pattern = value.trim();
  if (!pattern || pattern.length > MAX_PATTERN_LENGTH) return null;
  return isValidPattern(pattern) ? { pattern } : null;
}

export function groupMeta(groupId) {
  return GROUPS.find((group) => group.id === groupId) ?? { id: groupId, title: groupId, description: '' };
}

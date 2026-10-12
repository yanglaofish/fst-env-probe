// 迷你版本工具：不引入 semver 依赖，覆盖环境检测实际需要的比较与范围匹配。
const VERSION_RE = /(\d+)(?:\.(\d+))?(?:\.(\d+))?(?:\.(\d+))?/;
const SEMVER_LIKE = /(\d+(?:\.\d+){1,3})/;

/** 把 "go1.22.1" / "v2.50.1.windows.1" / "3.13" 解析为四段数字数组。 */
export function parseVersion(value) {
  if (Array.isArray(value)) return value.slice(0, 4).concat([0, 0, 0, 0]).slice(0, 4);
  if (value === null || value === undefined) return null;
  const m = VERSION_RE.exec(String(value));
  if (!m) return null;
  return [Number(m[1]), Number(m[2] ?? 0), Number(m[3] ?? 0), Number(m[4] ?? 0)];
}

/** 从命令输出里抽取版本号；优先第一行，避免把 "Built against python3.9" 之类当成版本。 */
export function extractVersion(text, { pattern } = {}) {
  if (!text) return null;
  const clean = String(text).replace(/\r/g, '');
  const lines = clean.split('\n').map((line) => line.trim()).filter(Boolean);
  const regex = compilePattern(pattern);
  const attempt = (target) => {
    if (!target) return null;
    if (regex) {
      regex.lastIndex = 0;
      const matched = regex.exec(target);
      if (matched) return matched[1] ?? matched[0];
      // 自定义正则没匹配上时回退到通用提取，避免写错一个字符就完全拿不到版本。
    }
    const m = SEMVER_LIKE.exec(target);
    return m ? m[1] : null;
  };
  return attempt(lines[0]) ?? attempt(clean);
}

const MAX_PATTERN_LENGTH = 200;
const CACHE_MAX = 512;
const PATTERN_CACHE = new Map();

function remember(cache, key, value) {
  // 键来自用户输入（版本范围、自定义正则），必须有上限，避免长时间运行时无界增长。
  if (cache.size >= CACHE_MAX) cache.clear();
  cache.set(key, value);
  return value;
}

/** 用户配置里的正则可能非法或过长；编译失败返回 null 而不是抛错。 */
export function compilePattern(pattern) {
  if (typeof pattern !== 'string' || !pattern || pattern.length > MAX_PATTERN_LENGTH) return null;
  if (PATTERN_CACHE.has(pattern)) return PATTERN_CACHE.get(pattern);
  let regex = null;
  try {
    regex = new RegExp(pattern);
  } catch {
    regex = null;
  }
  return remember(PATTERN_CACHE, pattern, regex);
}

/** 供配置校验复用同一套规则，避免阈值与判定在两处漂移。 */
export function isValidPattern(pattern) {
  return compilePattern(pattern) !== null;
}

/** 返回 -1 / 0 / 1；任一侧无法解析时返回 null。 */
export function compareVersions(a, b) {
  const left = parseVersion(a);
  const right = parseVersion(b);
  if (!left || !right) return null;
  return compare(left, right);
}

const CLAUSE_RE = /(>=|<=|>|<|=|\^|~)?\s*v?(\d+(?:\.\d+){0,3}|\*|x)/gi;

function compare(a, b) {
  for (let i = 0; i < 4; i += 1) {
    if (a[i] !== b[i]) return a[i] < b[i] ? -1 : 1;
  }
  return 0;
}

function clauseTest(current, op, raw) {
  if (raw === '*' || raw.toLowerCase() === 'x') return true;
  const segmentCount = raw.split('.').length;
  const bound = parseVersion(raw);
  if (!bound) return false;
  // 注意：不能直接对数组用 >= —— JS 会退化成字符串比较，必须逐段比。
  const result = compare(current, bound);
  switch (op) {
    case '>=': return result >= 0;
    case '>': return result > 0;
    case '<=': return result <= 0;
    case '<': return result < 0;
    case '^': {
      // npm 语义：^1.2.3 -> <2.0.0；^0.2.3 -> <0.3.0；^0.0.3 -> <0.0.4
      const upper = [0, 0, 0, 0];
      const firstNonZero = bound.findIndex((n) => n !== 0);
      const index = firstNonZero === -1 ? 0 : firstNonZero;
      for (let i = 0; i < index; i += 1) upper[i] = bound[i];
      upper[index] = bound[index] + 1;
      return result >= 0 && compare(current, upper) < 0;
    }
    case '~': {
      const upper = [...bound];
      if (segmentCount <= 1) upper[0] = bound[0] + 1;
      else upper[1] = bound[1] + 1;
      upper[2] = 0;
      upper[3] = 0;
      return result >= 0 && compare(current, upper) < 0;
    }
    case '=':
    default: {
      if (segmentCount <= 1) return current[0] === bound[0];
      if (segmentCount === 2) return current[0] === bound[0] && current[1] === bound[1];
      return current[0] === bound[0] && current[1] === bound[1] && current[2] === bound[2];
    }
  }
}

const CACHE = new Map();

/** 支持 ">=3.9"、"^3.9"、"~3.9 <4"、"3.12.x"、"*" 等写法。 */
export function satisfiesVersion(version, range) {
  if (range === undefined || range === null || range === '') return true;
  const text = String(range).trim();
  if (!text || text === '*') return true;
  let clauses = CACHE.get(text);
  if (!clauses) {
    clauses = [];
    CLAUSE_RE.lastIndex = 0;
    let match;
    while ((match = CLAUSE_RE.exec(text)) !== null) clauses.push({ op: match[1] ?? '=', raw: match[2] });
    clauses = remember(CACHE, text, clauses);
  }
  if (!clauses.length) return false;
  const current = parseVersion(version);
  if (!current) return false;
  return clauses.every((clause) => clauseTest(current, clause.op, clause.raw));
}

export function isVersionRange(range) {
  return typeof range === 'string' && /[0-9*]/.test(range);
}

/** 探测引擎 invalidate() 时一并清理，避免只清目录缓存而留下无界增长的正则/范围缓存。 */
export function clearVersionCaches() {
  PATTERN_CACHE.clear();
  CACHE.clear();
}

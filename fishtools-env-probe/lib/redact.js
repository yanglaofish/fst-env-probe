// 敏感值脱敏：环境报告、JSON 快照与运行日志都可能被分享或提交，
// 代理类变量常带 user:password@，不能原样落盘。
const WITH_SCHEME = /^([a-z][a-z0-9+.-]*:\/\/)[^/@\s]+@/i;
// 无 scheme 的写法只脱敏"含冒号"的形式（说明有密码），避免误伤普通主机名与邮箱样式值。
const BARE_CREDENTIALS = /^[^/@\s:]+:[^/@\s]*@/;

/** 把 http://user:pass@host:8080 变成 http://***@host:8080；其余内容原样保留。 */
export function redactCredentials(value) {
  if (typeof value !== 'string' || !value) return value;
  if (WITH_SCHEME.test(value)) return value.replace(WITH_SCHEME, (_, scheme) => `${scheme}***@`);
  // 盘符路径与 UNC 路径里的 @ 属于目录名（如 C:\Users\john@corp.com），不是凭据。
  if (/^[A-Za-z]:[\\/]/.test(value) || value.startsWith('\\\\')) return value;
  return value.replace(BARE_CREDENTIALS, '***@');
}

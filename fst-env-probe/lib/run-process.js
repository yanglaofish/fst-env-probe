// 内置进程调用回退：仅当插件以共享服务形式被其他插件调用、且调用方未提供 runProcess 时使用。
// 错误码与宿主 runProcess 契约对齐（ENOENT / TIMEOUT / CANCELLED / OUTPUT_LIMIT / SPAWN_FAILED）。
import { execFile } from 'node:child_process';

// execFile 只接受 Node 原生 BufferEncoding；其它编码（gbk 等）先收 Buffer 再用 TextDecoder 解码。
const NATIVE_ENCODINGS = new Set([
  'utf8',
  'utf-8',
  'utf16le',
  'utf-16le',
  'ucs2',
  'latin1',
  'ascii',
  'base64',
  'hex',
]);

function decode(value, nativeEncoding, textEncoding) {
  if (value === null || value === undefined) return '';
  if (nativeEncoding) return Buffer.isBuffer(value) ? value.toString(nativeEncoding) : String(value);
  try {
    return new TextDecoder(textEncoding).decode(value);
  } catch {
    return Buffer.isBuffer(value) ? value.toString('utf8') : String(value);
  }
}

export function createFallbackRunProcess() {
  return (file, args = [], options = {}) =>
    new Promise((resolve, reject) => {
      const { cwd, env, signal, timeout = 30000, maxBuffer = 4 * 1024 * 1024, encoding = 'utf8' } = options;
      if (signal?.aborted) {
        reject(Object.assign(new Error('操作已取消'), { code: 'CANCELLED' }));
        return;
      }
      const requested = String(encoding || 'utf8');
      const nativeEncoding = NATIVE_ENCODINGS.has(requested.toLowerCase()) ? requested : null;
      execFile(
        file,
        args,
        {
          cwd,
          env: env ? { ...process.env, ...env } : process.env,
          timeout,
          maxBuffer,
          windowsHide: true,
          encoding: nativeEncoding ?? 'buffer',
          signal,
        },
        (error, stdout, stderr) => {
          const out = decode(stdout, nativeEncoding, requested);
          const err = decode(stderr, nativeEncoding, requested);
          if (!error) {
            resolve({ exitCode: 0, stdout: out, stderr: err });
            return;
          }
          if (error.name === 'AbortError') {
            reject(Object.assign(new Error('操作已取消'), { code: 'CANCELLED' }));
            return;
          }
          if (error.code === 'ERR_CHILD_PROCESS_STDIO_MAXBUFFER') {
            reject(Object.assign(new Error('程序输出超过上限'), { code: 'OUTPUT_LIMIT' }));
            return;
          }
          // timeout 触发时 execFile 会 kill 并带上 signal，与宿主语义一致。
          if (error.killed || error.signal) {
            reject(Object.assign(new Error('程序运行超时'), { code: 'TIMEOUT' }));
            return;
          }
          if (typeof error.code === 'number') {
            resolve({ exitCode: error.code, stdout: out, stderr: err });
            return;
          }
          if (error.code === 'ENOENT') {
            reject(
              Object.assign(new Error(`未找到程序：${file}`), { code: 'ENOENT', details: { executable: file } }),
            );
            return;
          }
          reject(
            Object.assign(new Error(`无法启动程序 ${file}：${error.message}`), {
              code: error.code ?? 'SPAWN_FAILED',
              details: { executable: file },
            }),
          );
        },
      );
    });
}

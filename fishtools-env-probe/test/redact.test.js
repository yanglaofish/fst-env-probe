import test from 'node:test';
import assert from 'node:assert/strict';
import { redactCredentials } from '../lib/redact.js';
import { collectEnv } from '../lib/groups/system.js';

test('redactCredentials 抹掉代理地址里的凭据', () => {
  assert.equal(redactCredentials('http://user:pass@proxy:8080'), 'http://***@proxy:8080');
  assert.equal(redactCredentials('https://u:p@h:443/'), 'https://***@h:443/');
  assert.equal(redactCredentials('socks5://user:secret@127.0.0.1:1080'), 'socks5://***@127.0.0.1:1080');
  assert.equal(redactCredentials('user:pass@proxy:8080'), '***@proxy:8080');
});

test('redactCredentials 不误伤没有凭据的值', () => {
  assert.equal(redactCredentials('http://proxyhk.huawei.com:8080'), 'http://proxyhk.huawei.com:8080');
  assert.equal(redactCredentials('proxyhk.huawei.com:8080'), 'proxyhk.huawei.com:8080');
  assert.equal(
    redactCredentials('localhost,127.0.0.1,::1,*.huawei.com'),
    'localhost,127.0.0.1,::1,*.huawei.com',
  );
  // 域账户的用户目录里带 @，这是路径不是凭据
  assert.equal(redactCredentials('C:\\Users\\john@corp.com'), 'C:\\Users\\john@corp.com');
  assert.equal(redactCredentials('C:\\Users\\a@b\\Temp'), 'C:\\Users\\a@b\\Temp');
  assert.equal(redactCredentials('\\\\server\\share@x\\dir'), '\\\\server\\share@x\\dir');
  assert.equal(redactCredentials(''), '');
  assert.equal(redactCredentials(undefined), undefined);
});

test('collectEnv 只脱敏敏感值，其余变量原样保留', () => {
  const env = collectEnv(
    {
      PATH: '/a:/b',
      HTTP_PROXY: 'http://u:p@proxy:8080',
      HTTPS_PROXY: 'http://proxy:8080',
      ALL_PROXY: 'socks5://u:p@127.0.0.1:1080',
      JAVA_HOME: '/jdk',
      CONDA_PREFIX: '/opt/conda',
    },
    'linux',
  );
  assert.equal(env.selected.HTTP_PROXY, 'http://***@proxy:8080');
  assert.equal(env.selected.HTTPS_PROXY, 'http://proxy:8080');
  assert.equal(env.selected.ALL_PROXY, 'socks5://***@127.0.0.1:1080');
  assert.equal(env.selected.JAVA_HOME, '/jdk');
  assert.equal(env.selected.CONDA_PREFIX, '/opt/conda');
  assert.equal(env.selected.PATH, '/a:/b');
});

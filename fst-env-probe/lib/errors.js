// 独立插件不依赖内部 SDK：这里自带错误类型，字段与宿主 errorRecord 约定一致。
export class EnvProbeError extends Error {
  constructor(message, { code = 'ENVPROBE_FAILED', details, cause } = {}) {
    super(message, { cause });
    this.name = 'EnvProbeError';
    this.code = code;
    this.details = details;
  }
}

export const errors = {
  cancelled: () => new EnvProbeError('操作已取消', { code: 'CANCELLED' }),
  missing: (names, details) =>
    new EnvProbeError(`未找到必需的工具：${names.join('、')}`, {
      code: 'ENVPROBE_MISSING',
      details,
    }),
  badInput: (message, details) =>
    new EnvProbeError(message, { code: 'ENVPROBE_INPUT', details }),
};

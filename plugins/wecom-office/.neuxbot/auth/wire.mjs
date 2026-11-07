import path from 'node:path';

const protocol = 'neuxbot-auth/1';
const keys = ['operationId', 'pluginId', 'versionId', 'digest', 'configurationRevision', 'accountGeneration'];
const invalid = () => { throw Object.assign(new Error('invalid_session'), { code: 'invalid_session' }); };

// 初始化仅冻结宿主上下文，不启动供应商、登录或核验账号。
export function createAuthWire() {
  let context, sessionId, dataDirectory, scopes;
  return {
    get context() { return context; },
    accept(method, params) {
      if (!params || params.protocol !== protocol ||
          keys.slice(0, 4).some(key => typeof params[key] !== 'string' || !params[key] || params[key].length > 4096 || params[key].includes('\0')) ||
          !/^[a-f0-9]{64}$/.test(params.digest) ||
          !Number.isSafeInteger(params.configurationRevision) || params.configurationRevision < 0 ||
          !Number.isSafeInteger(params.accountGeneration) || params.accountGeneration < 0 ||
          typeof params.sessionId !== 'string' || !params.sessionId || params.sessionId.length > 4096 || params.sessionId.includes('\0') ||
          typeof params.dataDirectory !== 'string' || params.dataDirectory.length > 4096 || params.dataDirectory.includes('\0') || !path.isAbsolute(params.dataDirectory) || !Array.isArray(params.scopes) || params.scopes.length > 128 ||
          params.scopes.some(scope => typeof scope !== 'string' || !scope || scope.length > 4096 || scope.includes('\0'))) invalid();
      if (method === 'auth/initialize') {
        if (context) invalid();
        context = Object.freeze(Object.fromEntries(keys.map(key => [key, params[key]])));
        sessionId = params.sessionId; dataDirectory = path.resolve(params.dataDirectory);
        scopes = JSON.stringify([...new Set(params.scopes)].sort());
        return { protocol, context };
      }
      if (!context || keys.some(key => params[key] !== context[key]) || params.sessionId !== sessionId ||
          path.resolve(params.dataDirectory) !== dataDirectory || JSON.stringify([...new Set(params.scopes)].sort()) !== scopes) invalid();
      if (!['auth/start', 'auth/status', 'auth/resolve', 'auth/cancel', 'auth/logout'].includes(method)) invalid();
      return undefined;
    },
  };
}

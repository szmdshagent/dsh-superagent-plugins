/**
 * dsh-token-live —— Host 半。
 *
 * 第一步只做「能加载」：不注册服务、不开路由、不注入依赖。真正的数据来自
 * dsh-plugin-usage 已经提供的 POST /api/usage/query，客户端半直接同源调用。
 */
export const name = 'token-live'
export const inject: string[] = []
export function apply(): void {}

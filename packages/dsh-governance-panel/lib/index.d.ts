import { Context } from "@deepseek-ai/cordis";
/** 必需服务：cordis 见到这个声明才会在 apply 之前把 ctx.webServer 装好。 */
declare const inject: string[];
/** 宿主 Web 服务：只注册一条精确路由。 */
declare module '@deepseek-ai/cordis' {
  interface Context {
    webServer: {
      register(route: {
        kind: 'prefix' | 'exact';
        path: string;
        handler: (req: any, res: any) => unknown;
      }): () => void;
    };
  }
}
declare function apply(ctx: Context): void;
export { apply, inject };
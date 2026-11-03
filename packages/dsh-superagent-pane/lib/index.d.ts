import { Trigger } from "dsh-superagent";
import { Context } from "@deepseek-ai/cordis";
/**
 * 本插件挂接的 Cordis 服务。`orchestrator` 由 dsh-superagent 声明；`webServer` 与 `sessionPersistence` 是
 * DSH 宿主的服务（主包 inject 里同样要求 sessionPersistence，所以它必定存在）。类型在这里自行声明，
 * 不依赖主包 `exports` 未公开的内部类型。
 */
declare module '@deepseek-ai/cordis' {
  interface Context {
    /** dsh-superagent 的 SourceHost：注册 Source 并取得按 kind 划分的上下文。 */
    orchestrator: {
      readonly sources: {
        register(kind: unknown): () => void;
      };
      /** 主 Session 的会话 id（Runtime 公开字段），自愈用。 */
      readonly masterId?: string;
      /** 宿主 Store 的工单集合（Runtime 公开字段），自愈时取活跃工单的 worker 会话。 */
      readonly store?: {
        readonly tickets?: {
          open?: () => readonly {
            sessionId?: string;
          }[];
        };
      };
      context(kind: {
        kind: string;
        health: readonly string[];
      }): {
        receive(trigger: Trigger): string | Promise<string>;
        report(entry: string, health: {
          state: string;
          detail: string;
        }): void;
        /** 源作用域的持久 KV；kv.ts 明确支持外部插件使用普通字符串键。 */
        state: {
          get<V>(key: any): V | undefined;
          set<V>(key: any, value: V | undefined): void;
        };
      };
    };
    /** DSH 工作区的会话注册表；被归档的会话无法运行任何回合，这里用于自愈。 */
    workspaceRegistry: {
      readonly archivedSessionIds: readonly string[];
      unarchiveSession(sessionId: string): Promise<void>;
    };
    /** DSH 的环回 Web 服务；prefix 路由匹配 `path` 以及 `path/<任意>`。 */
    webServer: {
      register(route: {
        kind: 'prefix' | 'exact';
        path: string;
        handler: (req: any, res: any) => unknown;
      }): () => void;
    };
    /** DSH 的会话持久化服务（这里只做只读）：按会话 id 打开事件流，用来显示 worker 当前动作。 */
    sessionPersistence: {
      open(id: string, access: 'read' | 'write'): Promise<{
        read(offset?: number, length?: number): Promise<{
          events: readonly PaneSessionEvent[];
        }>;
        close(): Promise<void>;
      }>;
    };
  }
}
/** 只读消费的会话事件形状；只关心 `type`/`time`/`data`，其余字段不理会。 */
type PaneSessionEvent = {
  type?: string;
  time?: number;
  data?: any;
};
declare const name = "dsh-superagent-pane";
declare const inject: string[];
/**
 * 构造面板里一条消息的 Trigger。
 *
 * 两种模式对齐引擎语义：
 * - `dispatch`（默认）：`addressed: 'mention'` → 已允许发送者的消息是 explicit，直接建单/追加给工单，权限完整。
 * - `chat`：不带 addressed → 消息按准入表成为 inferred 候选，交给主 Session（router）分诊：它能直接答疑，
 *   或按规则接下小活；不需要工单的问题不会再变成工单。
 *
 * 对话模式刻意走「影子线程」`<对话>~chat`：引擎的 gate 规定「线程有自己的工单时，一律消息归该工单」
 * （followup 分支先于准入表生效），所以只要还在原线程上，对话消息就会被排进运行中工单的队列、router 收不到。
 * 影子线程永不被工单订阅，router 任何时刻都能立刻接话；回复经 channel 地址仍回落到原对话显示。
 */
declare function paneTrigger(conversation: string, text: string, sender?: string, mode?: 'dispatch' | 'chat'): Trigger;
declare function apply(ctx: Context): void;
export { apply, inject, name, paneTrigger };
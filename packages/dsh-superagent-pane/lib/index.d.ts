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
      /** 引擎（Runtime 公开字段）；搁浅消息自愈用 `reevaluate` 重新入队。 */
      readonly engine?: {
        reevaluate(triggerId: string): boolean;
      };
      /** 宿主 Store（Runtime 公开字段），自愈与分流判断用。 */
      readonly store?: {
        readonly tickets?: {
          open?: () => readonly {
            id?: string;
            sessionId?: string;
            ended?: unknown;
          }[];
          get?(id: string): any;
        };
        readonly threads?: {
          get?(key: string): any;
        };
        readonly triggers?: {
          get?(id: string): any;
          disposition?(id: string): any;
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
          keys(prefix: string): string[];
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
 * - `assign`（派活，默认）：`addressed: 'mention'` → 已允许发送者的消息是 explicit。**新建工单还是跟进已有工单，
 *   由路由器按内容自己判断**（2026-11-11 合并：原来拆成「路由器分配」「worker 续做」两档，太麻烦，
 *   改由路由器一次决定）。正文不再附加「必须新建」或「必须 attach」的约束，只说明这张卡片的性质。
 * - `chat`（只对话）：**也带 addressed 走 explicit**，附「只回答、不建单」约束。
 *   以前用 inferred 让路由器分诊，但 `eval.mode=auto` 下路由器一旦匹配到规则就会 accept 建单，
 *   于是「对话」其实也会派活；改成 explicit + 正文约束后，建单与否完全由消息里的约束决定。
 *
 * 对话模式刻意走「影子线程」`<对话>~chat`：引擎的 gate 规定「线程有自己的工单时，一律消息归该工单」
 * （followup 分支先于准入表生效），所以只要还在原线程上，对话消息就会被排进运行中工单的队列、router 收不到。
 * 影子线程永不被工单订阅，router 任何时刻都能立刻接话；回复经 channel 地址仍回落到原对话显示。
 *
 * 派活模式**只在会话线程上的工单已卡死（zombie，永远接不了手）时**才走一条子线程（`<对话>~d<base36>`，
 * 由调用方通过 `options.thread` 指定）：死工单仍占着订阅，fanout 会把消息并进去，而 intake 又因为
 * followupOwners 非空永不排 Eval，这条消息就永远搁浅（2026-11-03 的 897f223d… 即此）。子线程上没有订阅者，
 * 消息会进 Eval 由主 Session 分诊（可 attach 也可新建工单）。健康/待命的工单不触发改投：它对运行中工单的
 * 正常跟进必须留在原线程，交给该工单的 worker 处理，否则会另起新工单、原工单永远收不到跟进。
 * 无论走哪条线程，`channel` 始终指回原会话，回复仍显示在原对话里。
 */
/** 面板模式的内部取值。`note` 只给工单意见会话用：正文自带前缀，不再叠加模式约束。 */
type PaneMode = 'assign' | 'chat' | 'note' | 'broadcast';
declare function paneTrigger(conversation: string, text: string, sender?: string, mode?: PaneMode, options?: {
  thread?: string;
}): Trigger;
declare function apply(ctx: Context): void;
export { PaneMode, apply, inject, name, paneTrigger };
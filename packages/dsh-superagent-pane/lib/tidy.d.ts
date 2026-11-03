declare const name = "dsh-superagent-pane-tidy";
declare const inject: string[];
type Config = {
  pollMs?: number;
  removeDirectories?: boolean;
};
declare function apply(ctx: any, config?: Config): void;
export { apply, inject, name };
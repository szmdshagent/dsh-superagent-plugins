import { a as readTeamPlan, i as listTeamLanes, n as isValidLaneName, o as teamStatus, r as laneDir, t as installWorkerGuard } from "./guard-C6Yt-xRB.js";
// src/guard-entry.ts
const name = "dsh-superagent-pane-guard";
const inject = ["tools"];
/**
* 装上硬限制守卫。
*
* `inject` 里声明 `tools` 而不是在 apply 里自己 inject：Cordis 会在该服务就绪时才调用 apply，
* 服务缺失时这一条会显示为 pending，一眼能看出守卫没生效——这比静默降级安全。
*/
function apply(ctx) {
	installWorkerGuard(ctx);
}
export { apply, inject, isValidLaneName, laneDir, listTeamLanes, name, readTeamPlan, teamStatus };

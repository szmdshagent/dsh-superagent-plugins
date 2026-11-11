/** 一个对话一份 KV 记录；外部插件用纯字符串键，kv.ts 已说明这是允许的。 */
const logKey = (conversation) => `pane-log:${conversation}`;
/** 读出某对话的全部条目；没有记录时返回空数组。 */
function readLog(source, conversation) {
	const stored = source?.state?.get(logKey(conversation));
	return Array.isArray(stored) ? stored : [];
}
/**
* 先按条数截断，再按字符预算从最旧丢弃：一条超长消息不至于把整个对话挤掉，一份记录也不会无限增长。
*/
function trimLog(entries) {
	const kept = entries.slice(-2e3);
	let used = 0;
	let start = kept.length;
	for (let index = kept.length - 1; index >= 0; index -= 1) {
		used += (kept[index]?.text?.length ?? 0) + 96;
		if (used > 4e5) break;
		start = index;
	}
	return kept.slice(start);
}
/** 追加一条；同一个 id 再写会替换原条目而不是重复（域内重试会重复投递回执）。 */
function appendLog(source, conversation, entry) {
	if (!source?.state || typeof conversation !== "string" || !conversation) return;
	const next = trimLog([...readLog(source, conversation).filter((item) => item.id !== entry.id), entry]);
	source.state.set(logKey(conversation), next);
}
export { logKey as n, readLog as r, appendLog as t };

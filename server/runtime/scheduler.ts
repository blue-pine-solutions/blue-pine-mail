import { runScheduledDatabaseBackup } from "@/lib/backups/runner";
import { runAgentMaintenance } from "@/lib/agent/maintenance";
import { runCanonicalMessageMaintenance } from "@/lib/email/canonical-message";

/** Fire the daily 02:00 UTC backup, matching the cron trigger in wrangler.jsonc. */
export function startScheduler(env: CloudflareEnv) {
	let lastRunDay = "";
	const timer = setInterval(() => {
		runAgentMaintenance(env).catch((error) => console.error("Agent maintenance failed", error));
		runCanonicalMessageMaintenance(env).catch((error) => console.error("Canonical message maintenance failed", error));
		const now = new Date();
		const day = now.toISOString().slice(0, 10);
		if (now.getUTCHours() !== 2 || lastRunDay === day) return;
		lastRunDay = day;
		runScheduledDatabaseBackup(env, now).catch((error) => console.error("Scheduled backup failed", error));
	}, 60_000);
	return () => clearInterval(timer);
}

/**
 * Censor Cloud — runner → Firebase proxy client.
 *
 * Reports stage progress, streams (scrubbed) log lines, stores results and
 * polls for cancellation/approval. Every operation is best-effort: a proxy
 * outage must never fail the coding task — GitHub issue labels + commits
 * remain the fallback record.
 *
 * Auth = per-user runner key stored in the runner repo's Actions secrets and
 * hash-verified by the `ghRunnerUpdate` Cloud Function. The key is never
 * echoed, never written to logs, and never sent anywhere except the proxy.
 */

import { scrubSensitive } from "./scrub";

export interface Checkpoint {
	status: string;
	cancelled: boolean;
	approved: boolean;
}

export interface LogLine {
	level?: "info" | "warn" | "error";
	msg: string;
}

export interface CloudReporterOptions {
	url?: string;
	key?: string;
	fetchImpl?: typeof fetch;
	flushMs?: number;
	maxBufferedLogs?: number;
	now?: () => number;
	sleep?: (ms: number) => Promise<void>;
}

const NEUTRAL: Checkpoint = { status: "unknown", cancelled: false, approved: false };
const MAX_BUFFER = 100;
const FLUSH_MS = 5_000;
const REQUEST_TIMEOUT_MS = 10_000;

function defaultSleep(ms: number): Promise<void> {
	return new Promise((resolve) => setTimeout(resolve, ms));
}

export class CloudReporter {
	private readonly enabled: boolean;
	private readonly url: string;
	private readonly key: string;
	private readonly fetchImpl: typeof fetch;
	private readonly maxBuffer: number;
	private readonly sleep: (ms: number) => Promise<void>;
	private queue: LogLine[] = [];
	private timer?: ReturnType<typeof setInterval>;
	private broken = false;

	constructor(
		private readonly taskId: string | undefined,
		options: CloudReporterOptions = {},
	) {
		this.url = (options.url ?? "").trim().replace(/\/+$/, "");
		this.key = (options.key ?? "").trim();
		this.enabled = Boolean(this.taskId && this.url && this.key);
		this.fetchImpl = options.fetchImpl ?? fetch;
		this.maxBuffer = options.maxBufferedLogs ?? MAX_BUFFER;
		this.sleep = options.sleep ?? defaultSleep;
		if (this.enabled) {
			this.timer = setInterval(() => void this.flush(), options.flushMs ?? FLUSH_MS);
			// The timer must not keep the CLI alive after the task finishes.
			this.timer?.unref?.();
		}
	}

	get active(): boolean {
		return this.enabled && !this.broken;
	}

	/** Stop the background flusher and send whatever is left. */
	async dispose(): Promise<void> {
		if (this.timer) clearInterval(this.timer);
		this.timer = undefined;
		await this.flush();
	}

	private disable(reason: string): void {
		if (!this.broken) {
			console.error(`[censor] cloud reporting disabled: ${scrubSensitive(reason)}`);
		}
		this.broken = true;
		this.queue = [];
		if (this.timer) clearInterval(this.timer);
		this.timer = undefined;
	}

	private async send(body: Record<string, unknown>): Promise<Checkpoint | undefined> {
		if (!this.active || !this.taskId) return undefined;
		let lastError = "";
		for (let attempt = 0; attempt < 3; attempt++) {
			try {
				const response = await this.fetchImpl(this.url, {
					method: "POST",
					headers: {
						"content-type": "application/json",
						"x-censor-runner-key": this.key,
					},
					body: JSON.stringify({ data: { taskId: this.taskId, ...body } }),
					signal: AbortSignal.timeout(REQUEST_TIMEOUT_MS),
				});
				if (response.status === 401 || response.status === 403 || response.status === 404) {
					this.disable(`proxy rejected the runner key (HTTP ${response.status}) — check CENSOR_RUNNER_KEY`);
					return undefined;
				}
				if (!response.ok) {
					lastError = `HTTP ${response.status}`;
				} else {
					const json = (await response.json().catch(() => undefined)) as
						| { result?: Checkpoint; error?: { message?: string } }
						| undefined;
					if (json?.error) {
						this.disable(json.error.message ?? "proxy returned an error");
						return undefined;
					}
					const result = json?.result;
					return {
						status: String(result?.status ?? "unknown"),
						cancelled: Boolean(result?.cancelled),
						approved: Boolean(result?.approved),
					};
				}
			} catch (error) {
				lastError = error instanceof Error ? error.message : String(error);
			}
			if (attempt < 2) await this.sleep(500 * (attempt + 1));
		}
		// Outages are non-fatal; log once, keep the local queue bounded.
		console.error(`[censor] cloud proxy unreachable (${scrubSensitive(lastError)}); continuing without live status`);
		this.queue = this.queue.slice(-this.maxBuffer);
		return undefined;
	}

	/** Update the task record. Returns the current server-side checkpoint. */
	async patch(patch: Record<string, unknown>): Promise<Checkpoint> {
		return (await this.send({ patch })) ?? NEUTRAL;
	}

	/** Poll for cancellation / approval (and heartbeat the runner's liveness). */
	async checkpoint(): Promise<Checkpoint> {
		return await this.patch({});
	}

	/** Report a stage transition with progress percentage. */
	async stage(stage: string, message?: string, percent?: number): Promise<Checkpoint> {
		return await this.patch({
			progress: {
				stage,
				...(message ? { message: scrubSensitive(message).slice(0, 500) } : {}),
				...(typeof percent === "number" ? { percent } : {}),
			},
		});
	}

	/** Queue a log line; a background timer flushes it to Firestore. */
	line(msg: string, level: LogLine["level"] = "info"): void {
		if (!this.active || !msg.trim()) return;
		this.queue.push({ level, msg: scrubSensitive(msg).slice(0, 4000) });
		if (this.queue.length > this.maxBuffer) {
			this.queue = this.queue.slice(this.queue.length - this.maxBuffer);
		}
	}

	/** Queue several lines at once. */
	lines(entries: LogLine[]): void {
		for (const entry of entries) this.line(entry.msg, entry.level);
	}

	/** Send queued lines now (also called by the background timer). */
	async flush(): Promise<void> {
		if (!this.active || this.queue.length === 0) return;
		const batch = this.queue;
		this.queue = [];
		await this.send({ logs: batch });
	}

	/** Mark the task finished and flush logs before teardown. */
	async finish(
		status: "completed" | "failed" | "cancelled",
		result?: Record<string, unknown>,
		error?: { stage?: string; message: string },
	): Promise<void> {
		await this.patch({
			status,
			progress: {
				stage: status,
				message: status === "completed" ? "Task finished" : status === "cancelled" ? "Cancelled" : "Task failed",
				percent: status === "completed" ? 100 : undefined,
			},
			...(result ? { result } : {}),
			...(error
				? { error: { stage: error.stage ?? "runner", message: scrubSensitive(error.message).slice(0, 4000) } }
				: {}),
		});
		await this.flush();
	}
}

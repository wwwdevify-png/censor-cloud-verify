/**
 * Task model — the GitHub issue is the queue transport; Firestore
 * (`cloudTasks/{taskId}` via the Firebase proxy) is the system of record.
 *
 * Issue body = pretty-printed JSON written by the Firebase proxy:
 *
 *   {
 *     "censor": 1,
 *     "prompt": "Add a health endpoint and tests",
 *     "repo": "owner/target-repo",
 *     "taskId": "<firestore task id>",
 *     "baseBranch": "main",       // optional; default: repo default branch
 *     "timeoutSeconds": 1800,     // optional; capped at 6h
 *     "model": "...",             // optional provider/model overrides
 *     "workflows": ["auto"],      // optional GitHub Actions to dispatch
 *     "createPr": true,           // optional (default true)
 *     "autoRepair": true,         // optional (default true)
 *     "approval": "none"          // or "before_push"
 *   }
 *
 * Labels carry the transport state machine:
 *   censor-task          marker (required)
 *   censor:queued        waiting for a runner slot
 *   censor:running       claimed; a workflow run is executing
 *   censor:waiting       runner paused for user approval
 *   censor:done          agent committed + pushed branch censor/<issue#>
 *   censor:failed        agent/push failed (see issue comments)
 *   censor:cancelled     user cancelled the task
 *
 * The richer status/progress/logs live in Firestore, updated by the runner
 * through the `ghRunnerUpdate` proxy endpoint.
 */

export const TASK_MARKER_LABEL = "censor-task";
export const STATE_QUEUED = "censor:queued";
export const STATE_RUNNING = "censor:running";
export const STATE_WAITING = "censor:waiting";
export const STATE_DONE = "censor:done";
export const STATE_FAILED = "censor:failed";
export const STATE_CANCELLED = "censor:cancelled";

export const STATE_LABELS = [
	STATE_QUEUED,
	STATE_RUNNING,
	STATE_WAITING,
	STATE_DONE,
	STATE_FAILED,
	STATE_CANCELLED,
] as const;
export type TaskStateLabel = (typeof STATE_LABELS)[number];

export interface TaskSpec {
	censor: 1;
	prompt: string;
	/** owner/name of the repository the agent will modify. */
	repo: string;
	/** Firestore task id (new tasks submitted through the Firebase proxy). */
	taskId?: string;
	baseBranch?: string;
	timeoutSeconds?: number;
	/** Optional model/provider overrides; fall back to runner defaults. */
	model?: string;
	provider?: string;
	/** Workflow file names to dispatch after the push, or ["auto"]. */
	workflows?: string[];
	/** Create a pull request from the task branch (default true). */
	createPr?: boolean;
	/** Re-run the agent once with CI failure logs (default true). */
	autoRepair?: boolean;
	/** "before_push" parks the runner in waiting_approval before pushing. */
	approval?: "none" | "before_push";
}

export function serializeTaskSpec(spec: TaskSpec): string {
	return JSON.stringify(spec, null, 2);
}

export function parseTaskSpec(body: string | null): TaskSpec | undefined {
	if (!body?.trim()) return undefined;
	const candidates = extractJsonObjects(body);
	for (const candidate of candidates) {
		try {
			const parsed = JSON.parse(candidate) as Partial<TaskSpec>;
			if (
				parsed &&
				parsed.censor === 1 &&
				typeof parsed.prompt === "string" &&
				parsed.prompt.trim().length >= 3 &&
				typeof parsed.repo === "string" &&
				/^[\w][\w.-]*\/[\w][\w.-]*$/.test(parsed.repo.trim())
			) {
				const workflows = Array.isArray(parsed.workflows)
					? parsed.workflows.map((w) => String(w).trim()).filter(Boolean).slice(0, 10)
					: undefined;
				return {
					censor: 1,
					prompt: parsed.prompt.trim(),
					repo: parsed.repo.trim(),
					...(typeof parsed.taskId === "string" && /^[\w-]{1,80}$/.test(parsed.taskId)
						? { taskId: parsed.taskId }
						: {}),
					...(typeof parsed.baseBranch === "string" && parsed.baseBranch.trim()
						? { baseBranch: parsed.baseBranch.trim() }
						: {}),
					...(typeof parsed.timeoutSeconds === "number" &&
					Number.isFinite(parsed.timeoutSeconds)
						? {
								timeoutSeconds: Math.min(
									Math.max(Math.floor(parsed.timeoutSeconds), 60),
									6 * 3600,
								),
							}
						: {}),
					...(typeof parsed.model === "string" && parsed.model.trim()
						? { model: parsed.model.trim() }
						: {}),
					...(typeof parsed.provider === "string" && parsed.provider.trim()
						? { provider: parsed.provider.trim() }
						: {}),
					...(workflows?.length ? { workflows } : {}),
					...(typeof parsed.createPr === "boolean" ? { createPr: parsed.createPr } : {}),
					...(typeof parsed.autoRepair === "boolean" ? { autoRepair: parsed.autoRepair } : {}),
					...(parsed.approval === "before_push" ? { approval: "before_push" } : {}),
				};
			}
		} catch {
			// not this candidate
		}
	}
	return undefined;
}

/** Extract candidate JSON objects from a body: raw JSON or ```json fences. */
function extractJsonObjects(body: string): string[] {
	const out: string[] = [];
	const trimmed = body.trim();
	if (trimmed.startsWith("{")) out.push(trimmed);
	const fence = /```(?:json)?\s*\n([\s\S]*?)```/g;
	for (const match of trimmed.matchAll(fence)) {
		if (match[1]?.trim().startsWith("{")) out.push(match[1].trim());
	}
	// last resort: any balanced-ish { … } block containing "censor"
	const idx = trimmed.indexOf('"censor"');
	if (idx >= 0) {
		const start = trimmed.lastIndexOf("{", idx);
		const end = trimmed.indexOf("}", idx);
		if (start >= 0 && end > start) out.push(trimmed.slice(start, end + 1));
	}
	return out;
}

export function taskBranchName(issueNumber: number): string {
	return `censor/${issueNumber}`;
}

export function taskStateLabels(labels: Array<{ name: string }>): TaskStateLabel[] {
	const names = new Set(labels.map((l) => l.name));
	return STATE_LABELS.filter((l) => names.has(l));
}

export function taskStateOf(labels: Array<{ name: string }>): TaskStateLabel {
	const states = taskStateLabels(labels);
	// priority: done > failed > cancelled > running > waiting > queued
	if (states.includes(STATE_DONE)) return STATE_DONE;
	if (states.includes(STATE_FAILED)) return STATE_FAILED;
	if (states.includes(STATE_CANCELLED)) return STATE_CANCELLED;
	if (states.includes(STATE_RUNNING)) return STATE_RUNNING;
	if (states.includes(STATE_WAITING)) return STATE_WAITING;
	return STATE_QUEUED;
}

/**
 * Minimal GitHub REST client for Censor Cloud (GitHub Actions edition).
 * fetch-only, no dependencies, never logs tokens.
 */
const API = "https://api.github.com";

export interface GitHubClientConfig {
	token: string;
	/** Owner/name of the runner repo, e.g. "octocat/censor-actions". */
	repository: string;
}

export class GitHubError extends Error {
	readonly status: number;
	constructor(message: string, status: number) {
		super(message);
		this.name = "GitHubError";
		this.status = status;
	}
}

export class GitHubClient {
	constructor(private readonly config: GitHubClientConfig) {}

	private async request<T>(
		method: string,
		path: string,
		body?: unknown,
	): Promise<T> {
		const response = await fetch(`${API}${path}`, {
			method,
			headers: {
				Accept: "application/vnd.github+json",
				Authorization: `Bearer ${this.config.token}`,
				"X-GitHub-Api-Version": "2022-11-28",
				"User-Agent": "censor-actions",
				...(body !== undefined ? { "Content-Type": "application/json" } : {}),
			},
			...(body !== undefined ? { body: JSON.stringify(body) } : {}),
			signal: AbortSignal.timeout(30_000),
		});
		const text = await response.text();
		const payload = text ? safeJson(text) : undefined;
		if (!response.ok) {
			const message =
				(payload as { message?: string } | undefined)?.message ??
				`GitHub API ${method} ${path} failed (HTTP ${response.status})`;
			throw new GitHubError(message, response.status);
		}
		return payload as T;
	}

	// ---------------- issues (task store) -----------------------------------

	async getIssue(number: number) {
		return this.request<Issue>(
			"GET",
			`/repos/${this.config.repository}/issues/${number}`,
		);
	}

	async listIssues(opts: { labels?: string[]; state?: "open" | "closed"; perPage?: number }) {
		const params = new URLSearchParams({
			state: opts.state ?? "open",
			per_page: String(opts.perPage ?? 50),
			...(opts.labels?.length ? { labels: opts.labels.join(",") } : {}),
		});
		return this.request<Issue[]>(
			"GET",
			`/repos/${this.config.repository}/issues?${params}`,
		);
	}

	async createIssue(input: {
		title: string;
		body: string;
		labels: string[];
	}) {
		return this.request<Issue>("POST", `/repos/${this.config.repository}/issues`, input);
	}

	async addLabels(issueNumber: number, labels: string[]) {
		// idempotent add; GitHub dedupes
		return this.request<Issue>(
			"POST",
			`/repos/${this.config.repository}/issues/${issueNumber}/labels`,
			{ labels },
		);
	}

	async removeLabel(issueNumber: number, label: string) {
		const url = `/repos/${this.config.repository}/issues/${issueNumber}/labels/${encodeURIComponent(label)}`;
		const response = await fetch(`${API}${url}`, {
			method: "DELETE",
			headers: {
				Authorization: `Bearer ${this.config.token}`,
				"X-GitHub-Api-Version": "2022-11-28",
				"User-Agent": "censor-actions",
			},
		});
		if (!response.ok && response.status !== 404) {
			throw new GitHubError(`removeLabel ${label} failed (HTTP ${response.status})`, response.status);
		}
	}

	async setState(issueNumber: number, state: "open" | "closed") {
		return this.request<Issue>(
			"PATCH",
			`/repos/${this.config.repository}/issues/${issueNumber}`,
			{ state },
		);
	}

	async createComment(issueNumber: number, body: string) {
		return this.request<Comment>(
			"POST",
			`/repos/${this.config.repository}/issues/${issueNumber}/comments`,
			{ body },
		);
	}

	async listComments(issueNumber: number) {
		return this.request<Comment[]>(
			"GET",
			`/repos/${this.config.repository}/issues/${issueNumber}/comments?per_page=100`,
		);
	}

	/** Default branch of a target repository (for PR base). */
	async defaultBranch(targetRepo: string): Promise<string> {
		const repo = await this.request<{ default_branch?: string }>(
			"GET",
			`/repos/${targetRepo}`,
		);
		return repo.default_branch?.trim() || "main";
	}

	/** Fetch per-file patches of a same-repo compare (base...head). */
	async compareDiff(
		targetRepo: string,
		base: string,
		head: string,
	): Promise<{ files: CompareFile[]; behindBy: number; totalCommits: number }> {
		const payload = await this.request<{
			files?: Array<{
				filename?: string;
				status?: string;
				patch?: string;
				additions?: number;
				deletions?: number;
			}>;
			behind_by?: number;
			total_commits?: number;
		}>(
			"GET",
			`/repos/${targetRepo}/compare/${encodeURIComponent(base)}...${encodeURIComponent(head)}`,
		);
		return {
			files: (payload.files ?? []).flatMap((file) =>
				file.filename
					? [{
							filename: file.filename,
							status: (file.status ?? "modified") as CompareFile["status"],
							patch: file.patch,
							additions: file.additions,
							deletions: file.deletions,
						}]
					: [],
			),
			behindBy: payload.behind_by ?? 0,
			totalCommits: payload.total_commits ?? 0,
		};
	}

	async workflowRunsForBranch(targetRepo: string, branch: string, event?: string) {
		const params = new URLSearchParams({
			branch,
			per_page: "20",
			...(event ? { event } : {}),
		});
		return this.request<{ workflow_runs: WorkflowRun[] }>(
			"GET",
			`/repos/${targetRepo}/actions/runs?${params}`,
		).then((r) => r.workflow_runs);
	}

	/** Workflows available in the target repo (for authorized dispatch). */
	async listWorkflows(targetRepo: string) {
		const payload = await this.request<{ workflows?: WorkflowDefinition[] }>(
			"GET",
			`/repos/${targetRepo}/actions/workflows?per_page=50`,
		);
		return payload.workflows ?? [];
	}

	/** Trigger one authorized workflow on the task branch. */
	async dispatchWorkflow(targetRepo: string, workflow: string, ref: string) {
		// The GitHub API accepts either the workflow file name (e.g. "ci.yml")
		// or its numeric id.
		await this.request<void>(
			"POST",
			`/repos/${targetRepo}/actions/workflows/${encodeURIComponent(workflow)}/dispatches`,
			{ ref },
		);
	}

	/** Jobs + step conclusions of a workflow run (used for failure analysis). */
	async runJobs(targetRepo: string, runId: number) {
		const payload = await this.request<{ jobs?: WorkflowJob[] }>(
			"GET",
			`/repos/${targetRepo}/actions/runs/${runId}/jobs?per_page=50`,
		);
		return payload.jobs ?? [];
	}

	/** Create (or reuse) a PR for the task branch. */
	async createPullRequest(
		targetRepo: string,
		input: { title: string; head: string; base: string; body: string },
	): Promise<{ number: number; html_url: string }> {
		try {
			return await this.request<{ number: number; html_url: string }>(
				"POST",
				`/repos/${targetRepo}/pulls`,
				input,
			);
		} catch (error) {
			// 422 = validation failed, commonly "a pull request already exists".
			if (error instanceof GitHubError && error.status === 422) {
				const owner = targetRepo.split("/")[0];
				const params = new URLSearchParams({
					head: `${owner}:${input.head}`,
					base: input.base,
					state: "open",
				});
				const existing = await this.request<Array<{ number: number; html_url: string }>>(
					"GET",
					`/repos/${targetRepo}/pulls?${params}`,
				);
				if (existing[0]) return existing[0];
			}
			throw error;
		}
	}

	async runLogs(targetRepo: string, runId: number): Promise<string | undefined> {
		const response = await fetch(
			`${API}/repos/${targetRepo}/actions/runs/${runId}/logs`,
			{
				headers: {
					Authorization: `Bearer ${this.config.token}`,
					"X-GitHub-Api-Version": "2022-11-28",
					"User-Agent": "censor-actions",
				},
				redirect: "follow",
			},
		);
		if (!response.ok) return undefined;
		return response.text();
	}
}

export interface Issue {
	number: number;
	title: string;
	body: string | null;
	state: "open" | "closed";
	labels: Array<{ name: string }>;
	created_at: string;
	comments: number;
	user?: { login?: string };
}

export interface Comment {
	id: number;
	body?: string;
	user?: { login?: string };
	created_at: string;
}

export interface CompareFile {
	filename: string;
	status: "added" | "modified" | "removed" | "renamed";
	patch?: string;
	additions?: number;
	deletions?: number;
}

export interface WorkflowRun {
	id: number;
	name: string;
	status: "queued" | "in_progress" | "completed";
	conclusion: string | null;
	updated_at: string;
	created_at?: string;
	event?: string;
	html_url: string;
}

export interface WorkflowDefinition {
	id: number;
	name: string;
	path: string;
	state: string;
}

export interface WorkflowJob {
	id: number;
	name: string;
	status: string;
	conclusion: string | null;
	steps?: Array<{ name: string; status: string; conclusion: string | null }>;
	html_url?: string;
}

function safeJson(text: string): unknown {
	try {
		return JSON.parse(text);
	} catch {
		return undefined;
	}
}

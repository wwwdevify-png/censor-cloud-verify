/**
 * Censor Cloud (GitHub Actions) — single-task runner.
 *
 * Invoked by .github/workflows/censor-agent.yml with:
 *   bun run runner/run-task.ts --issue <n>
 *
 * Required env:
 *   GITHUB_TOKEN            — token with repo scope (push branch + comment)
 *   CENSOR_REPOSITORY       — clone URL of the Censor monorepo (agent source)
 *   CENSOR_REF              — git ref of the Censor monorepo (default: main)
 *
 * Optional env:
 *   TARGET_TOKEN            — PAT to clone/push target repos (if different)
 *   CENSOR_MODEL            — model override passed to the agent
 *   CENSOR_CLOUD_PROXY_URL  — Firebase proxy base URL (live progress/results)
 *   CENSOR_RUNNER_KEY       — per-user runner secret (proxy authentication)
 *   CENSOR_AGENT_MODE       — "source" (default: clone monorepo) | "npm"
 *   CENSOR_AGENT_BIN        — CLI binary for npm mode (default: censor)
 *   GITHUB_SERVER_URL       — GHES base URL (default https://github.com)
 *
 * The GitHub issue remains the queue transport (labels/branch/comments).
 * The Firebase proxy (`cloudTasks/{taskId}`) is the system of record for
 * progress, logs, approval, results and GitHub Actions checks. Reporting is
 * best-effort: a proxy outage never fails the coding task.
 */
import { execFile, spawn } from "node:child_process";
import { mkdir, rm, writeFile } from "node:fs/promises";
import { join, dirname } from "node:path";
import { promisify } from "node:util";
import { homedir } from "node:os";
import { scrubSensitive } from "./scrub";
import { CloudReporter, type Checkpoint } from "./cloud";
import {
	parseTaskSpec,
	taskBranchName,
	STATE_QUEUED,
	STATE_RUNNING,
	STATE_DONE,
	STATE_FAILED,
	STATE_WAITING,
	STATE_CANCELLED,
	TASK_MARKER_LABEL,
	type TaskSpec,
} from "./task.ts";

const exec = promisify(execFile);
const sleep = (ms: number) => new Promise<void>((resolve) => setTimeout(resolve, ms));

const args = process.argv.slice(2);
const arg = (name: string): string | undefined => {
	const idx = args.indexOf(`--${name}`);
	return idx >= 0 ? args[idx + 1] : undefined;
};
const issueNumber = Number(arg("issue"));
if (!Number.isInteger(issueNumber) || issueNumber <= 0) {
	console.error("usage: run-task.ts --issue <number>");
	process.exit(64);
}

const env = process.env;
const SERVER = env.GITHUB_SERVER_URL ?? "https://github.com";
const REPO_FULL = env.GITHUB_REPOSITORY ?? ""; // owner/name of runner repo
const TOKEN = env.TARGET_TOKEN?.trim() || env.GITHUB_TOKEN?.trim();
const CENSOR_REPOSITORY = env.CENSOR_REPOSITORY?.trim();
if (!TOKEN) throw new Error("GITHUB_TOKEN (or TARGET_TOKEN) is required");
if (!REPO_FULL) throw new Error("GITHUB_REPOSITORY is required");
if (!CENSOR_REPOSITORY && (env.CENSOR_AGENT_MODE ?? "source") !== "npm") {
	throw new Error("CENSOR_REPOSITORY is required (clone URL of the Censor monorepo)");
}
const CENSOR_REF = env.CENSOR_REF?.trim() || "main";
const MONO_TOKEN = env.CENSOR_MONO_TOKEN?.trim();
const AGENT_MODE = env.CENSOR_AGENT_MODE?.trim() === "npm" ? "npm" : "source";
const AGENT_BIN = env.CENSOR_AGENT_BIN?.trim() || "censor";
// Provider auth: either CENSOR_OAUTH_JSON_B64 (the user's signed-in Censor
// subscription — zero new keys) or a static provider key in the environment.
const OAUTH_JSON_B64 = env.CENSOR_OAUTH_JSON_B64?.trim()?.replace(/\s/g, "");

// Work on RUNNER_TEMP (outside the checked-out runner repo) so the target
// repo never looks like part of it to the agent. Fall back to cwd locally.
const WORKDIR = process.env.RUNNER_TEMP?.trim() || process.cwd();
const TARGET_DIR = join(WORKDIR, "target");
const CENSOR_DIR = join(WORKDIR, "censor");
const LOG_TAIL: string[] = [];
const MAX_TAIL = 4000;

const { GitHubClient } = await import("./github.ts");
const gh = new GitHubClient({ token: TOKEN!, repository: REPO_FULL });

/** Best-effort cloud proxy reporter (disabled if not configured). */
let reporter: CloudReporter;

function tailLog(line: string) {
	LOG_TAIL.push(scrubSensitive(line));
	if (LOG_TAIL.length > 200) LOG_TAIL.shift();
}

async function run(
	cwd: string,
	cmd: string,
	cmdArgs: string[],
	timeoutMs = 30 * 60_000,
	extraEnv?: NodeJS.ProcessEnv,
	onLine?: (line: string) => void,
): Promise<{ code: number | null; output: string }> {
	return new Promise((resolvePromise, rejectPromise) => {
		const child = spawn(cmd, cmdArgs, {
			cwd,
			env: { ...process.env, GIT_TERMINAL_PROMPT: "0", ...extraEnv },
			stdio: ["ignore", "pipe", "pipe"],
		});
		const chunks: Buffer[] = [];
		let lastEmit = 0;
		const onData = (chunk: unknown) => {
			const buf = Buffer.isBuffer(chunk) ? chunk : Buffer.from(String(chunk));
			chunks.push(buf);
			const text = scrubSensitive(buf.toString("utf8"));
			for (const line of text.split("\n")) {
				if (!line.trim()) continue;
				tailLog(line);
				// Sample agent output into Firestore: at most one line per ~2s,
				// bounded by the proxy's log caps.
				const now = Date.now();
				if (onLine && now - lastEmit > 2000) {
					lastEmit = now;
					onLine(line);
				}
			}
			const total = chunks.reduce((n, c) => n + c.length, 0);
			if (total > 32 * 1024 * 1024) child.kill("SIGKILL");
		};
		child.stdout?.on("data", onData);
		child.stderr?.on("data", onData);
		const timer = setTimeout(() => child.kill("SIGKILL"), timeoutMs);
		child.on("exit", (code) => {
			clearTimeout(timer);
			resolvePromise({ code, output: scrubSensitive(Buffer.concat(chunks).toString("utf8").slice(-120_000)) });
		});
		child.on("error", (error) => {
			clearTimeout(timer);
			rejectPromise(error);
		});
	});
}

async function claimIssue(): Promise<void> {
	const issue = await gh.getIssue(issueNumber);
	const labels = issue.labels.map((l) => l.name);
	if (!labels.includes(TASK_MARKER_LABEL)) {
		throw new Error(`issue #${issueNumber} is not a censor-task`);
	}
	await gh.addLabels(issueNumber, [STATE_RUNNING]);
	await gh.removeLabel(issueNumber, STATE_QUEUED);
	await gh.createComment(
		issueNumber,
		`🤖 Censor Cloud picked up this task (runner v2${reporter.active ? " + Firebase proxy" : ""}). Branch will be \`${taskBranchName(issueNumber)}\`.`,
	);
}

async function finishIssue(state: typeof STATE_DONE | typeof STATE_FAILED, summary: string) {
	const ops: Promise<unknown>[] = [
		gh.addLabels(issueNumber, [state]),
		gh.removeLabel(issueNumber, STATE_RUNNING),
	];
	await Promise.all(ops);
	const body = [
		state === STATE_DONE ? "✅ Censor Cloud finished" : "❌ Censor Cloud failed",
		"",
		"```",
		summary.slice(-MAX_TAIL),
		"```",
	].join("\n");
	await gh.createComment(issueNumber, body);
	if (state === STATE_DONE) await gh.setState(issueNumber, "closed");
}

async function cancelAndExit(summary: string): Promise<number> {
	reporter.line(summary, "warn");
	await reporter.finish("cancelled", undefined, { message: summary }).catch(() => {});
	await reporter.dispose().catch(() => {});
	await Promise.all([
		gh.addLabels(issueNumber, [STATE_CANCELLED]),
		gh.removeLabel(issueNumber, STATE_RUNNING),
		gh.removeLabel(issueNumber, STATE_QUEUED),
		gh.removeLabel(issueNumber, STATE_WAITING),
	]).catch(() => {});
	await gh.createComment(issueNumber, `🛑 Censor Cloud task cancelled: ${summary}`).catch(() => {});
	await gh.setState(issueNumber, "closed").catch(() => {});
	return 0;
}

/** Abort if the user cancelled while the runner was between stages. */
async function abortIfCancelled(cp: Checkpoint): Promise<boolean> {
	if (!cp.cancelled) return false;
	await cancelAndExit("cancelled by the user");
	return true;
}

async function waitForApproval(): Promise<"approved" | "cancelled" | "timeout"> {
	reporter.line("Waiting for approval before pushing (status: waiting_approval)", "warn");
	await reporter.patch({ status: "waiting_approval" });
	await gh.addLabels(issueNumber, [STATE_WAITING]).catch(() => {});
	await gh.removeLabel(issueNumber, STATE_RUNNING).catch(() => {});
	await gh.createComment(
		issueNumber,
		`⏸️ The task is parked before pushing. Approve it from Censor Desktop (Settings → GitHub Cloud) to continue. This runner will wait up to 30 minutes.`,
	).catch(() => {});
	const deadline = Date.now() + 30 * 60_000;
	while (Date.now() < deadline) {
		await sleep(15_000);
		const cp = await reporter.checkpoint();
		if (cp.cancelled) return "cancelled";
		if (cp.approved || cp.status === "queued") {
			await reporter.patch({ status: "running" });
			await gh.addLabels(issueNumber, [STATE_RUNNING]).catch(() => {});
			await gh.removeLabel(issueNumber, STATE_WAITING).catch(() => {});
			return "approved";
		}
	}
	return "timeout";
}

/** Write a GIT_ASKPASS helper that prints the token — token never appears in argv/logs. */
async function makeAskpass(): Promise<string> {
	const askpass = join(WORKDIR, ".censor-askpass.sh");
	await writeFile(
		askpass,
		`#!/bin/sh
case "$1" in
  *Username*) printf 'x-access-token' ;;
  *) printf '%s' "$CENSOR_ASKPASS_TOKEN" ;;
esac
`,
		{ mode: 0o700 },
	);
	return askpass;
}

async function gitAuth(args: string[], token: string | undefined, cwd?: string): Promise<{ stdout: string }> {
	const gitEnv: NodeJS.ProcessEnv = {
		...process.env,
		GIT_TERMINAL_PROMPT: "0",
		// The Censor monorepo carries multi-MB LFS assets that the runner
		// doesn't need; skip LFS downloads entirely.
		GIT_LFS_SKIP_SMUDGE: "1",
	};
	if (token) {
		gitEnv.GIT_ASKPASS = await makeAskpass();
		gitEnv.CENSOR_ASKPASS_TOKEN = token;
	}
	const { stdout } = await exec("git", args, {
		cwd,
		env: gitEnv,
		maxBuffer: 64 * 1024 * 1024,
	});
	return { stdout };
}

async function gitClone(url: string, dir: string, branch: string | undefined, token: string | undefined): Promise<void> {
	await rm(dir, { recursive: true, force: true });
	const cloneArgs = ["clone", "--depth", "1"];
	if (branch) cloneArgs.push("-b", branch);
	cloneArgs.push(url, dir);
	await gitAuth(cloneArgs, token);
}

/** Run the installed npm CLI or the cloned source CLI, headless. */
async function runAgent(prompt: string, timeoutSeconds: number, model: string | undefined, provider: string): Promise<{ code: number | null; output: string }> {
	const flags = [
		"--yolo",
		"--timeout", String(timeoutSeconds),
		...(provider ? ["--provider", provider] : []),
		...(model ? ["--model", model] : []),
	];
	if (AGENT_MODE === "npm") {
		return run(TARGET_DIR, AGENT_BIN, [...flags, prompt], (timeoutSeconds + 60) * 1000, undefined, (line) => reporter.line(line));
	}
	// NOTE: the CLI entry is src/index.ts — src/main.ts only exports runCli()
	// and silently exits 0 when executed directly.
	return run(
		TARGET_DIR,
		"bun",
		["--conditions=development", join(CENSOR_DIR, "apps/cli/src/index.ts"), ...flags, prompt],
		(timeoutSeconds + 60) * 1000,
		undefined,
		(line) => reporter.line(line),
	);
}

interface CheckResult {
	name: string;
	status: string;
	conclusion: string | null;
	url: string;
	event?: string;
}

/**
 * Dispatch authorized workflows (build/test/lint/typecheck/CI by default;
 * never deploy/release/publish), then poll their runs and collect job/log
 * details for failed checks.
 */
async function collectChecks(
	spec: TaskSpec,
	branch: string,
	since: number,
): Promise<{ checks: CheckResult[]; failedLogs: string[]; dispatched: string[] }> {
	const requested = spec.workflows ?? ["auto"];
	let workflows: string[] = [];
	if (requested.includes("auto")) {
		const defs = await gh.listWorkflows(spec.repo).catch(() => []);
		workflows = defs
			.filter((w) => {
				const label = `${w.name} ${w.path}`.toLowerCase();
				return w.state !== "disabled" &&
					/\b(build|test|lint|typecheck|type-check|ci)\b/.test(label) &&
					!/(deploy|release|publish)/.test(label);
			})
			.map((w) => w.path);
		reporter.line(`Auto-selected ${workflows.length} build/test workflow(s): ${workflows.join(", ") || "none"}`);
	} else {
		workflows = requested.filter((w) => !/(deploy|release|publish)/i.test(w));
	}
	if (workflows.some((w) => /(deploy|release|publish)/i.test(w))) {
		reporter.line("Skipped deploy/release/publish workflows — those require explicit authorization.", "warn");
	}

	const dispatched: string[] = [];
	for (const w of workflows) {
		try {
			await gh.dispatchWorkflow(spec.repo, w, branch);
			dispatched.push(w);
		} catch (error) {
			reporter.line(`Could not dispatch ${w}: ${error instanceof Error ? error.message : String(error)}`, "warn");
		}
	}

	// Poll workflow runs on the task branch, including push-triggered runs.
	const deadline = Date.now() + 15 * 60_000;
	let relevant: Awaited<ReturnType<typeof gh.workflowRunsForBranch>> = [];
	while (Date.now() < deadline) {
		const runs = await gh.workflowRunsForBranch(spec.repo, branch).catch(() => []);
		relevant = runs.filter((r) => {
			const created = r.created_at ? Date.parse(r.created_at) : 0;
			const event = r.event ?? "";
			return created >= since - 60_000 && ["push", "workflow_dispatch", "pull_request"].includes(event);
		});
		if (relevant.length > 0 && relevant.every((r) => r.status === "completed")) break;
		const cp = await reporter.checkpoint();
		if (await abortIfCancelled(cp)) return { checks: [], failedLogs: [], dispatched };
		await sleep(15_000);
	}

	const checks: CheckResult[] = relevant.map((r) => ({
		name: r.name,
		status: r.status,
		conclusion: r.conclusion,
		url: r.html_url,
		...(r.event ? { event: r.event } : {}),
	}));
	const failedLogs: string[] = [];
	for (const r of relevant.filter((run) => run.conclusion && run.conclusion !== "success")) {
		const jobs = await gh.runJobs(spec.repo, r.id).catch(() => []);
		const failedSteps = jobs.flatMap((job) =>
			(job.steps ?? []).filter((s) => s.conclusion === "failure").map((s) => `${job.name}: ${s.name}`),
		);
		const logs = await gh.runLogs(spec.repo, r.id).catch(() => undefined);
		failedLogs.push(
			[
				`Workflow: ${r.name} (${r.conclusion}) — ${r.html_url}`,
				...failedSteps.slice(0, 20),
				...(logs ? [`Log tail:\n${scrubSensitive(logs).slice(-6000)}`] : []),
			].join("\n"),
		);
	}
	return { checks, failedLogs, dispatched };
}

async function main(): Promise<number> {
	// actions/checkout leaves a host-wide http.extraheader (the runner's own
	// token) in git config — it applies to every github.com request in the job
	// and collides with per-repo auth. Unset it; our GIT_ASKPASS handles auth.
	try {
		await exec("git", ["config", "--unset-all", "http.https://github.com/.extraheader"]);
	} catch {
		// key may not exist — fine
	}

	const issue = await gh.getIssue(issueNumber);
	const spec = parseTaskSpec(issue.body);
	if (!spec) {
		await finishIssue(STATE_FAILED, "Issue body is not a valid censor task JSON (expected { censor: 1, prompt, repo, … }).");
		return 1;
	}

	reporter = new CloudReporter(spec.taskId, {
		url: env.CENSOR_CLOUD_PROXY_URL,
		key: env.CENSOR_RUNNER_KEY,
	});

	// Confirm with the proxy that the task wasn't cancelled between issue
	// creation and the cron runner picking it up.
	if (await abortIfCancelled(await reporter.checkpoint())) return 0;

	console.log(`[censor] claiming issue #${issueNumber}`);
	await claimIssue();
	// Claim in Firestore too: the proxy only accepts running→completed/failed,
	// so without this the task would stay `queued` despite finishing.
	const claim = await reporter.patch({ status: "running" });
	if (await abortIfCancelled(claim)) return 0;
	let cp = await reporter.stage("claimed", `Runner picked up issue #${issueNumber}`, 5);
	if (await abortIfCancelled(cp)) return 0;

	// Clone target repo
	const targetUrl = /^https?:\/\//.test(spec.repo) ? spec.repo : `${SERVER}/${spec.repo}.git`;
	console.log(`[censor] cloning ${targetUrl} (base ${spec.baseBranch ?? "default"})`);
	cp = await reporter.stage("cloning", `Cloning ${spec.repo}`, 12);
	if (await abortIfCancelled(cp)) return 0;
	try {
		await gitClone(targetUrl, TARGET_DIR, spec.baseBranch, TOKEN);
	} catch (error) {
		const message = error instanceof Error ? error.message : String(error);
		await reporter.line(`Failed to clone ${spec.repo}: ${message}`, "error");
		await reporter.finish("failed", undefined, { stage: "clone", message });
		await reporter.dispose();
		await finishIssue(STATE_FAILED, `Failed to clone ${spec.repo}: ${message}`);
		return 1;
	}
	const baseBranch = spec.baseBranch?.trim();
	const branch = taskBranchName(issueNumber);
	await exec("git", ["checkout", "-B", branch], { cwd: TARGET_DIR });
	const pushTime = Date.now();

	// Prepare the agent (source: clone + build; npm: package installed by workflow)
	if (AGENT_MODE === "source") {
		console.log(`[censor] cloning agent @ ${CENSOR_REF}`);
		cp = await reporter.stage("preparing-agent", `Cloning Censor @ ${CENSOR_REF}`, 18);
		if (await abortIfCancelled(cp)) return 0;
		try {
			await gitClone(CENSOR_REPOSITORY!, CENSOR_DIR, CENSOR_REF, MONO_TOKEN);
		} catch (error) {
			const message = error instanceof Error ? error.message : String(error);
			await reporter.finish("failed", undefined, { stage: "agent-source", message });
			await reporter.dispose();
			await finishIssue(STATE_FAILED, `Failed to clone Censor monorepo (${CENSOR_REPOSITORY}@${CENSOR_REF}). Set CENSOR_REPOSITORY (and CENSOR_REF) in the workflow env. Error: ${message}`);
			return 1;
		}
		cp = await reporter.stage("building", "Installing dependencies and building SDK", 22);
		if (await abortIfCancelled(cp)) return 0;
		const install = await run(CENSOR_DIR, "bun", ["install", "--frozen-lockfile"], 15 * 60_000);
		if (install.code !== 0) {
			await reporter.finish("failed", undefined, { stage: "bun-install", message: install.output.slice(-3000) });
			await reporter.dispose();
			await finishIssue(STATE_FAILED, `bun install failed:\n${install.output.slice(-3000)}`);
			return 1;
		}
		const buildSdk = await run(CENSOR_DIR, "bun", ["run", "build:sdk"], 15 * 60_000);
		if (buildSdk.code !== 0) {
			await reporter.finish("failed", undefined, { stage: "build:sdk", message: buildSdk.output.slice(-3000) });
			await reporter.dispose();
			await finishIssue(STATE_FAILED, `build:sdk failed:\n${buildSdk.output.slice(-3000)}`);
			return 1;
		}
	} else {
		await reporter.stage("preparing-agent", `Using ${AGENT_BIN} from npm`, 22);
	}

	// Seed provider settings from the user's signed-in Censor subscription
	// when provided (works for both source and npm agent modes).
	if (OAUTH_JSON_B64) {
		try {
			const providersPath = join(homedir(), ".cline", "data", "settings", "providers.json");
			await mkdir(dirname(providersPath), { recursive: true });
			await writeFile(providersPath, Buffer.from(OAUTH_JSON_B64, "base64").toString("utf8"), { mode: 0o600 });
			reporter.line("Provider settings seeded (subscription auth)");
		} catch (error) {
			reporter.line(`Could not seed providers.json: ${error instanceof Error ? error.message : String(error)}`, "warn");
		}
	}

	const provider = env.CENSOR_PROVIDER?.trim() || spec.provider || "cline";
	const model = env.CENSOR_MODEL?.trim() || spec.model;
	const timeoutSeconds = spec.timeoutSeconds ?? 1800;
	const maxAttempts = spec.autoRepair === false ? 1 : 2;

	let commitUrl: string | null = null;
	let prUrl: string | null = null;
	let diffstat = "";
	let checks: CheckResult[] = [];
	let dispatched: string[] = [];
	let failedLogs: string[] = [];
	let agentAttempts = 0;
	let failureSummary = "";

	for (let attempt = 1; attempt <= maxAttempts; attempt++) {
		agentAttempts = attempt;
		const repairPrompt = attempt === 1
			? spec.prompt
			: `${spec.prompt}\n\n--- CI FAILURE — FIX THIS ---\nThe previous attempt's GitHub Actions checks failed. Analyze the failure below, fix the code, and keep the changes minimal. Do not change the tests to make them pass unless they are wrong.\n\n${failedLogs.join("\n\n").slice(-20_000)}`;
		console.log(`[censor] running agent (attempt ${attempt}/${maxAttempts}, provider=${provider}, budget=${timeoutSeconds}s)`);
		cp = await reporter.stage("agent", attempt === 1 ? "Agent analyzing and editing the repository" : `Repair pass ${attempt}`, attempt === 1 ? 40 : 88);
		if (await abortIfCancelled(cp)) return 0;
		const agent = await runAgent(repairPrompt, timeoutSeconds, model, provider);
		reporter.line(agent.output.slice(-6000).split("\n").slice(-30).join("\n"), agent.code === 0 ? "info" : "error");
		console.log("[censor] agent output (tail, token-redacted):");
		console.log(scrubSensitive(agent.output.slice(-6000)));
		await reporter.flush();
		if (agent.code !== 0) {
			failureSummary = `Agent exited ${agent.code}:\n${agent.output.slice(-3000)}`;
			break;
		}

		cp = await reporter.stage("committing", "Committing agent changes", 70);
		if (await abortIfCancelled(cp)) return 0;

		// Approval gate before any repository write.
		if (attempt === 1 && spec.approval === "before_push") {
			const decision = await waitForApproval();
			if (decision === "cancelled") return await cancelAndExit("cancelled while waiting for approval");
			if (decision === "timeout") {
				failureSummary = "Approval timed out after 30 minutes — no changes were pushed.";
				break;
			}
		}

		const porcelain = (await exec("git", ["status", "--porcelain"], { cwd: TARGET_DIR })).stdout.trim();
		if (porcelain) {
			await exec("git", ["add", "-A"], { cwd: TARGET_DIR });
			await exec(
				"git",
				["-c", "user.email=censor-actions@users.noreply.github.com", "-c", "user.name=Censor Actions", "commit", "-q", "-m", `censor: task #${issueNumber} — agent changes (attempt ${attempt})`],
				{ cwd: TARGET_DIR },
			);
		}
		const sha = (await exec("git", ["rev-parse", "HEAD"], { cwd: TARGET_DIR }).then((r) => r.stdout.trim()).catch(() => ""));
		commitUrl = sha ? `${SERVER}/${spec.repo}/commit/${sha}` : null;

		const ahead = (
			await exec("git", ["rev-list", "--count", `${baseBranch ?? "origin/HEAD"}..${branch}`], { cwd: TARGET_DIR }).catch(() => ({ stdout: "0" }))
		).stdout.trim();
		cp = await reporter.stage("pushing", `Pushing ${branch}`, 75);
		if (await abortIfCancelled(cp)) return 0;
		if (ahead !== "0" || porcelain) {
			await gitAuth(["push", "-u", "origin", branch], TOKEN, TARGET_DIR);
			diffstat = (await exec("git", ["diff", "--stat", `${baseBranch ?? "origin/HEAD"}...${branch}`], { cwd: TARGET_DIR }).catch(() => ({ stdout: "" }))).stdout.trim();
			reporter.line(`Pushed ${branch} to ${spec.repo}\n${diffstat}`);
		} else {
			reporter.line("Agent finished with no file changes — nothing to push.");
		}

		// Pull request (task-specific branch; never touches a protected branch).
		if (spec.createPr !== false && (ahead !== "0" || porcelain)) {
			cp = await reporter.stage("pull-request", "Creating a pull request", 80);
			if (await abortIfCancelled(cp)) return 0;
			try {
				const pr = await gh.createPullRequest(spec.repo, {
					title: `Censor: task #${issueNumber}`,
					head: branch,
					base: baseBranch || (await gh.defaultBranch(spec.repo)),
					body: `Automated changes by Censor Cloud for issue #${issueNumber}.\n\nTask:\n${spec.prompt.slice(0, 4000)}`,
				});
				prUrl = pr.html_url;
				reporter.line(`Pull request: ${prUrl}`);
			} catch (error) {
				reporter.line(`PR creation failed (branch was still pushed): ${error instanceof Error ? error.message : String(error)}`, "warn");
			}
		}

		// Authorized GitHub Actions: dispatch build/test workflows and collect
		// their status, jobs and failure logs.
		cp = await reporter.stage("checks", "Running GitHub Actions checks", 85);
		if (await abortIfCancelled(cp)) return 0;
		const outcome = await collectChecks(spec, branch, pushTime);
		if (await abortIfCancelled(await reporter.checkpoint())) return 0;
		checks = outcome.checks;
		dispatched = outcome.dispatched;
		failedLogs = outcome.failedLogs;
		await reporter.patch({
			result: {
				branch,
				commitUrl,
				prUrl,
				diffstat,
				checks,
				dispatchedWorkflows: dispatched,
				agentAttempts: attempt,
			},
		});
		const failed = checks.filter((c) => c.conclusion && c.conclusion !== "success");
		if (failed.length === 0) {
			failureSummary = "";
			break; // success (or no checks configured)
		}
		failureSummary = `${failed.length} GitHub Actions check(s) failed:\n${failed.map((c) => `- ${c.name}: ${c.conclusion} (${c.url})`).join("\n")}`;
		if (attempt === maxAttempts) break;
		reporter.line(`${failureSummary}\nStarting one repair pass.`, "warn");
	}

	const ok = !failureSummary;
	const result = {
		summary: ok ? `Task #${issueNumber} completed; branch ${branch} pushed.` : failureSummary,
		branch,
		commitUrl,
		prUrl,
		diffstat,
		checks,
		dispatchedWorkflows: dispatched,
		agentAttempts,
	};
	const issueSummary = [
		result.summary,
		commitUrl ? `Commit: ${commitUrl}` : "",
		prUrl ? `PR: ${prUrl}` : "",
		checks.length
			? `Checks:\n${checks.map((c) => `- ${c.name}: ${c.conclusion ?? c.status} (${c.url})`).join("\n")}`
			: "",
	].filter(Boolean).join("\n\n");

	await reporter.finish(ok ? "completed" : "failed", result, ok ? undefined : { stage: "agent-or-ci", message: failureSummary });
	await reporter.dispose();
	await finishIssue(ok ? STATE_DONE : STATE_FAILED, issueSummary);
	return ok ? 0 : 1;
}

if (import.meta.main) {
	main()
		.then(async (code) => {
			if (reporter?.active) await reporter.dispose().catch(() => {});
			process.exit(code);
		})
		.catch(async (error) => {
			const message = error instanceof Error ? (error.stack ?? error.message) : String(error);
			console.error(`[censor] fatal: ${message}`);
			try {
				if (reporter) await reporter.finish("failed", undefined, { message });
				await finishIssue(STATE_FAILED, message.slice(-MAX_TAIL));
			} catch {
				// best effort
			}
			try {
				await reporter?.dispose();
			} catch {
				// best effort
			}
			process.exit(1);
		});
}

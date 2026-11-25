/**
 * Redact credential-looking material before it reaches logs or issue comments.
 * Intentionally conservative: anything that looks like a bearer/PAT/token is
 * masked, everything else passes through.
 */
export function scrubSensitive(text: string): string {
	return (
		text
			.replace(/Bearer\s+[A-Za-z0-9._-]{8,}/g, "…")
			.replace(/(gho|ghu|ghp|github_pat|ghsa)_[A-Za-z0-9_]{8,}/gi, "$1…")
			.replace(/x-access-token:[^\s@"']+@/g, "x-access-token:…@")
			.replace(/extraheader=[^\s"]*/gi, "extraheader=…")
			.replace(/authorization:\s*[^\s"]+/gi, "authorization: …")
	);
}

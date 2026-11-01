// Pure helpers for the Relvato Action: reading inputs, finding the site, deciding pass or fail, and the job summary.
// No I/O here — test/lib.test.mjs covers all of it.

export const GROUPS = ["uptime", "flow", "security", "design", "performance", "seo", "domain", "compliance"];
export const SEVERITIES = ["warning", "low", "medium", "high", "critical"];
export const FAIL_ON = ["issue", "any", "never"];

/** GitHub passes `with:` inputs as INPUT_<NAME> environment variables, upper-cased, hyphens kept. */
export function readInputs(env) {
  const get = (name) => (env[`INPUT_${name.toUpperCase()}`] ?? "").trim();
  const problems = [];
  const apiKey = get("api-key");
  if (!apiKey) problems.push("api-key is empty — add your Relvato API key as a repository secret and pass it in.");
  const site = get("site");
  if (!site) problems.push("site is empty — give the site's domain (example.com) or its Relvato site id.");
  const group = get("group").toLowerCase();
  if (group && !GROUPS.includes(group)) problems.push(`group must be one of: ${GROUPS.join(", ")} (or empty for every monitor).`);
  const failOn = (get("fail-on") || "issue").toLowerCase();
  if (!FAIL_ON.includes(failOn)) problems.push(`fail-on must be one of: ${FAIL_ON.join(", ")}.`);
  const minSeverity = (get("min-severity") || "low").toLowerCase();
  if (!SEVERITIES.includes(minSeverity)) problems.push(`min-severity must be one of: ${SEVERITIES.join(", ")}.`);
  const timeoutMinutes = Number(get("timeout-minutes") || "20");
  if (!Number.isFinite(timeoutMinutes) || timeoutMinutes < 1 || timeoutMinutes > 120) problems.push("timeout-minutes must be a number from 1 to 120.");
  const apiUrl = (get("api-url") || "https://app.relvato.com").replace(/\/+$/, "");
  if (!/^https:\/\/[^/?#]+$/.test(apiUrl)) problems.push("api-url must be an https address with no path (the default is https://app.relvato.com).");
  return { apiKey, site, group: group || null, failOn, minSeverity, timeoutMinutes, apiUrl, problems };
}

const hostOf = (s) => {
  try {
    return new URL(/^https?:\/\//i.test(s) ? s : `https://${s}`).hostname.toLowerCase().replace(/^www\./, "");
  } catch {
    return "";
  }
};

/** The site the `site` input names: its id, or its domain (with or without https:// and www.). */
export function resolveSite(sites, input) {
  const byId = sites.find((s) => s.id === input);
  if (byId) return { site: byId };
  const want = hostOf(input);
  const matches = want ? sites.filter((s) => hostOf(s.url) === want) : [];
  if (matches.length === 1) return { site: matches[0] };
  if (matches.length > 1) return { error: `More than one site is ${want} — use its site id instead (${matches.map((s) => s.id).join(", ")}).` };
  return { error: `No site "${input}" on this Relvato account. Sites: ${sites.map((s) => hostOf(s.url)).join(", ") || "none yet"}.` };
}

/** What the scan endpoint's refusal means, in words for the job log. */
export function scanError(status, body) {
  const code = body?.error;
  const msg = body?.message ? ` ${body.message}` : "";
  if (status === 401) return `Relvato didn't accept the API key.${msg}`;
  if (status === 403) return "This API key is read-only. Running monitors needs a full-access key (app.relvato.com → API access).";
  if (code === "ownership_unverified" || code === "domain_unverified") return `Relvato's API runs monitors only on sites whose ownership is proven.${msg} Prove it in the dashboard (the WordPress plugin, a DNS record or a meta tag), then run this again.`;
  if (code === "quota_exceeded") return "This account has used all of this month's runs. Each Action run uses one run per monitor — upgrade, or wait for the reset on the 1st.";
  if (code === "site_disabled") return "This site is paused in Relvato — resume it to run its monitors.";
  if (code === "bad_group") return `Relvato didn't accept the group.${msg}`;
  if (code === "not_found") return "Relvato couldn't find that site on this account.";
  if (status === 429) return "Too many API requests for this plan right now — try again in a minute.";
  return `Relvato refused the run (HTTP ${status}${code ? `, ${code}` : ""}).${msg}`;
}

const rank = (s) => SEVERITIES.indexOf(s);

/**
 * The verdict over the runs this job started. `issue` counts only issues at or above minSeverity; a run that couldn't
 * run (a firewall, the site down) is `notRun` and fails the job only with fail-on "any".
 */
export function decide(runs, { failOn, minSeverity, timedOut }) {
  const issues = runs.filter((r) => r.outcome === "issue" && rank(r.severity ?? "medium") >= rank(minSeverity));
  const notRun = runs.filter((r) => r.outcome === "not-run");
  const pending = runs.filter((r) => !r.finished);
  const result = issues.length ? "issues" : timedOut && pending.length ? "timeout" : notRun.length && notRun.length === runs.length ? "not-run" : "passed";
  const fail = failOn === "never" ? false : issues.length > 0 || (failOn === "any" && (notRun.length > 0 || (timedOut && pending.length > 0)));
  return { result, fail, issues, notRun, pending };
}

const OUTCOME_LABEL = { ok: "✅ passed", issue: "🚨 found a problem", "not-run": "🚧 couldn't run", pending: "⏳ still running" };

/** The job summary (Markdown). */
export function summaryMarkdown({ site, siteUrl, runs, verdict, group }) {
  const head = {
    passed: `✅ Relvato: every monitor passed on ${site.name ?? site.url}`,
    issues: `🚨 Relvato: ${verdict.issues.length} monitor${verdict.issues.length === 1 ? "" : "s"} found a problem on ${site.name ?? site.url}`,
    "not-run": `🚧 Relvato: no monitor could run on ${site.name ?? site.url}`,
    timeout: `⏳ Relvato: ${verdict.pending.length} monitor${verdict.pending.length === 1 ? " was" : "s were"} still running when the time ran out`,
  }[verdict.result];
  const rows = runs.map((r) => {
    const outcome = r.finished ? OUTCOME_LABEL[r.outcome] ?? r.outcome : OUTCOME_LABEL.pending;
    const why = r.outcome === "not-run" && r.notRunReason ? ` (${r.notRunReason})` : "";
    return `| ${r.checkName ?? r.journey ?? "Monitor"} | ${outcome}${why} | ${r.outcome === "issue" ? r.severity ?? "" : ""} | [View run](${r.url}) |`;
  });
  return [
    `### ${head}`,
    "",
    `Site: ${site.url}${group ? ` · group: ${group}` : ""} · [Open in Relvato](${siteUrl})`,
    "",
    "| Monitor | Result | Severity | |",
    "|---|---|---|---|",
    ...rows,
    "",
    "Relvato checked the live site. A run started here counts like **Run now** in the dashboard, so a problem it finds is also alerted on the channels set in Alert settings.",
  ].join("\n");
}

/** Escape a string for a workflow command's message (::error::…). */
export const escapeCommand = (s) => String(s).replace(/%/g, "%25").replace(/\r/g, "%0D").replace(/\n/g, "%0A");
export const escapeProperty = (s) => escapeCommand(s).replace(/:/g, "%3A").replace(/,/g, "%2C");

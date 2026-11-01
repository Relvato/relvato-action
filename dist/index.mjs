// Relvato website monitors — a GitHub Action. Starts a site's monitors through Relvato's REST API, waits for them, and
// fails the job when one finds a problem. No dependencies: Node's own fetch, and GitHub's workflow-command files.
import { appendFileSync } from "node:fs";
import { readInputs, resolveSite, scanError, decide, summaryMarkdown, escapeCommand, escapeProperty } from "./lib.mjs";

const POLL_MS = Number(process.env.RELVATO_POLL_MS) || 15_000; // the tests shorten it
const sleep = (ms) => new Promise((r) => setTimeout(r, ms));

function setOutput(name, value) {
  const file = process.env.GITHUB_OUTPUT;
  const v = String(value);
  if (file) appendFileSync(file, `${name}<<__RELVATO__\n${v}\n__RELVATO__\n`);
}
function summary(md) {
  if (process.env.GITHUB_STEP_SUMMARY) appendFileSync(process.env.GITHUB_STEP_SUMMARY, `${md}\n`);
}
const log = (s) => console.log(s);
const error = (msg, title) => console.log(`::error${title ? ` title=${escapeProperty(title)}` : ""}::${escapeCommand(msg)}`);
const warning = (msg, title) => console.log(`::warning${title ? ` title=${escapeProperty(title)}` : ""}::${escapeCommand(msg)}`);

class ApiError extends Error {
  constructor(status, body) {
    super(`HTTP ${status}`);
    this.status = status;
    this.body = body;
  }
}

/** One API call: JSON in and out, the key as a bearer token, retried on a network error or a 5xx. Never logs the key. */
async function api(inputs, method, path, body) {
  let last;
  for (let attempt = 0; attempt < 3; attempt++) {
    if (attempt) await sleep(attempt * 3_000);
    let res;
    try {
      res = await fetch(`${inputs.apiUrl}${path}`, {
        method,
        redirect: "error",
        signal: AbortSignal.timeout(30_000),
        headers: { Authorization: `Bearer ${inputs.apiKey}`, Accept: "application/json", "User-Agent": "relvato-github-action/1", ...(body ? { "Content-Type": "application/json" } : {}) },
        body: body ? JSON.stringify(body) : undefined,
      });
    } catch (e) {
      last = new Error(`couldn't reach ${inputs.apiUrl} (${e instanceof Error ? e.message : e})`);
      continue;
    }
    const json = await res.json().catch(() => null);
    if (res.ok) return json;
    if (res.status >= 500) {
      last = new ApiError(res.status, json);
      continue;
    }
    throw new ApiError(res.status, json);
  }
  throw last;
}

async function main() {
  const inputs = readInputs(process.env);
  if (inputs.apiKey) console.log(`::add-mask::${inputs.apiKey}`);
  if (inputs.problems.length) {
    for (const p of inputs.problems) error(p, "Relvato: check the inputs");
    process.exitCode = 1;
    return;
  }

  // 1. The site.
  let sites;
  try {
    sites = (await api(inputs, "GET", "/api/v1/sites"))?.sites ?? [];
  } catch (e) {
    error(e instanceof ApiError ? scanError(e.status, e.body) : String(e.message ?? e), "Relvato: couldn't list the sites");
    process.exitCode = 1;
    return;
  }
  const found = resolveSite(sites, inputs.site);
  if (found.error) {
    error(found.error, "Relvato: site not found");
    process.exitCode = 1;
    return;
  }
  const site = found.site;
  const siteUrl = `${inputs.apiUrl}/sites/${site.id}`;
  setOutput("site-url", siteUrl);
  log(`Relvato: running ${inputs.group ? `the ${inputs.group} monitors` : "every enabled monitor"} on ${site.url}`);

  // 2. Run its monitors.
  let scan;
  try {
    scan = await api(inputs, "POST", `/api/v1/sites/${site.id}/scan`, inputs.group ? { group: inputs.group } : {});
  } catch (e) {
    error(e instanceof ApiError ? scanError(e.status, e.body) : String(e.message ?? e), "Relvato: the monitors didn't start");
    setOutput("result", "not-run");
    process.exitCode = 1;
    return;
  }
  const started = scan?.runs ?? [];
  for (const w of scan?.waitingOnRetry ?? []) warning(`${w.key} wasn't started: a retry after a firewall block is already queued for ${w.retryAt}.`, "Relvato");
  if (scan?.notRunOverQuota?.length) warning(`Not run — this month's runs ran out: ${scan.notRunOverQuota.join(", ")}.`, "Relvato");
  if (!started.length) {
    warning("No monitors ran: the site has none switched on" + (inputs.group ? ` in the ${inputs.group} group` : "") + ".", "Relvato");
    setOutput("result", "not-run");
    setOutput("issues", 0);
    setOutput("not-run", 0);
    setOutput("runs", "[]");
    return;
  }
  log(`Relvato: ${started.length} monitor${started.length === 1 ? "" : "s"} queued. They run one at a time; checking every ${POLL_MS / 1000} s.`);

  // 3. Wait for them: one list call per poll, the run ids this job started.
  const ids = new Set(started.map((r) => r.runId));
  const byId = new Map(started.map((r) => [r.runId, { id: r.runId, journey: r.key, finished: false, outcome: "pending" }]));
  const deadline = Date.now() + inputs.timeoutMinutes * 60_000;
  let timedOut = false;
  for (;;) {
    try {
      const list = (await api(inputs, "GET", `/api/v1/runs?siteId=${encodeURIComponent(site.id)}&limit=100`))?.runs ?? [];
      for (const r of list) if (ids.has(r.id)) byId.set(r.id, { ...byId.get(r.id), ...r });
      // A run that fell off the newest 100 (a busy account): ask for it directly.
      for (const id of ids) {
        if (byId.get(id).finished || list.some((r) => r.id === id)) continue;
        const one = await api(inputs, "GET", `/api/v1/runs/${id}`).catch(() => null);
        if (one) byId.set(id, { ...byId.get(id), ...one, id, journey: one.check?.key ?? byId.get(id).journey, checkName: one.check?.name });
      }
    } catch (e) {
      warning(`Couldn't read the runs this time (${e instanceof ApiError ? `HTTP ${e.status}` : e.message}); trying again.`, "Relvato");
    }
    const runs = [...byId.values()];
    const done = runs.filter((r) => r.finished).length;
    if (done === runs.length) break;
    if (Date.now() >= deadline) {
      timedOut = true;
      break;
    }
    log(`Relvato: ${done} of ${runs.length} finished…`);
    await sleep(POLL_MS);
  }

  // 4. The verdict.
  const runs = [...byId.values()].map((r) => ({ ...r, url: `${inputs.apiUrl}/runs/${r.id}` }));
  const verdict = decide(runs, { failOn: inputs.failOn, minSeverity: inputs.minSeverity, timedOut });
  for (const r of verdict.issues) error(`${r.checkName ?? r.journey}: ${r.error ?? "found a problem"} — ${r.url}`, `Relvato: ${r.checkName ?? r.journey} (${r.severity ?? "issue"})`);
  for (const r of verdict.notRun) warning(`${r.checkName ?? r.journey} couldn't run${r.notRunReason ? ` (${r.notRunReason})` : ""}: ${r.warning ?? r.error ?? ""} — ${r.url}`, "Relvato: a monitor couldn't run");
  if (timedOut && verdict.pending.length) warning(`${verdict.pending.length} monitor(s) were still running after ${inputs.timeoutMinutes} min — they keep running in Relvato: ${siteUrl}`, "Relvato: timed out");
  summary(summaryMarkdown({ site, siteUrl, runs, verdict, group: inputs.group }));
  setOutput("result", verdict.result);
  setOutput("issues", verdict.issues.length);
  setOutput("not-run", verdict.notRun.length);
  setOutput("runs", JSON.stringify(runs.map((r) => ({ id: r.id, monitor: r.checkName ?? r.journey, outcome: r.finished ? r.outcome : "pending", severity: r.severity ?? null, url: r.url }))));
  log(`Relvato: ${verdict.result}${verdict.fail ? " — failing the job" : ""}.`);
  if (verdict.fail) process.exitCode = 1;
}

main().catch((e) => {
  error(`Unexpected error: ${e instanceof Error ? e.message : e}`, "Relvato");
  process.exitCode = 1;
});

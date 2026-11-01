import { test } from "node:test";
import assert from "node:assert/strict";
import { readInputs, resolveSite, scanError, decide, summaryMarkdown, escapeCommand, escapeProperty } from "../dist/lib.mjs";

const env = (o) => Object.fromEntries(Object.entries(o).map(([k, v]) => [`INPUT_${k.toUpperCase()}`, v]));

test("inputs: defaults, and every bad value says why", () => {
  const ok = readInputs(env({ "api-key": "rlv_x", site: "example.com" }));
  assert.deepEqual(ok, { apiKey: "rlv_x", site: "example.com", group: null, failOn: "issue", minSeverity: "low", timeoutMinutes: 20, apiUrl: "https://app.relvato.com", problems: [] });
  const bad = readInputs(env({ "api-key": "", site: "", group: "nope", "fail-on": "sometimes", "min-severity": "huge", "timeout-minutes": "0", "api-url": "http://evil.example/x" }));
  assert.equal(bad.problems.length, 7);
  assert.equal(readInputs(env({ "api-key": "k", site: "s", group: "Security", "api-url": "https://app.relvato.com/" })).group, "security");
  assert.equal(readInputs(env({ "api-key": "k", site: "s", "api-url": "https://app.relvato.com/" })).apiUrl, "https://app.relvato.com");
});

test("site: by id, or by domain with or without scheme and www", () => {
  const sites = [{ id: "a1", url: "https://www.myshop.example", name: "My Shop" }, { id: "b2", url: "https://blog.example.org/", name: "Blog" }];
  assert.equal(resolveSite(sites, "b2").site.id, "b2");
  assert.equal(resolveSite(sites, "myshop.example").site.id, "a1");
  assert.equal(resolveSite(sites, "https://myshop.example/checkout").site.id, "a1");
  assert.equal(resolveSite(sites, "www.blog.example.org").site.id, "b2");
  assert.match(resolveSite(sites, "other.example").error, /No site "other.example".*myshop.example, blog.example.org/);
  assert.match(resolveSite([...sites, { id: "c3", url: "https://myshop.example" }], "myshop.example").error, /More than one/);
});

test("scan refusals in plain words", () => {
  assert.match(scanError(401, { error: "unauthorized", message: "API key not valid." }), /didn't accept the API key\. API key not valid\./);
  assert.match(scanError(403, null), /read-only/);
  assert.match(scanError(409, { error: "ownership_unverified", message: "Prove you own example.com first." }), /ownership is proven\. Prove you own/);
  assert.match(scanError(429, { error: "quota_exceeded" }), /this month's runs/);
  assert.match(scanError(429, {}), /Too many API requests/);
  assert.match(scanError(418, { error: "teapot" }), /HTTP 418, teapot/);
});

const run = (o) => ({ finished: true, outcome: "ok", ...o });

test("verdict: an issue fails, a firewall block doesn't (unless fail-on any), severity threshold, never", () => {
  const runs = [run({ id: "1" }), run({ id: "2", outcome: "issue", severity: "critical" }), run({ id: "3", outcome: "not-run", notRunReason: "firewall" })];
  assert.deepEqual(pick(decide(runs, { failOn: "issue", minSeverity: "low" })), { result: "issues", fail: true, issues: 1, notRun: 1 });
  assert.deepEqual(pick(decide(runs, { failOn: "never", minSeverity: "low" })), { result: "issues", fail: false, issues: 1, notRun: 1 });
  const minor = [run({ id: "1", outcome: "issue", severity: "low" })];
  assert.deepEqual(pick(decide(minor, { failOn: "issue", minSeverity: "high" })), { result: "passed", fail: false, issues: 0, notRun: 0 });
  const blocked = [run({ id: "1", outcome: "not-run" }), run({ id: "2" })];
  assert.equal(decide(blocked, { failOn: "issue", minSeverity: "low" }).fail, false);
  assert.equal(decide(blocked, { failOn: "any", minSeverity: "low" }).fail, true);
  assert.equal(decide([run({ id: "1", outcome: "not-run" })], { failOn: "issue", minSeverity: "low" }).result, "not-run");
});

test("verdict: a timeout reports, and fails only with fail-on any", () => {
  const runs = [run({ id: "1" }), { id: "2", finished: false, outcome: "pending" }];
  assert.deepEqual(pick(decide(runs, { failOn: "issue", minSeverity: "low", timedOut: true })), { result: "timeout", fail: false, issues: 0, notRun: 0 });
  assert.equal(decide(runs, { failOn: "any", minSeverity: "low", timedOut: true }).fail, true);
});

test("summary names the site, each monitor and links to the runs", () => {
  const runs = [run({ id: "1", checkName: "Uptime", url: "https://app.relvato.com/runs/1" }), run({ id: "2", checkName: "Guest checkout", outcome: "issue", severity: "critical", url: "https://app.relvato.com/runs/2" })];
  const md = summaryMarkdown({ site: { name: "My Shop", url: "https://myshop.example" }, siteUrl: "https://app.relvato.com/sites/a1", runs, verdict: decide(runs, { failOn: "issue", minSeverity: "low" }), group: null });
  assert.match(md, /### 🚨 Relvato: 1 monitor found a problem on My Shop/);
  assert.match(md, /\| Guest checkout \| 🚨 found a problem \| critical \| \[View run\]\(https:\/\/app\.relvato\.com\/runs\/2\) \|/);
  assert.match(md, /checked the live site/);
});

test("workflow commands are escaped", () => {
  assert.equal(escapeCommand("50% done\nnext"), "50%25 done%0Anext");
  assert.equal(escapeProperty("a: b, c"), "a%3A b%2C c");
});

function pick(v) {
  return { result: v.result, fail: v.fail, issues: v.issues.length, notRun: v.notRun.length };
}

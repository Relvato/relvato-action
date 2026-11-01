// The whole Action, end to end, against a fake API (test/fake-fetch.mjs): inputs → site → scan → polling → verdict.
import { test } from "node:test";
import assert from "node:assert/strict";
import { spawnSync } from "node:child_process";
import { mkdtempSync, readFileSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";

function runAction(scenario, inputs) {
  const dir = mkdtempSync(join(tmpdir(), "relvato-action-"));
  const out = join(dir, "out"), sum = join(dir, "summary");
  writeFileSync(out, ""); writeFileSync(sum, "");
  const env = { ...process.env, FAKE_SCENARIO: scenario, RELVATO_POLL_MS: "10", GITHUB_OUTPUT: out, GITHUB_STEP_SUMMARY: sum };
  for (const [k, v] of Object.entries({ "api-key": "rlv_test", site: "myshop.example", ...inputs })) env[`INPUT_${k.toUpperCase()}`] = v;
  const r = spawnSync(process.execPath, ["--import", "./test/fake-fetch.mjs", "dist/index.mjs"], { env, encoding: "utf8" });
  const outputs = Object.fromEntries([...readFileSync(out, "utf8").matchAll(/^(\S+)<<__RELVATO__\n([\s\S]*?)\n__RELVATO__$/gm)].map((m) => [m[1], m[2]]));
  return { code: r.status, stdout: r.stdout, stderr: r.stderr, outputs, summary: readFileSync(sum, "utf8") };
}

test("a monitor that finds a problem fails the job, with an error annotation and a summary", () => {
  const r = runAction("issue", {});
  assert.equal(r.code, 1);
  assert.equal(r.outputs.result, "issues");
  assert.equal(r.outputs.issues, "1");
  assert.match(r.stdout, /::error title=Relvato%3A Guest checkout \(critical\)::Guest checkout%3A|::error title=Relvato%3A Guest checkout \(critical\)::Guest checkout: Place order/);
  assert.match(r.summary, /1 monitor found a problem on My Shop/);
  assert.equal(JSON.parse(r.outputs.runs).length, 2, "only the runs this job started, not older ones");
  assert.ok(!r.stdout.includes("rlv_test") || r.stdout.includes("::add-mask::rlv_test"), "the key only appears in the mask command");
});

test("everything passes → the job passes", () => {
  const r = runAction("ok", { group: "flow" });
  assert.equal(r.code, 0);
  assert.equal(r.outputs.result, "passed");
  assert.match(r.stderr, /scan body \{"group":"flow"\}/);
});

test("a firewall block warns but doesn't fail, unless fail-on is any", () => {
  const a = runAction("blocked", {});
  assert.equal(a.code, 0);
  assert.match(a.stdout, /::warning title=Relvato%3A a monitor couldn't run::/);
  assert.equal(runAction("blocked", { "fail-on": "any" }).code, 1);
});

test("fail-on never reports without failing", () => {
  assert.equal(runAction("issue", { "fail-on": "never" }).code, 0);
});

test("an unproven site and a bad key fail with the reason", () => {
  const u = runAction("unproven", {});
  assert.equal(u.code, 1);
  assert.match(u.stdout, /ownership is proven\. Prove you own myshop\.example first\./);
  const k = runAction("ok", { "api-key": "wrong" });
  assert.equal(k.code, 1);
  assert.match(k.stdout, /didn't accept the API key/);
});

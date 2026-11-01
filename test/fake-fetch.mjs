// Replaces fetch with a fake Relvato API for test/action.test.mjs. FAKE_SCENARIO picks what it answers.
const scenario = process.env.FAKE_SCENARIO ?? "issue";
let polls = 0;
const json = (status, body) => new Response(JSON.stringify(body), { status, headers: { "Content-Type": "application/json" } });
globalThis.fetch = async (url, init = {}) => {
  const u = new URL(url);
  if (init.headers?.Authorization !== "Bearer rlv_test") return json(401, { error: "unauthorized", message: "API key not valid." });
  if (u.pathname === "/api/v1/sites") return json(200, { sites: [{ id: "s1", name: "My Shop", url: "https://myshop.example" }] });
  if (u.pathname === "/api/v1/sites/s1/scan" && init.method === "POST") {
    if (scenario === "unproven") return json(409, { error: "ownership_unverified", message: "Prove you own myshop.example first." });
    const body = JSON.parse(init.body || "{}");
    process.stderr.write(`scan body ${JSON.stringify(body)}\n`);
    return json(200, { ok: true, queued: 2, runs: [{ journeyId: "j1", key: "uptime", runId: "r1" }, { journeyId: "j2", key: "woo-checkout", runId: "r2" }] });
  }
  if (u.pathname === "/api/v1/runs") {
    polls++;
    const done = polls >= 2;
    const r2 = scenario === "issue"
      ? { outcome: "issue", severity: "critical", error: "Place order: the payment step returned an error" }
      : scenario === "blocked" ? { outcome: "not-run", notRunReason: "firewall", warning: "Cloudflare blocked Relvato" } : { outcome: "ok" };
    return json(200, { runs: [
      { id: "r1", journey: "uptime", checkName: "Uptime", finished: done, outcome: done ? "ok" : "pending" },
      { id: "r2", journey: "woo-checkout", checkName: "Guest checkout", finished: done, ...(done ? r2 : { outcome: "pending" }) },
      { id: "old", journey: "ssl", checkName: "SSL", finished: true, outcome: "issue", severity: "high" },
    ] });
  }
  return json(404, { error: "not_found" });
};

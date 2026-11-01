# Relvato website monitors — GitHub Action

Run your [Relvato](https://www.relvato.com) monitors on your live site right after a deploy, and fail the job when one finds a problem: a broken checkout, a page that looks different, a vulnerable plugin, an SEO regression, a missing legal page.

```yaml
- uses: Relvato/relvato-action@v1
  with:
    api-key: ${{ secrets.RELVATO_API_KEY }}
    site: myshop.example
```

The job summary lists every monitor with its result and a link to the run in Relvato.

## What you need

- A Relvato account with the site added and its **ownership proven** (the WordPress plugin, a DNS record or a meta tag). The API runs monitors only on proven sites.
- A **full-access API key**: app.relvato.com → API access → New key. Save it as a repository secret named `RELVATO_API_KEY`. A read-only key can't start runs.

## Two things to know

1. **It checks the live site.** Relvato runs your monitors against the site's address, so run this step **after** the deploy has reached production. It can't check a preview deployment before it's promoted.
2. **It's a "Run now".** Every run counts towards your plan's monthly runs, one per monitor. A problem it finds is also alerted on the channels you set in Alert settings (email, Slack, Teams, Discord, Telegram, PagerDuty, webhook), like any run you start by hand. Use `group` to run only the monitors a deploy can affect.

## Inputs

| Input | Default | |
|---|---|---|
| `api-key` | — | A full-access Relvato API key. **Required.** |
| `site` | — | The site's domain (`myshop.example`) or its Relvato site id. **Required.** |
| `group` | every monitor | Only one monitor group: `uptime`, `flow` (checkout, logins, forms), `security`, `design`, `performance`, `seo`, `domain` or `compliance`. |
| `fail-on` | `issue` | `issue`: fail when a monitor finds a problem. `any`: also when a monitor couldn't run (a firewall blocked Relvato, the site was down) or the time ran out. `never`: report only. |
| `min-severity` | `low` | The lowest severity that fails the job: `warning`, `low`, `medium`, `high` or `critical`. |
| `timeout-minutes` | `20` | How long to wait. A site's monitors run one at a time, so a full set can take several minutes. |

## Outputs

| Output | |
|---|---|
| `result` | `passed`, `issues`, `not-run` or `timeout` |
| `issues` | How many monitors found a problem at or above `min-severity` |
| `not-run` | How many monitors couldn't run |
| `runs` | Every run as JSON: `id`, `monitor`, `outcome`, `severity`, `url` |
| `site-url` | The site's page in Relvato |

A monitor that **couldn't run** (a firewall or bot protection blocked Relvato, the site didn't answer, the WordPress plugin is out of date) is a warning, not a failure — it says nothing about your deploy. Set `fail-on: any` if you want it to fail the job too.

## Examples

**After the deploy job in the same workflow**

```yaml
jobs:
  deploy:
    runs-on: ubuntu-latest
    steps:
      - run: ./deploy.sh

  verify:
    needs: deploy
    runs-on: ubuntu-latest
    steps:
      - uses: Relvato/relvato-action@v1
        with:
          api-key: ${{ secrets.RELVATO_API_KEY }}
          site: myshop.example
          group: flow            # checkout, logins, forms
          min-severity: high
```

**After a production deployment on Vercel, Netlify or another host that reports deployments to GitHub**

This runs once the production deployment has succeeded — after it's live, not before promotion.

```yaml
on: deployment_status

jobs:
  verify:
    if: github.event.deployment_status.state == 'success' && github.event.deployment.environment == 'Production'
    runs-on: ubuntu-latest
    steps:
      - uses: Relvato/relvato-action@v1
        with:
          api-key: ${{ secrets.RELVATO_API_KEY }}
          site: myshop.example
```

The environment name is whatever your host reports (Vercel uses `Production`).

**Report without failing**

```yaml
      - uses: Relvato/relvato-action@v1
        id: relvato
        with:
          api-key: ${{ secrets.RELVATO_API_KEY }}
          site: myshop.example
          fail-on: never
      - run: echo "Relvato says ${{ steps.relvato.outputs.result }}"
```

## Without the Action

The same thing over Relvato's REST API: `POST /api/v1/sites/{id}/scan` (optionally `{"group": "flow"}`), then poll `GET /api/v1/runs?siteId={id}` until each run is `finished`, and read its `outcome` (`ok`, `issue`, `not-run`) and `severity`. See [relvato.com/developers](https://www.relvato.com/developers).

## Licence

MIT

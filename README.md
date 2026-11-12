# CDO Foodsphere — Sales Operations KPI Dashboard

Executive KPI dashboard for CDO Foodsphere Sales Operations. Static site, hosted on
GitHub Pages, reading the **CDO KPI Monitoring** Google Sheet live in the browser —
there is no build step and no server.

**Live:** https://fcdaguit.github.io/CDO_KPI/

---

## What it reports

| | KPI | Definition |
|---|---|---|
| 1 | **Sellout Performance** | Target vs Actual vs Balance by Salesman, Channel and Category. Achievement % = Actual ÷ Target × 100. Balance = Target − Actual. |
| 2 | **Unique Buying Accounts (UBA)** | Distinct customer accounts with **consolidated positive sales**. One account counts once however many invoices it has. Primary view: UBA per Salesman per Channel. |
| 3 | **MCL Compliance** | An account is compliant when it purchases ≥ **85%** of the MCL products required for its Product Class and Channel. Compliance % = compliant accounts ÷ evaluated accounts × 100. |
| 4 | **Promo Product Distribution** | Same method as MCL, against the promotional product list. |

Summary cards at the top show Total Sellout Target, Total Sellout Actual, Overall
Achievement %, Total UBA, Overall MCL Compliance % and Overall Promo Distribution %.
Every chart carries an auto-generated executive summary that names the best and
lowest performers, the gap to target and the main opportunity.

---

## Data source

Published-to-web workbook (`File → Share → Publish to web`):

```
https://docs.google.com/spreadsheets/d/e/2PACX-1vQZ4ahKecCkUksXJ6TC8ZBbhvPK0OEMApzqvl2MlYlU7_2Abnbvht75ydCBKd6-w5w7bDrsjT6NotYo/pubhtml
```

The key lives in one place — `CONFIG.pubKey` at the top of `assets/js/data.js`.

The dashboard re-reads the sheet every 5 minutes, compares a digest of the contents,
and re-renders only when something actually changed. The header shows the last
refresh time; **Refresh** forces a reload.

> The workbook must stay **published to the web**. Simply sharing it by link is not
> enough — the browser needs the `/pub?output=csv` endpoint, which only exists for
> published workbooks.

### Tabs

Tabs are discovered automatically from the workbook's page switcher, so **adding a
tab needs no code change**. Each tab is classified by its own column headers:

| Classified as | Rule | Used for |
|---|---|---|
| **Fact table** | has `Target` + `Actual` + a customer column | all KPI calculations |
| **Requirement list** | has product code + channel + product class, and *no* customer column | MCL (tab named `*MCL*`) or Promo (tab named `*Promo*`) |
| **Lookup table** | anything else sharing a column name with the fact table | joined on, adding its other columns as new dimensions |

Current tabs: `Sellout` (fact), `MCL Target` (requirement), `Promo` (requirement).

---

## Extending it without touching code

### Add a new filter dimension

Add the column to the `Sellout` tab. Any text column with 2–300 distinct values
becomes a filter automatically, labelled from its header.

### Add a Salesman Position dimension

Create a new tab with a column named exactly as it appears in `Sellout` — for
example `salesman_code` — plus the new attribute:

| salesman_code | Salesman Position |
|---|---|
| BKG1 - FPM | Bike Group |
| HBKG1 - GP | Hybrid Bike Group |
| N07 - GP | Van Sales |

The dashboard joins it onto every sellout row and `Salesman Position` appears as a
filter and as a chart dimension. The same pattern works for any attribute of any
key — customer region, supervisor, area.

The join column must be spelled the same way in both tabs (matching is
case- and punctuation-insensitive: `salesman_code`, `Salesman Code` and
`SALESMANCODE` all match). A linked tab is confirmed in a notice at the top of the
dashboard; an unlinked one tells you so.

### Add Year / Month filters

The `Sellout` tab currently has no date column, so the period filters are hidden.
Add **either**:

- a `Date` column (any parseable date) — Year and Month are derived from it, or
- explicit `Year` and `Month` columns.

They then appear in the filter bar automatically. Month sorts in calendar order
whether you use names or numbers.

---

## Calculation rules worth knowing

- **Blank / `-` actuals are zero.** Around 94% of sellout rows carry `-`, which is
  the grid of required products an account has not bought.
- **Compliance unit** = one customer account within one Product Class, because the
  required list is defined per Channel + Product Class. An account trading in both
  FPM and GP is evaluated once for each.
- **Channels with no required list are excluded** from MCL and Promo denominators
  rather than scored as zero. The excluded count is stated under every compliance
  chart and in the executive summary. To change this, set
  `CONFIG.noRequirementMode` in `assets/js/data.js` to `'zero'` or `'full'`.
- **Compliance threshold** is `CONFIG.complianceThreshold` (85).
- **Stacked sellout column**: Actual sits below Balance so Actual + Balance = Target.
  Where Actual exceeds Target, Balance is zero and the column runs past the Target
  bar; the overachievement amount is stated in the executive summary.
- **UBA stack totals** can exceed the distinct account count when one account is
  served by more than one salesman or channel. The summary says so when it happens.

---

## Filters

Salesman Position (when present), Salesperson, Product Class, Channel, Category,
Brand, Variant, Product, Year and Month — plus anything new you add.

All are multi-select dropdown checklists with search, **Select all** and
**Uncheck all**. Empty = All.

Filters **cascade**: each dropdown offers only the values still reachable given
every other dropdown's selection, with live row counts. Relationships come from
co-occurrence in the data, so Salesman → Channel → Customer and Product Class →
Product → Category all narrow each other without any hard-coded hierarchy.
Selections made unreachable by a later choice are dropped automatically.

Every KPI card, chart and executive summary recalculates from the filtered rows.

---

## Features

Interactive Chart.js charts with tooltips · click-to-drill-down on UBA and
compliance charts · per-chart PNG export · per-chart Excel export · full workbook
export (summary, sellout by three dimensions, UBA matrix, MCL and Promo account
detail) · light and dark mode (remembered) · print-friendly layout · responsive
down to phone width · reduced-motion support.

---

## Files

```
index.html              markup and section scaffolding
assets/css/app.css      FAST-inspired theme, light/dark, print, responsive
assets/js/data.js       data source, tab discovery, schema detection, filter engine
assets/js/kpi.js        KPI calculations and executive-summary generation
assets/js/ui.js         filters, cards, charts, drill-down, exports, auto-refresh
```

Dependencies are CDN-loaded: Chart.js 4.4.1, SheetJS 0.18.5 (Excel export
degrades to CSV if it is blocked), Poppins from Google Fonts.

## Local development

Any static server works; the browser needs a real origin for the cross-origin
fetch to Google.

```bash
python3 -m http.server 8080
# http://localhost:8080
```

## Design

The whole theme is derived from the FAST logo in `assets/img/fast-logo.png`,
with the two hues sampled straight from the artwork:

| Token | Value | Use |
|---|---|---|
| `--fast-blue` | `#0000BA` | logo blue — primary, Actual bars, links, active filters |
| `--fast-red` | `#FE0000` | logo red — Target bars, masthead accent |
| `--fast-navy` | `#00006E` | title band, footer |
| `--fast-accent` | `#3A3AD6` | gradient end, section kickers |
| `--fast-wash` | `#E9E9FA` | hover tints, executive-summary panels |
| `--c-balance` | `#BCC0D0` | Balance bars |

Chart colours follow the dashboard spec — **Target red, Actual blue, Balance gray**
— which now means the literal logo red and logo blue.

The masthead carries a 3px blue-to-red bar echoing the red swoosh cutting across
the logo. The logo sits on its own white plate so the deep brand blue stays
legible in dark mode; in light mode the plate blends into the masthead. Dark mode
lifts both hues (`#7B7BF5` / `#FF5A5A`) for contrast rather than changing them.

Typography is Poppins, matching the FAST Logistics site.

To rebrand, replace `assets/img/fast-logo.png` and edit the `:root` block at the
top of `assets/css/app.css` — nothing else hard-codes a colour.

# Wheat seasonal dashboard frontend

Entry page: `wheat-spreads-seasonal.html` at the repository root, alongside the existing hog page. All supporting files are isolated under `wheat/`.

The page loads `wheat/data.json` over HTTP and uses the bundled Plotly 2.35.2. It needs no server runtime, authentication or external service. All styles, chart code, static datasets and downloads are relative to this repository's GitHub Pages path.

## Snapshot

- Price observations through: **19 November 2026**.
- Build timestamp: **2026-11-20T18:26:43+00:00**.
- 26 March delivery years (2002–2027) for MATIF, Chicago, KC and both spreads.
- The current/partial 2027 season and partial 2002 season remain outside the historical reference.
- Current March 2027 premiums: **37.48852333332974 USD/t vs Chicago**, **20.770135117643207 USD/t vs KC**, dated 19 November 2026.
- `data.json` was copied without modifying its validated numerical contents.

Full data file SHA-256: `001b33a403f6ee3c752d1ef8fb401c28aafb7823534df57f12d97377f15d3a21`.

Numerical series SHA-256 (`json.dumps(series, sort_keys=True, separators=(',', ':'), ensure_ascii=True).encode('utf-8')`): `fc83e7e6d45cff809d5e8576a390c57dfee5b4bf1f382a6810d7c036acb05d91`.

## Frontend adaptations

- Local data fetch is `wheat/data.json`; CSS, JS, Plotly and downloads are namespaced under `wheat/`.
- The hog reference link points to the neighboring `hog-spreads-seasonal.html`.
- Data coverage reports the snapshot build/observation dates. It does not infer that a scheduled update succeeded or that reloading collects new prices.
- Optional imported CSVs remain in the current browser session. The notice identifies only the views actually replaced.
- The unavailable dynamic all-maturity download was replaced with the verified seasonal PNG. A static all-maturity CSV link may be added when a committed export exists.
- Pricing conversion, matching, weekly equal-year median/IQR, percentile, year selection and import calculations are unchanged.

The daily publishing workflow may replace the data/download files independently; preserve these relative paths and the dataset schema. The frontend requires an actual dataset object with `series`, not a wrapper containing a `dataset` property.

## Asset inventory

| File | Bytes |
|---|---:|
| `wheat/app.js` | 18,943 |
| `wheat/data.json` | 5,593,488 |
| `wheat/downloads/cbot_march_template.csv` | 36 |
| `wheat/downloads/coverage.csv` | 13,233 |
| `wheat/downloads/eurusd_ecb.csv` | 118,562 |
| `wheat/downloads/kc_march_template.csv` | 36 |
| `wheat/downloads/march_wheat_spreads_20261119.png` | 335,072 |
| `wheat/downloads/matif_march_daily.csv` | 429,492 |
| `wheat/downloads/provenance.json` | 2,667 |
| `wheat/downloads/us_wheat_template.csv` | 36 |
| `wheat/style.css` | 12,225 |
| `wheat/vendor/plotly-2.35.2.min.js` | 4,558,696 |
| `wheat-spreads-seasonal.html` | 11,241 |

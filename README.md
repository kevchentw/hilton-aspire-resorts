# Hilton Aspire Resort Finder

Static GitHub Pages site for browsing Hilton resort-credit eligible hotels on a map and list view, with cached Xotelo price snapshots to help people use the Hilton Honors American Express Aspire semiannual resort credit.

## What it does

- Pulls the live Hilton resort-credit eligible hotel list from Hilton.
- Bootstraps hotel matches from Xotelo through RapidAPI when a key is available.
- Uses fallback geocoding only for resorts that still need coordinates after Xotelo enrichment.
- Uses Xotelo public endpoints to attach cached sample nightly rates and indicative ranges when a hotel key is known.
- Builds a plain static frontend that GitHub Pages can host.

## Local development

```bash
npm install
npm run sync:data
npm run dev
```

If you want to test with a smaller batch while tuning the sync script:

```bash
HOTEL_LIMIT=25 npm run sync:data
```

## Optional Xotelo bootstrap

Xotelo's `search` endpoint now requires RapidAPI. If you want complete hotel-key matching, much better map coverage, and richer cached pricing during the sync step, add this environment variable:

```bash
export RAPIDAPI_KEY=your_key_here
```

The script uses the RapidAPI host `xotelo-hotel-prices.p.rapidapi.com`.

Without `RAPIDAPI_KEY`, the site still builds and lists Hilton resorts, but map coverage and pricing enrichment will be partial because the static build has no reliable way to match every Hilton property to Xotelo.

## GitHub Pages deployment

1. Push this repo to GitHub.
2. In GitHub, go to `Settings -> Pages`.
3. Set the source to `GitHub Actions`.
4. Add the optional secret `RAPIDAPI_KEY` if you want Xotelo search bootstrap during deploys.
5. Push to `main` or run the `Deploy GitHub Pages` workflow manually.

The workflow also refreshes the dataset daily.

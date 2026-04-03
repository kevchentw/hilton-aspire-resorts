# Hilton Aspire Resort Finder

Static GitHub Pages site for browsing Hilton resort-credit eligible hotels on a map and list view, with cached Xotelo price snapshots to help people use the Hilton Honors American Express Aspire semiannual resort credit.

## What it does

- Reads hotel metadata from `public/data/hilton_resort_credit_v3.csv`
- Writes hotel basics to `public/data/resorts.json`
- Writes price-related Xotelo data to `public/data/resort-prices.json`
- Builds a plain static frontend that loads both JSON files and merges them in the browser

## Local development

```bash
npm install
npm run sync:hotels
npm run sync:prices
npm run dev
```

## Sync data

Use the sync command that matches the data you changed:

- `npm run sync:hotels` reads hotel metadata from `public/data/hilton_resort_credit_v3.csv` and writes the hotel list to `public/data/resorts.json`
- `npm run sync:prices` reads the same workbook, merges it with cached metadata, and writes Xotelo price data to `public/data/resort-prices.json`
- `npm run sync:data` runs both commands in sequence for a full refresh

The price sync is designed to be resumable:

- It writes progress to disk after each processed hotel
- It skips hotels that already have successful price snapshots for all requested date windows
- It only refetches hotels that are missing price windows, unless you force a refresh

If you want to test with a smaller batch while tuning the sync script:

```bash
HOTEL_LIMIT=2 npm run sync:prices
```

That still writes the full hotel list, but only fetches fresh Xotelo prices for the first `N` hotels.

If you only want to refresh the price data for one hotel, target it by id:

```bash
HOTEL_ID=conrad-orlando npm run sync:prices
```

You can also target by hotel name:

```bash
HOTEL_NAME="Conrad Orlando" npm run sync:prices
```

If a name matches multiple hotels, the sync stops and asks you to use `HOTEL_ID` so only the intended hotel gets updated.

By default the sync caches 4 upcoming weekend windows for each processed hotel. You can override that with `PRICE_WINDOW_COUNT`, `PRICE_STAY_NIGHTS`, or an explicit `PRICE_WINDOWS=YYYY-MM-DD:YYYY-MM-DD,...`.

To force a full refresh even when cached prices already exist:

```bash
FORCE_REFRESH=1 npm run sync:prices
```

## GitHub Pages deployment

1. Push this repo to GitHub.
2. In GitHub, go to `Settings -> Pages`.
3. Set the source to `GitHub Actions`.
4. Push to `main` or run the `Deploy GitHub Pages` workflow manually.

The workflow can refresh the dataset on a schedule.

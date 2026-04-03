import fs from "node:fs/promises";
import path from "node:path";
import process from "node:process";
import { fileURLToPath } from "node:url";
import XLSX from "xlsx";

const __dirname = path.dirname(fileURLToPath(import.meta.url));
const ROOT = path.resolve(__dirname, "..");
const HOTELS_OUTPUT_PATH = path.join(ROOT, "public", "data", "resorts.json");
const PRICES_OUTPUT_PATH = path.join(ROOT, "public", "data", "resort-prices.json");
const XLSX_PATH = path.join(
  ROOT,
  "public",
  "data",
  process.env.SOURCE_XLSX || "hilton_resort_credit_v3.xlsx",
);

const XOTELO_PUBLIC_URL = "https://data.xotelo.com/api";
const HOTEL_LIMIT = Number(process.env.HOTEL_LIMIT || 0);
const XOTELO_DELAY_MS = Number(process.env.XOTELO_DELAY_MS || 250);
const PRICE_WINDOW_COUNT = Number(process.env.PRICE_WINDOW_COUNT || 4);
const PRICE_STAY_NIGHTS = Number(process.env.PRICE_STAY_NIGHTS || 2);
const TARGET_HOTEL_ID = String(process.env.HOTEL_ID || "").trim();
const TARGET_HOTEL_NAME = String(process.env.HOTEL_NAME || "").trim();
const FORCE_REFRESH = ["1", "true", "yes"].includes(
  String(process.env.FORCE_REFRESH || "").toLowerCase(),
);

const SHEET_NAME = "Hilton Resort Credit Hotels";
const COUNTRY_ALIASES = new Map([
  ["USA", "United States"],
  ["U.S.A.", "United States"],
  ["UAE", "United Arab Emirates"],
]);

function sleep(ms) {
  return new Promise((resolve) => setTimeout(resolve, ms));
}

async function fetchJson(url, init = {}) {
  const response = await fetch(url, init);
  if (!response.ok) {
    throw new Error(`Request failed (${response.status}) for ${url}`);
  }
  return response.json();
}

function slugify(value) {
  return String(value || "")
    .toLowerCase()
    .replace(/&/g, " and ")
    .replace(/[^a-z0-9]+/g, "-")
    .replace(/^-+|-+$/g, "");
}

function normalize(value) {
  return String(value || "")
    .toLowerCase()
    .normalize("NFKD")
    .replace(/[^\w\s-]/g, "")
    .replace(/\s+/g, " ")
    .trim();
}

function unique(values) {
  return [...new Set(values)];
}

function scoreNameMatch(left, right) {
  const a = normalize(left);
  const b = normalize(right);
  if (!a || !b) {
    return 0;
  }
  if (a === b) {
    return 100;
  }
  if (a.includes(b) || b.includes(a)) {
    return 88;
  }

  const aTokens = new Set(a.split(" "));
  const bTokens = new Set(b.split(" "));
  const shared = [...aTokens].filter((token) => bTokens.has(token)).length;
  return Math.round((shared / Math.max(aTokens.size, bTokens.size)) * 70);
}

function toNumber(value) {
  const number = Number(value);
  return Number.isFinite(number) ? number : null;
}

function normalizeCountry(value) {
  return COUNTRY_ALIASES.get(value) || value || null;
}

function decodeHyperlink(target) {
  return String(target || "").replaceAll("&amp;", "&");
}

function extractXoteloKeysFromTripAdvisorUrl(tripAdvisorUrl) {
  const match = String(tripAdvisorUrl || "").match(/-g(\d+)-d(\d+)(?:-|\.html|$)/i);
  if (!match) {
    return null;
  }

  return {
    hotelKey: `g${match[1]}-d${match[2]}`,
    locationKey: `g${match[1]}`,
  };
}

function getSnapshotKey({ checkIn, checkOut }) {
  return `${checkIn}:${checkOut}`;
}

function sortSnapshots(snapshots) {
  return [...snapshots].sort((left, right) => {
    const leftKey = getSnapshotKey(left);
    const rightKey = getSnapshotKey(right);
    return leftKey.localeCompare(rightKey);
  });
}

function normalizeExistingXotelo(record = {}) {
  const snapshots = Array.isArray(record.priceSnapshots) ? record.priceSnapshots : [];

  if (!snapshots.length && record.sampleStay?.checkIn && record.sampleStay?.checkOut) {
    snapshots.push({
      ...record.sampleStay,
      status: record.sampleStay.lowestNightlyRate ? "ok" : "no_rates",
    });
  }

  const normalizedSnapshots = sortSnapshots(
    snapshots.filter((snapshot) => snapshot?.checkIn && snapshot?.checkOut),
  );
  const bestSnapshot =
    normalizedSnapshots
      .filter((snapshot) => typeof snapshot.lowestNightlyRate === "number")
      .sort((left, right) => left.lowestNightlyRate - right.lowestNightlyRate)[0] || null;

  return {
    ...record,
    priceSnapshots: normalizedSnapshots,
    sampleStay: bestSnapshot,
    lastUpdatedAt:
      record.lastUpdatedAt ||
      bestSnapshot?.checkedAt ||
      record.lastSuccessfulRateAt ||
      record.lastSyncedAt ||
      null,
  };
}

function readWorkbookRows() {
  const workbook = XLSX.readFile(XLSX_PATH, {
    cellFormula: false,
    cellHTML: false,
    cellStyles: false,
    cellText: false,
  });
  const sheet = workbook.Sheets[SHEET_NAME] || workbook.Sheets[workbook.SheetNames[0]];
  const rows = XLSX.utils.sheet_to_json(sheet, { defval: null, raw: true });

  return rows.map((row, index) => {
    const excelRow = index + 2;
    const hiltonCell = sheet[`H${excelRow}`];
    const tripAdvisorCell = sheet[`I${excelRow}`];
    const name = row["飯店名稱"];
    const city = row["城市"];
    const country = normalizeCountry(row["國家"]);
    const region = row["地區"];
    const lat = toNumber(row["緯度"]);
    const lng = toNumber(row["經度"]);
    const brand = row["品牌"];
    const hiltonUrl = decodeHyperlink(hiltonCell?.l?.Target);
    const tripAdvisorUrl = decodeHyperlink(tripAdvisorCell?.l?.Target);
    const xoteloKeys = extractXoteloKeysFromTripAdvisorUrl(tripAdvisorUrl);

    return {
      id: slugify(name),
      name,
      brand,
      city: city || null,
      country,
      region: region || null,
      geo:
        lat !== null && lng !== null
          ? {
              lat,
              lng,
            }
          : null,
      hiltonUrl: hiltonUrl || null,
      tripAdvisorUrl: tripAdvisorUrl || null,
      xotelo: xoteloKeys
        ? {
            hotelKey: xoteloKeys.hotelKey,
            locationKey: xoteloKeys.locationKey,
            statusNote: "TripAdvisor URL parsed",
          }
        : {
            statusNote: tripAdvisorUrl ? "TripAdvisor URL could not be parsed" : "TripAdvisor URL missing",
          },
    };
  });
}

async function readJsonFile(filePath, fallback) {
  try {
    const raw = await fs.readFile(filePath, "utf8");
    return JSON.parse(raw);
  } catch {
    return fallback;
  }
}

function buildLegacyPriceMap(existingHotels) {
  return Object.fromEntries(
    existingHotels
      .filter((hotel) => hotel?.id && hotel.xotelo)
      .map((hotel) => [hotel.id, hotel.xotelo]),
  );
}

async function readExistingData() {
  const hotelsPayload = await readJsonFile(HOTELS_OUTPUT_PATH, { meta: {}, hotels: [] });
  const pricesPayload = await readJsonFile(PRICES_OUTPUT_PATH, { meta: {}, prices: {} });
  const normalizedPrices = Object.fromEntries(
    Object.entries(pricesPayload.prices || {}).map(([hotelId, record]) => [
      hotelId,
      normalizeExistingXotelo(record),
    ]),
  );

  return {
    hotels: hotelsPayload.hotels || [],
    prices: {
      ...buildLegacyPriceMap(hotelsPayload.hotels || []),
      ...normalizedPrices,
    },
  };
}

function mergeWithExisting(baseHotels, existingPrices) {
  return baseHotels.map((hotel) => {
    const previous = normalizeExistingXotelo(existingPrices[hotel.id] || {});
    return {
      ...hotel,
      xotelo: {
        ...previous,
        ...hotel.xotelo,
      },
    };
  });
}

function selectTargetHotels(hotels) {
  if (!TARGET_HOTEL_ID && !TARGET_HOTEL_NAME) {
    return hotels.map((hotel, index) => ({ hotel, index }));
  }

  let matches = hotels
    .map((hotel, index) => ({ hotel, index }))
    .filter(({ hotel }) => !TARGET_HOTEL_ID || hotel.id === TARGET_HOTEL_ID);

  if (TARGET_HOTEL_NAME) {
    const normalizedTargetName = normalize(TARGET_HOTEL_NAME);
    const exactNameMatches = matches.filter(({ hotel }) => normalize(hotel.name) === normalizedTargetName);
    const partialNameMatches = matches.filter(({ hotel }) =>
      normalize(hotel.name).includes(normalizedTargetName),
    );

    matches = exactNameMatches.length ? exactNameMatches : partialNameMatches;
  }

  if (!matches.length) {
    throw new Error(
      `No hotel matched HOTEL_ID="${TARGET_HOTEL_ID || "*"}" and HOTEL_NAME="${TARGET_HOTEL_NAME || "*"}".`,
    );
  }

  if (!TARGET_HOTEL_ID && matches.length > 1) {
    const candidateList = unique(matches.map(({ hotel }) => `${hotel.id} (${hotel.name})`));
    throw new Error(
      `HOTEL_NAME="${TARGET_HOTEL_NAME}" matched multiple hotels. Use HOTEL_ID instead. Matches: ${candidateList.join(", ")}`,
    );
  }

  return matches;
}

function computeSampleStayWindows() {
  const explicitWindows = String(process.env.PRICE_WINDOWS || "")
    .split(",")
    .map((item) => item.trim())
    .filter(Boolean)
    .map((item) => {
      const [checkIn, checkOut] = item.split(":").map((part) => part.trim());
      return checkIn && checkOut ? { checkIn, checkOut } : null;
    })
    .filter(Boolean);

  if (explicitWindows.length) {
    return explicitWindows;
  }

  const explicitCheckIn = process.env.PRICE_CHECKIN;
  const explicitCheckOut = process.env.PRICE_CHECKOUT;

  if (explicitCheckIn && explicitCheckOut) {
    return [{ checkIn: explicitCheckIn, checkOut: explicitCheckOut }];
  }

  const today = new Date();
  const base = new Date(Date.UTC(today.getUTCFullYear(), today.getUTCMonth(), today.getUTCDate()));
  const day = base.getUTCDay();
  const daysUntilFriday = (5 - day + 7) % 7 || 7;
  const windows = [];

  for (let index = 0; index < PRICE_WINDOW_COUNT; index += 1) {
    const checkIn = new Date(base);
    checkIn.setUTCDate(base.getUTCDate() + daysUntilFriday + index * 7);
    const checkOut = new Date(checkIn);
    checkOut.setUTCDate(checkIn.getUTCDate() + PRICE_STAY_NIGHTS);
    windows.push({
      checkIn: checkIn.toISOString().slice(0, 10),
      checkOut: checkOut.toISOString().slice(0, 10),
    });
  }

  return windows;
}

function mergeSnapshots(previousSnapshots, nextSnapshots) {
  const snapshotMap = new Map();

  for (const snapshot of previousSnapshots || []) {
    if (snapshot?.checkIn && snapshot?.checkOut) {
      snapshotMap.set(getSnapshotKey(snapshot), snapshot);
    }
  }

  for (const snapshot of nextSnapshots || []) {
    if (snapshot?.checkIn && snapshot?.checkOut) {
      snapshotMap.set(getSnapshotKey(snapshot), snapshot);
    }
  }

  return sortSnapshots([...snapshotMap.values()]);
}

function hasSuccessfulSnapshotForWindow(hotel, sampleWindow) {
  return (hotel.xotelo?.priceSnapshots || []).some(
    (snapshot) =>
      snapshot?.checkIn === sampleWindow.checkIn &&
      snapshot?.checkOut === sampleWindow.checkOut &&
      typeof snapshot?.lowestNightlyRate === "number",
  );
}

function shouldSkipRateFetch(hotel, sampleWindows) {
  if (FORCE_REFRESH) {
    return false;
  }

  if (!sampleWindows.length) {
    return false;
  }

  return sampleWindows.every((sampleWindow) => hasSuccessfulSnapshotForWindow(hotel, sampleWindow));
}

async function fetchXoteloRates(hotel, sampleWindows) {
  const hotelKey = hotel.xotelo?.hotelKey;
  if (!hotelKey) {
    console.log(`Skipping ${hotel.name}: missing parsed Xotelo hotel key`);
    return hotel;
  }

  console.log(
    `Fetching Xotelo rates for ${hotel.name} (${hotelKey}) across ${sampleWindows.length} date window(s)`,
  );

  let indicativeRange = hotel.xotelo?.indicativeRange || null;
  const snapshots = [];

  try {
    const locationKey = hotel.xotelo?.locationKey || hotelKey.split("-")[0];
    const listParams = new URLSearchParams({
      location_key: locationKey,
      limit: "100",
    });
    const listPayload = await fetchJson(`${XOTELO_PUBLIC_URL}/list?${listParams.toString()}`, {
      headers: { Accept: "application/json" },
    });
    const matches = listPayload?.result?.list || [];
    const exact = matches
      .map((candidate) => ({
        ...candidate,
        score: Math.max(
          scoreNameMatch(hotel.name, candidate.name),
          candidate.key === hotelKey ? 100 : 0,
        ),
      }))
      .sort((a, b) => b.score - a.score)[0];

    if (exact?.score >= 70) {
      indicativeRange = {
        minimum: exact.price_ranges?.minimum || null,
        maximum: exact.price_ranges?.maximum || null,
        currency: "USD",
      };
    }
  } catch {
    // Best effort only.
  }

  for (const sampleWindow of sampleWindows) {
    const rateParams = new URLSearchParams({
      hotel_key: hotelKey,
      chk_in: sampleWindow.checkIn,
      chk_out: sampleWindow.checkOut,
    });

    console.log(`  Window ${sampleWindow.checkIn} -> ${sampleWindow.checkOut}`);

    const payload = await fetchJson(`${XOTELO_PUBLIC_URL}/rates?${rateParams.toString()}`, {
      headers: {
        Accept: "application/json",
      },
    });

    const rates = payload?.result?.rates || [];
    const sortedRates = [...rates].sort((a, b) => a.rate - b.rate);
    const lowest = sortedRates[0];
    const snapshot = {
      checkIn: sampleWindow.checkIn,
      checkOut: sampleWindow.checkOut,
      currency: payload?.result?.currency || "USD",
      lowestNightlyRate: lowest?.rate ?? null,
      taxes: lowest?.tax ?? null,
      vendorCode: lowest?.code || null,
      vendorName: lowest?.name || null,
      checkedAt: new Date(payload?.timestamp || Date.now()).toISOString(),
      status: lowest ? "ok" : "no_rates",
    };

    snapshots.push(snapshot);

    console.log(
      lowest
        ? `  Received ${rates.length} rate(s); lowest ${snapshot.currency} ${lowest.rate}`
        : "  No public rates returned",
    );
  }

  const mergedSnapshots = mergeSnapshots(hotel.xotelo?.priceSnapshots || [], snapshots);
  const bestSnapshot =
    mergedSnapshots
      .filter((snapshot) => typeof snapshot.lowestNightlyRate === "number")
      .sort((left, right) => left.lowestNightlyRate - right.lowestNightlyRate)[0] || null;
  const lastSyncedAt = new Date().toISOString();

  return {
    ...hotel,
    xotelo: {
      ...(hotel.xotelo || {}),
      indicativeRange,
      priceSnapshots: mergedSnapshots,
      sampleStay: bestSnapshot,
      lastSyncedAt,
      lastSuccessfulRateAt: bestSnapshot?.checkedAt || hotel.xotelo?.lastSuccessfulRateAt || null,
      lastUpdatedAt: bestSnapshot?.checkedAt || lastSyncedAt,
      statusNote: bestSnapshot
        ? "Public Xotelo rates synced"
        : hotel.xotelo?.statusNote || "No public Xotelo rates returned",
    },
  };
}

async function enrichXotelo(hotels, limit = 0, onProgress = async () => {}) {
  const sampleWindows = computeSampleStayWindows();
  const targetHotels = selectTargetHotels(hotels);
  const hotelsToProcess = limit > 0 ? targetHotels.slice(0, limit) : targetHotels;
  const processedCount = hotelsToProcess.length;
  const workingHotels = [...hotels];
  let completedCount = 0;

  if ((TARGET_HOTEL_ID || TARGET_HOTEL_NAME) && targetHotels.length) {
    console.log(
      `Targeting ${targetHotels.length} hotel(s) for price sync: ${targetHotels
        .map(({ hotel }) => hotel.id)
        .join(", ")}`,
    );
  }

  if (limit > 0) {
    console.log(
      `Applying HOTEL_LIMIT=${limit}; fetching Xotelo data for ${processedCount} of ${targetHotels.length} targeted hotel(s).`,
    );
  }

  for (const [sequenceIndex, { hotel, index }] of hotelsToProcess.entries()) {
    let nextHotel = hotel;
    console.log(`Processing hotel ${sequenceIndex + 1}/${processedCount}: ${hotel.name}`);

    if (shouldSkipRateFetch(nextHotel, sampleWindows)) {
      console.log(`Skipping ${hotel.name}: all requested price windows already cached`);
      nextHotel = {
        ...nextHotel,
        xotelo: {
          ...(nextHotel.xotelo || {}),
          statusNote: nextHotel.xotelo?.statusNote || "Cached Xotelo prices already available",
        },
      };
    } else {
      try {
        nextHotel = await fetchXoteloRates(nextHotel, sampleWindows);
      } catch (error) {
        console.log(`Failed Xotelo sync for ${hotel.name}: ${error.message}`);
        nextHotel = {
          ...nextHotel,
          xotelo: {
            ...(nextHotel.xotelo || {}),
            lastSyncedAt: new Date().toISOString(),
            lastUpdatedAt:
              nextHotel.xotelo?.lastUpdatedAt || nextHotel.xotelo?.lastSuccessfulRateAt || null,
            statusNote: `Public Xotelo sync failed: ${error.message}`,
          },
        };
      }
    }

    workingHotels[index] = nextHotel;
    completedCount += 1;
    await onProgress({
      hotels: workingHotels,
      sampleWindows,
      processedCount,
      completedCount,
    });
    await sleep(XOTELO_DELAY_MS);
  }

  return { hotels: workingHotels, sampleWindows, processedCount, completedCount };
}

async function ensureOutputDirectory() {
  await fs.mkdir(path.dirname(HOTELS_OUTPUT_PATH), { recursive: true });
}

function buildHotelsPayload(hotels, meta) {
  return {
    meta,
    hotels: hotels.map(({ xotelo, ...hotel }) => hotel),
  };
}

function buildPricesPayload(hotels, meta) {
  return {
    meta,
    prices: Object.fromEntries(
      hotels
        .filter((hotel) => hotel.id)
        .map((hotel) => [hotel.id, hotel.xotelo || {}]),
    ),
  };
}

async function writeHotelsPayload(hotels, meta) {
  const hotelsPayload = buildHotelsPayload(hotels, {
    generatedAt: meta.generatedAt,
    sourceFile: meta.sourceFile,
    hotelCount: meta.hotelCount,
  });

  await ensureOutputDirectory();
  await fs.writeFile(HOTELS_OUTPUT_PATH, `${JSON.stringify(hotelsPayload, null, 2)}\n`, "utf8");
}

async function writePricesPayload(hotels, meta) {
  const pricesPayload = buildPricesPayload(hotels, meta);

  await ensureOutputDirectory();
  await fs.writeFile(PRICES_OUTPUT_PATH, `${JSON.stringify(pricesPayload, null, 2)}\n`, "utf8");
}

async function loadHotelsWithExistingPrices() {
  const existing = await readExistingData();
  const hotels = mergeWithExisting(readWorkbookRows(), existing.prices || {});
  const sourceFile = path.relative(ROOT, XLSX_PATH);

  return {
    hotels,
    existing,
    sourceFile,
  };
}

export async function syncHotels() {
  console.log(`Reading source workbook: ${path.relative(ROOT, XLSX_PATH)}`);
  const { hotels, sourceFile } = await loadHotelsWithExistingPrices();

  console.log(`Loaded ${hotels.length} hotel row(s) from workbook.`);

  await writeHotelsPayload(hotels, {
    generatedAt: new Date().toISOString(),
    sourceFile,
    hotelCount: hotels.length,
  });

  console.log(`Synced ${hotels.length} hotels to ${path.relative(ROOT, HOTELS_OUTPUT_PATH)}.`);
}

export async function syncPrices() {
  console.log(`Reading source workbook: ${path.relative(ROOT, XLSX_PATH)}`);
  const { hotels, sourceFile } = await loadHotelsWithExistingPrices();

  console.log(`Loaded ${hotels.length} hotel row(s) from workbook.`);

  const xoteloResult = await enrichXotelo(hotels, HOTEL_LIMIT, async (progress) => {
    await writePricesPayload(progress.hotels, {
      generatedAt: new Date().toISOString(),
      sourceFile,
      hotelCount: progress.hotels.length,
      processedHotelCount: progress.processedCount,
      completedHotelCount: progress.completedCount,
      sampleStay: progress.sampleWindows[0] || null,
      sampleWindows: progress.sampleWindows,
      priceSource: "xotelo-rates-from-tripadvisor-url",
    });
    console.log(
      `Flushed progress to ${path.relative(ROOT, PRICES_OUTPUT_PATH)} (${progress.completedCount}/${progress.processedCount})`,
    );
  });

  await writePricesPayload(xoteloResult.hotels, {
    generatedAt: new Date().toISOString(),
    sourceFile,
    hotelCount: xoteloResult.hotels.length,
    processedHotelCount: xoteloResult.processedCount,
    completedHotelCount: xoteloResult.completedCount,
    sampleStay: xoteloResult.sampleWindows[0] || null,
    sampleWindows: xoteloResult.sampleWindows,
    priceSource: "xotelo-rates-from-tripadvisor-url",
  });

  console.log(`Synced prices for ${xoteloResult.hotels.length} hotels to ${path.relative(ROOT, PRICES_OUTPUT_PATH)}.`);
}

export async function syncAllData() {
  await syncHotels();
  await syncPrices();
}

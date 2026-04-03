import fs from "node:fs/promises";
import path from "node:path";
import process from "node:process";
import { fileURLToPath } from "node:url";
import * as cheerio from "cheerio";

const __dirname = path.dirname(fileURLToPath(import.meta.url));
const ROOT = path.resolve(__dirname, "..");
const OUTPUT_PATH = path.join(ROOT, "public", "data", "resorts.json");

const HILTON_SOURCE_URL =
  "https://www.hilton.com/en/p/hilton-honors/resort-credit-eligible-hotels/";
const NOMINATIM_URL = "https://nominatim.openstreetmap.org/search";
const XOTELO_PUBLIC_URL = "https://data.xotelo.com/api";
const XOTELO_RAPIDAPI_HOST =
  process.env.RAPIDAPI_HOST || "xotelo-hotel-prices.p.rapidapi.com";
const XOTELO_RAPIDAPI_URL = `https://${XOTELO_RAPIDAPI_HOST}/api/search`;
const HOTEL_LIMIT = Number(process.env.HOTEL_LIMIT || 0);

const USER_AGENT =
  process.env.SYNC_USER_AGENT ||
  "hilton-aspire-resorts-sync/0.1 (+https://github.com/USER/REPO)";

const BRAND_RULES = [
  ["Conrad Hotels & Resorts", /(conrad)/i],
  ["Curio Collection by Hilton", /(curio|aulus lindos|keight hotel opatija)/i],
  ["DoubleTree by Hilton", /(doubletree|doubletree resort|doubletree suites|grand naniloa|highline vail)/i],
  ["Embassy Suites by Hilton", /(embassy suites)/i],
  ["Hampton by Hilton", /(hampton by hilton)/i],
  [
    "Hilton Grand Vacations Club",
    /(hilton grand vacations club|hilton vacation club|hilton club the beach resort sesoko)/i,
  ],
  [
    "Hilton Hotels & Resorts",
    /(hilton |caribe hilton|surfers paradise hilton|the condado plaza hotel|the lodge at gulf state park, a hilton hotel|the waterfront beach resort, a hilton hotel|beach house fort lauderdale, a hilton resort|cape rey carlsbad beach, a hilton resort and spa|el conquistador tucson, a hilton resort|the inverness denver, a hilton golf & spa resort)/i,
  ],
  ["Homewood Suites by Hilton", /(homewood suites)/i],
  ["LXR Hotels & Resorts", /(lxr hotels & resorts|crockfords las vegas|ka la'i waikiki beach)/i],
  ["Signia by Hilton", /(signia by hilton)/i],
  ["Tapestry Collection by Hilton", /(tapestry collection by hilton|fuwairit kite beach)/i],
  ["Waldorf Astoria Hotels & Resorts", /(waldorf astoria|grand wailea|rome cavalieri)/i],
];

const FALLBACK_BRAND = "Hilton Hotels & Resorts";

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

async function fetchText(url, init = {}) {
  const response = await fetch(url, init);
  if (!response.ok) {
    throw new Error(`Request failed (${response.status}) for ${url}`);
  }
  return response.text();
}

function slugify(value) {
  return value
    .toLowerCase()
    .replace(/&/g, " and ")
    .replace(/[^a-z0-9]+/g, "-")
    .replace(/^-+|-+$/g, "");
}

function normalize(value) {
  return value
    .toLowerCase()
    .normalize("NFKD")
    .replace(/[^\w\s-]/g, "")
    .replace(/\s+/g, " ")
    .trim();
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
    return 84;
  }

  const aTokens = new Set(a.split(" "));
  const bTokens = new Set(b.split(" "));
  const shared = [...aTokens].filter((token) => bTokens.has(token)).length;
  return Math.round((shared / Math.max(aTokens.size, bTokens.size)) * 70);
}

function inferBrand(name) {
  for (const [brand, pattern] of BRAND_RULES) {
    if (pattern.test(name)) {
      return brand;
    }
  }
  return FALLBACK_BRAND;
}

function resolveHiltonUrl(href) {
  if (!href) {
    return null;
  }
  if (href.startsWith("http://") || href.startsWith("https://")) {
    return href;
  }
  return new URL(href, "https://www.hilton.com").toString();
}

function hotelSlugToQuery(hotel) {
  try {
    const url = new URL(hotel.hiltonUrl);
    const parts = url.pathname.split("/").filter(Boolean);
    const slug = parts.at(-1) || "";
    return slug
      .replace(/^[a-z0-9]+-/, "")
      .replace(/-/g, " ")
      .trim();
  } catch {
    return "";
  }
}

function stripBrandDecorators(name) {
  return name
    .replace(/\s*,\s*Curio Collection by Hilton.*$/i, "")
    .replace(/\s*,\s*LXR Hotels? & Resorts.*$/i, "")
    .replace(/\s*,\s*Tapestry Collection by Hilton.*$/i, "")
    .replace(/\s*,\s*A Waldorf Astoria (Resort|Hotel).*$/i, "")
    .replace(/\s*,\s*A Hilton Resort.*$/i, "")
    .replace(/\s*-\s*a DoubleTree by Hilton.*$/i, "")
    .replace(/\s*-\s*a Hilton Resort.*$/i, "")
    .replace(/\s*by Hilton.*$/i, "")
    .trim();
}

function uniqueValues(values) {
  return [...new Set(values.filter(Boolean))];
}

function buildGeocodeQueries(hotel) {
  const stripped = stripBrandDecorators(hotel.name);
  const slugQuery = hotelSlugToQuery(hotel);

  return uniqueValues([
    hotel.name,
    `${hotel.name} hotel`,
    stripped,
    `${stripped} hotel`,
    slugQuery,
    `${slugQuery} hotel`,
    `${stripped} ${slugQuery}`.trim(),
  ]);
}

function formatLocationLabel(result) {
  const address = result.address || {};
  const parts = uniqueValues([
    address.city,
    address.town,
    address.village,
    address.municipality,
    address.state,
    address.region,
    address.country,
  ]);

  return parts.length ? parts.join(", ") : result.display_name;
}

function parseHiltonHotels(html) {
  const $ = cheerio.load(html);
  const hotels = [];
  const seen = new Set();

  $("a[href]").each((_, element) => {
    const link = $(element);
    const href = link.attr("href");
    const name = link.text().replace(/\s+/g, " ").trim();

    if (!name || name.length < 4) {
      return;
    }

    const absoluteHref = resolveHiltonUrl(href);
    if (!absoluteHref) {
      return;
    }

    const isHotelLink =
      absoluteHref.includes("/en/hotels/") ||
      absoluteHref.includes("grandwailea.com") ||
      absoluteHref.includes("romecavalieri.com");

    if (!isHotelLink) {
      return;
    }

    const id = slugify(name);
    if (seen.has(id)) {
      return;
    }

    seen.add(id);
    hotels.push({
      id,
      name,
      brand: inferBrand(name),
      hiltonUrl: absoluteHref,
    });
  });

  return hotels.sort((a, b) => a.name.localeCompare(b.name));
}

async function readExistingData() {
  try {
    const raw = await fs.readFile(OUTPUT_PATH, "utf8");
    return JSON.parse(raw);
  } catch {
    return { meta: {}, hotels: [] };
  }
}

function mergeWithExisting(freshHotels, existingHotels) {
  const existingMap = new Map(existingHotels.map((hotel) => [hotel.id, hotel]));
  return freshHotels.map((hotel) => {
    const previous = existingMap.get(hotel.id) || {};
    return {
      ...previous,
      ...hotel,
      geocode: previous.geocode || null,
      xotelo: previous.xotelo || {},
      locationLabel: previous.locationLabel || null,
    };
  });
}

async function geocodeHotel(hotel) {
  for (const query of buildGeocodeQueries(hotel)) {
    const searchParams = new URLSearchParams({
      q: query,
      format: "jsonv2",
      limit: "1",
      addressdetails: "1",
    });

    const results = await fetchJson(`${NOMINATIM_URL}?${searchParams.toString()}`, {
      headers: {
        "User-Agent": USER_AGENT,
        Accept: "application/json",
      },
    });

    if (!results.length) {
      continue;
    }

    const [best] = results;
    return {
      ...hotel,
      geo: {
        lat: Number(best.lat),
        lng: Number(best.lon),
      },
      geocode: {
        source: "nominatim",
        displayName: best.display_name,
        query,
        lastSyncedAt: new Date().toISOString(),
      },
      locationLabel: formatLocationLabel(best),
    };
  }

  return hotel;
}

async function enrichGeo(hotels) {
  const enriched = [];
  let rateLimited = false;

  for (const hotel of hotels) {
    if (hotel.geo?.lat && hotel.geo?.lng) {
      enriched.push(hotel);
      continue;
    }

    if (rateLimited) {
      enriched.push({
        ...hotel,
        geocode: hotel.geocode || {
          source: "nominatim",
          error: "Skipped after upstream rate limit; rerun later or rely on Xotelo bootstrap",
          lastSyncedAt: new Date().toISOString(),
        },
      });
      continue;
    }

    try {
      const updated = await geocodeHotel(hotel);
      enriched.push(updated);
    } catch (error) {
      if (error.message.includes("(429)")) {
        rateLimited = true;
      }

      enriched.push({
        ...hotel,
        geocode: {
          source: "nominatim",
          error: error.message,
          lastSyncedAt: new Date().toISOString(),
        },
      });
    }

    await sleep(500);
  }

  return enriched;
}

async function bootstrapHotelKey(hotel) {
  const rapidApiKey = process.env.RAPIDAPI_KEY;
  if (hotel.xotelo?.hotelKey) {
    return hotel;
  }

  if (!rapidApiKey) {
    return {
      ...hotel,
      xotelo: {
        ...(hotel.xotelo || {}),
        statusNote: "Add RAPIDAPI_KEY during deploy to unlock Xotelo matching and fuller map coverage",
      },
    };
  }

  const searchParams = new URLSearchParams({ query: hotel.name });
  const payload = await fetchJson(`${XOTELO_RAPIDAPI_URL}?${searchParams.toString()}`, {
    headers: {
      "X-RapidAPI-Key": rapidApiKey,
      "X-RapidAPI-Host": XOTELO_RAPIDAPI_HOST,
      Accept: "application/json",
    },
  });

  const candidates = payload?.result?.list || [];
  const best = [...candidates]
    .map((candidate) => ({
      ...candidate,
      score: scoreNameMatch(hotel.name, candidate.name),
    }))
    .sort((a, b) => b.score - a.score)[0];

  if (!best || best.score < 55) {
    return {
      ...hotel,
      xotelo: {
        ...(hotel.xotelo || {}),
        statusNote: "RapidAPI search could not confidently match this hotel",
      },
    };
  }

  return {
    ...hotel,
    xotelo: {
      ...(hotel.xotelo || {}),
      hotelKey: best.hotel_key,
      locationKey: best.location_key || best.hotel_key?.split("-")[0] || null,
      placeName: best.place_name || null,
      shortPlaceName: best.short_place_name || null,
      streetAddress: best.street_address || null,
      image: best.image || null,
      searchMatchedName: best.name,
      statusNote: "Matched with Xotelo search",
      lastMatchedAt: new Date().toISOString(),
    },
    locationLabel: hotel.locationLabel || best.short_place_name || best.place_name || null,
  };
}

function computeSampleStayWindow() {
  const explicitCheckIn = process.env.PRICE_CHECKIN;
  const explicitCheckOut = process.env.PRICE_CHECKOUT;

  if (explicitCheckIn && explicitCheckOut) {
    return { checkIn: explicitCheckIn, checkOut: explicitCheckOut };
  }

  const today = new Date();
  const base = new Date(Date.UTC(today.getUTCFullYear(), today.getUTCMonth(), today.getUTCDate()));
  const day = base.getUTCDay();
  const daysUntilFriday = (5 - day + 7) % 7 || 7;
  const checkIn = new Date(base);
  checkIn.setUTCDate(base.getUTCDate() + daysUntilFriday);
  const checkOut = new Date(checkIn);
  checkOut.setUTCDate(checkIn.getUTCDate() + 2);

  return {
    checkIn: checkIn.toISOString().slice(0, 10),
    checkOut: checkOut.toISOString().slice(0, 10),
  };
}

async function fetchXoteloRates(hotel, sampleWindow) {
  const hotelKey = hotel.xotelo?.hotelKey;
  if (!hotelKey) {
    return hotel;
  }

  const rateParams = new URLSearchParams({
    hotel_key: hotelKey,
    chk_in: sampleWindow.checkIn,
    chk_out: sampleWindow.checkOut,
  });

  const payload = await fetchJson(`${XOTELO_PUBLIC_URL}/rates?${rateParams.toString()}`, {
    headers: {
      Accept: "application/json",
    },
  });

  const rates = payload?.result?.rates || [];
  const sortedRates = [...rates].sort((a, b) => a.rate - b.rate);
  const lowest = sortedRates[0];

  let indicativeRange = hotel.xotelo?.indicativeRange || null;

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

      if (!hotel.geo?.lat && exact.geo?.latitude && exact.geo?.longitude) {
        hotel.geo = {
          lat: Number(exact.geo.latitude),
          lng: Number(exact.geo.longitude),
        };
      }

      if (!hotel.locationLabel) {
        hotel.locationLabel = exact.name;
      }
    }
  } catch {
    // The public list endpoint is best-effort enrichment only.
  }

  return {
    ...hotel,
    xotelo: {
      ...(hotel.xotelo || {}),
      indicativeRange,
      sampleStay: lowest
        ? {
            checkIn: sampleWindow.checkIn,
            checkOut: sampleWindow.checkOut,
            currency: payload?.result?.currency || "USD",
            lowestNightlyRate: lowest.rate,
            taxes: lowest.tax ?? null,
            vendorCode: lowest.code,
            vendorName: lowest.name,
            checkedAt: new Date(payload?.timestamp || Date.now()).toISOString(),
          }
        : null,
      statusNote: lowest
        ? "Public Xotelo rates synced"
        : hotel.xotelo?.statusNote || "No public Xotelo rates returned",
    },
  };
}

async function enrichXotelo(hotels) {
  const sampleWindow = computeSampleStayWindow();
  const enriched = [];

  for (const hotel of hotels) {
    let nextHotel = hotel;

    try {
      nextHotel = await bootstrapHotelKey(nextHotel);
    } catch (error) {
      nextHotel = {
        ...nextHotel,
        xotelo: {
          ...(nextHotel.xotelo || {}),
          statusNote: `RapidAPI bootstrap failed: ${error.message}`,
        },
      };
    }

    try {
      nextHotel = await fetchXoteloRates(nextHotel, sampleWindow);
    } catch (error) {
      nextHotel = {
        ...nextHotel,
        xotelo: {
          ...(nextHotel.xotelo || {}),
          statusNote: `Public Xotelo sync failed: ${error.message}`,
        },
      };
    }

    enriched.push(nextHotel);
    await sleep(250);
  }

  return { hotels: enriched, sampleWindow };
}

async function ensureOutputDirectory() {
  await fs.mkdir(path.dirname(OUTPUT_PATH), { recursive: true });
}

async function main() {
  const existing = await readExistingData();
  const html = await fetchText(HILTON_SOURCE_URL, {
    headers: {
      "User-Agent": USER_AGENT,
      Accept: "text/html",
    },
  });

  let hotels = parseHiltonHotels(html);
  if (HOTEL_LIMIT > 0) {
    hotels = hotels.slice(0, HOTEL_LIMIT);
  }

  hotels = mergeWithExisting(hotels, existing.hotels || []);
  const xoteloResult = await enrichXotelo(hotels);
  hotels = await enrichGeo(xoteloResult.hotels);

  const payload = {
    meta: {
      generatedAt: new Date().toISOString(),
      sourceUrl: HILTON_SOURCE_URL,
      hotelCount: hotels.length,
      sampleStay: xoteloResult.sampleWindow,
      rapidApiBootstrapEnabled: Boolean(process.env.RAPIDAPI_KEY),
    },
    hotels,
  };

  await ensureOutputDirectory();
  await fs.writeFile(OUTPUT_PATH, `${JSON.stringify(payload, null, 2)}\n`, "utf8");

  console.log(
    `Synced ${payload.meta.hotelCount} hotels to ${path.relative(ROOT, OUTPUT_PATH)}.`,
  );
}

main().catch((error) => {
  console.error(error);
  process.exitCode = 1;
});

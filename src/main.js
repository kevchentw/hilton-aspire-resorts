import "./styles.css";

const HOTELS_URL = "./data/resorts.json";
const PRICES_URL = "./data/resort-prices.json";
const TRIPADVISOR_ENRICHMENT_URL = "./data/tripadvisor-search-enrichment.json";

const state = {
  hotels: [],
  filteredHotels: [],
  selectedHotelId: null,
  search: "",
  brand: "all",
  country: "all",
  region: "all",
  maxPrice: "all",
  view: "map",
  meta: {},
  syncSelectionToUrl: false,
};

let map;
let markersLayer;
let dom = {};

function normalizeHashPath(hash = window.location.hash) {
  return hash.replace(/^#/, "").replace(/\/+$/, "");
}

function readHotelIdFromUrl() {
  const hashPath = normalizeHashPath();
  const match = hashPath.match(/^\/hotel\/([^/]+)$/);
  return match ? decodeURIComponent(match[1]) : null;
}

function buildHotelHash(hotelId) {
  return hotelId ? `#/hotel/${encodeURIComponent(hotelId)}` : "#/";
}

function updateHotelUrl(hotelId, { replace = false } = {}) {
  const nextHash = buildHotelHash(hotelId);
  if (window.location.hash === nextHash) {
    return;
  }

  const nextUrl = `${window.location.pathname}${window.location.search}${nextHash}`;
  if (replace) {
    window.history.replaceState({}, "", nextUrl);
    return;
  }

  window.history.pushState({}, "", nextUrl);
}

function escapeHtml(value) {
  return String(value ?? "")
    .replaceAll("&", "&amp;")
    .replaceAll("<", "&lt;")
    .replaceAll(">", "&gt;")
    .replaceAll('"', "&quot;")
    .replaceAll("'", "&#39;");
}

function formatCurrency(value, currency = "USD") {
  if (typeof value !== "number" || Number.isNaN(value)) {
    return "N/A";
  }

  return new Intl.NumberFormat("en-US", {
    style: "currency",
    currency,
    maximumFractionDigits: 0,
  }).format(value);
}

function formatDateLabel(value, options = {}) {
  if (!value) {
    return "Unknown date";
  }

  const parsed = new Date(`${value}T00:00:00`);
  if (Number.isNaN(parsed.getTime())) {
    return value;
  }

  return parsed.toLocaleDateString("en-US", {
    month: "short",
    day: "numeric",
    ...options,
  });
}

function normalizeText(value) {
  return (value || "").toLowerCase();
}

function uniqueValues(values) {
  return [...new Set(values.filter(Boolean))];
}

function toFiniteNumber(value) {
  const number = Number(value);
  return Number.isFinite(number) ? number : null;
}

function formatReviewCount(value) {
  const reviewCount = toFiniteNumber(value);
  if (reviewCount === null) {
    return null;
  }

  return new Intl.NumberFormat("en-US").format(reviewCount);
}

function getTripAdvisorData(hotel) {
  return hotel.tripAdvisorEnrichment || null;
}

function getCoordinates(hotel) {
  const lat =
    toFiniteNumber(hotel.geo?.lat) ??
    toFiniteNumber(hotel.lat) ??
    toFiniteNumber(hotel.latitude) ??
    null;
  const lng =
    toFiniteNumber(hotel.geo?.lng) ??
    toFiniteNumber(hotel.lng) ??
    toFiniteNumber(hotel.lon) ??
    toFiniteNumber(hotel.longitude) ??
    null;

  return lat !== null && lng !== null ? { lat, lng } : null;
}

function getLocationData(hotel) {
  return {
    city:
      hotel.city ||
      hotel.xotelo?.shortPlaceName ||
      hotel.xotelo?.placeName ||
      null,
    region: hotel.region || hotel.state || null,
    country: hotel.country || null,
    countryCode: hotel.countryCode || null,
  };
}

function getPriceSnapshots(hotel) {
  const snapshots = hotel.xotelo?.priceSnapshots;
  if (Array.isArray(snapshots) && snapshots.length) {
    return [...snapshots].sort((left, right) =>
      `${left.checkIn}:${left.checkOut}`.localeCompare(`${right.checkIn}:${right.checkOut}`),
    );
  }

  return hotel.xotelo?.sampleStay ? [hotel.xotelo.sampleStay] : [];
}

function normalizeSnapshotStay(snapshot) {
  if (!snapshot?.checkIn || !snapshot?.checkOut) {
    return snapshot;
  }

  return snapshot.checkIn <= snapshot.checkOut
    ? snapshot
    : {
        ...snapshot,
        checkIn: snapshot.checkOut,
        checkOut: snapshot.checkIn,
      };
}

function getBestSnapshot(hotel) {
  return (
    getPriceSnapshots(hotel)
      .map((snapshot) => normalizeSnapshotStay(snapshot))
      .filter((snapshot) => typeof snapshot.lowestNightlyRate === "number")
      .sort((left, right) => left.lowestNightlyRate - right.lowestNightlyRate)[0] || null
  );
}

function getPriceBounds(hotel) {
  const pricedSnapshots = getPricedSnapshots(hotel);
  if (pricedSnapshots.length) {
    return {
      minimum: pricedSnapshots[0].lowestNightlyRate,
      maximum: pricedSnapshots.at(-1).lowestNightlyRate,
      currency: pricedSnapshots[0].currency,
      sampleCount: pricedSnapshots.length,
    };
  }

  const range = hotel.xotelo?.indicativeRange;
  if (range?.minimum && range?.maximum) {
    return {
      minimum: range.minimum,
      maximum: range.maximum,
      currency: range.currency,
      sampleCount: 0,
    };
  }

  return null;
}

function getLastUpdated(hotel) {
  return (
    hotel.xotelo?.lastUpdatedAt ||
    hotel.xotelo?.lastSuccessfulRateAt ||
    getPriceSnapshots(hotel)
      .map((snapshot) => snapshot.checkedAt)
      .filter(Boolean)
      .sort()
      .at(-1) ||
    null
  );
}

function buildPriceLabel(hotel) {
  const bounds = getPriceBounds(hotel);
  if (bounds?.minimum && bounds?.maximum) {
    return bounds.minimum === bounds.maximum
      ? `${formatCurrency(bounds.minimum, bounds.currency)} / night`
      : `${formatCurrency(bounds.minimum, bounds.currency)}-${formatCurrency(
          bounds.maximum,
          bounds.currency,
        )} / night`;
  }

  return "Price pending";
}

function buildPriceSubLabel(hotel) {
  const sample = getBestSnapshot(hotel);
  const pricedSnapshots = getPricedSnapshots(hotel);
  const bounds = getPriceBounds(hotel);
  if (sample?.lowestNightlyRate) {
    return pricedSnapshots.length > 1
      ? `Lowest sampled rate across ${pricedSnapshots.length} stays`
      : `Reference stay ${formatDateLabel(sample.checkIn)} to ${formatDateLabel(sample.checkOut)}`;
  }

  if (bounds?.minimum && bounds?.maximum) {
    return "Reference price range";
  }

  return "Reference price unavailable";
}

function getEffectivePrice(hotel) {
  return (
    getBestSnapshot(hotel)?.lowestNightlyRate ||
    hotel.xotelo?.indicativeRange?.minimum ||
    null
  );
}

function getPriceCeiling(hotel) {
  const bounds = getPriceBounds(hotel);
  return bounds?.maximum ?? null;
}

function getPriceBand(hotel) {
  const lowestPrice = getEffectivePrice(hotel);
  if (lowestPrice === null) {
    return "unknown";
  }

  if (lowestPrice <= 200) {
    return "200";
  }

  if (lowestPrice <= 300) {
    return "300";
  }

  if (lowestPrice <= 400) {
    return "400";
  }

  if (lowestPrice <= 500) {
    return "500";
  }

  return "over";
}

function getPricedSnapshots(hotel) {
  return getPriceSnapshots(hotel)
    .map((snapshot) => normalizeSnapshotStay(snapshot))
    .filter((snapshot) => typeof snapshot.lowestNightlyRate === "number")
    .sort((left, right) => left.lowestNightlyRate - right.lowestNightlyRate);
}

function getUnpricedSnapshots(hotel) {
  return getPriceSnapshots(hotel)
    .map((snapshot) => normalizeSnapshotStay(snapshot))
    .filter((snapshot) => typeof snapshot.lowestNightlyRate !== "number");
}

function formatStayWindow(snapshot, options = {}) {
  if (!snapshot?.checkIn && !snapshot?.checkOut) {
    return "Dates unavailable";
  }

  const checkInLabel = formatDateLabel(snapshot.checkIn, options);
  const checkOutLabel = formatDateLabel(snapshot.checkOut, options);
  return `${checkInLabel} to ${checkOutLabel}`;
}

function getLocationLabel(hotel) {
  const location = getLocationData(hotel);
  return (
    uniqueValues([location.city, location.region, location.country]).join(", ") ||
    hotel.xotelo?.shortPlaceName ||
    hotel.xotelo?.placeName ||
    "Location pending"
  );
}

function buildGoogleMapsUrl(hotel) {
  const query = `${hotel.name} ${getLocationLabel(hotel)}`;
  return `https://www.google.com/maps/search/?api=1&query=${encodeURIComponent(query)}`;
}

function sortHotels(hotels) {
  return [...hotels].sort((a, b) => {
    const priceA = getEffectivePrice(a);
    const priceB = getEffectivePrice(b);

    if (priceA !== null && priceB !== null && priceA !== priceB) {
      return priceA - priceB;
    }

    if (priceA !== null && priceB === null) {
      return -1;
    }

    if (priceA === null && priceB !== null) {
      return 1;
    }

    return a.name.localeCompare(b.name);
  });
}

function applyFilters() {
  const search = normalizeText(state.search);

  state.filteredHotels = sortHotels(
    state.hotels.filter((hotel) => {
      const location = getLocationData(hotel);
      const haystack = normalizeText(
        `${hotel.name} ${hotel.brand} ${location.city || ""} ${location.region || ""} ${location.country || ""}`,
      );
      const priceCeiling = getPriceCeiling(hotel);
      const maxPrice = state.maxPrice === "all" ? null : Number(state.maxPrice);

      if (search && !haystack.includes(search)) {
        return false;
      }

      if (state.brand !== "all" && hotel.brand !== state.brand) {
        return false;
      }

      if (state.country !== "all" && location.country !== state.country) {
        return false;
      }

      if (state.region !== "all" && location.region !== state.region) {
        return false;
      }

      if (maxPrice !== null && (priceCeiling === null || priceCeiling > maxPrice)) {
        return false;
      }

      return true;
    }),
  );
}

function ensureSelectedHotel() {
  if (!state.filteredHotels.length) {
    state.selectedHotelId = null;
    return;
  }

  const stillVisible = state.filteredHotels.some((hotel) => hotel.id === state.selectedHotelId);
  if (!stillVisible) {
    state.selectedHotelId = state.filteredHotels[0].id;
  }
}

function getSelectedHotel() {
  return state.filteredHotels.find((hotel) => hotel.id === state.selectedHotelId) || null;
}

function updateMeta(meta) {
  const filtered = state.filteredHotels.length;
  const total = state.hotels.length;

  dom.resultsCount.textContent = `${filtered} of ${total} hotels`;
  dom.generatedAt.textContent = meta.generatedAt
    ? `Updated ${new Date(meta.generatedAt).toLocaleString("en-US", {
        dateStyle: "medium",
        timeStyle: "short",
      })}`
    : "Not synced yet";
}

function createHotelRow(hotel) {
  const row = document.createElement("tr");
  row.className = "hotel-row";
  row.dataset.hotelId = hotel.id;
  row.tabIndex = 0;

  const location = getLocationData(hotel);

  row.innerHTML = `
    <td class="hotel-cell hotel-cell--name">
      <strong>${escapeHtml(hotel.name)}</strong>
      <span>${escapeHtml(hotel.brand)}</span>
    </td>
    <td class="hotel-cell">${escapeHtml(location.city || "Unknown")}</td>
    <td class="hotel-cell">${escapeHtml(location.country || "Unknown")}</td>
    <td class="hotel-cell hotel-cell--price">
      <strong>${escapeHtml(buildPriceLabel(hotel))}</strong>
      <span>${escapeHtml(buildPriceSubLabel(hotel))}</span>
    </td>
  `;

  const selectRow = () => selectHotel(hotel.id, { focusMap: state.view === "map" });

  row.addEventListener("click", selectRow);
  row.addEventListener("keydown", (event) => {
    if (event.key === "Enter" || event.key === " ") {
      event.preventDefault();
      selectRow();
    }
  });

  return row;
}

function renderList() {
  dom.list.innerHTML = "";

  if (!state.filteredHotels.length) {
    dom.list.innerHTML = `
      <div class="empty-state">
        <h3>No hotels match those filters</h3>
        <p>Try clearing the brand filter or widening the price range.</p>
      </div>
    `;
    return;
  }

  const table = document.createElement("table");
  table.className = "hotel-table";
  table.innerHTML = `
    <thead>
      <tr>
        <th>Hotel</th>
        <th>City</th>
        <th>Country</th>
        <th>Price</th>
      </tr>
    </thead>
  `;

  const body = document.createElement("tbody");
  state.filteredHotels.forEach((hotel) => {
    body.append(createHotelRow(hotel));
  });
  table.append(body);
  dom.list.append(table);
  highlightSelectedCard();
}

function markerHtml(hotel) {
  const price = getEffectivePrice(hotel);
  const priceBand = getPriceBand(hotel);
  return `
    <div class="map-pin map-pin--${priceBand}">
      <span>${price !== null ? escapeHtml(formatCurrency(price)) : "?"}</span>
    </div>
  `;
}

function getCoordinateGroupKey(coordinates) {
  return `${coordinates.lat.toFixed(6)},${coordinates.lng.toFixed(6)}`;
}

function getMarkerPosition(coordinates, index, total) {
  if (total <= 1) {
    return coordinates;
  }

  const angle = (Math.PI * 2 * index) / total;
  const radius = total === 2 ? 0.00028 : Math.min(0.0005, 0.00018 + total * 0.000035);
  const lngScale = Math.cos((coordinates.lat * Math.PI) / 180) || 1;

  return {
    lat: coordinates.lat + Math.sin(angle) * radius,
    lng: coordinates.lng + (Math.cos(angle) * radius) / lngScale,
  };
}

function renderMap() {
  if (!map || !markersLayer) {
    return;
  }

  markersLayer.clearLayers();
  const bounds = [];
  const hotelsByCoordinates = new Map();

  state.filteredHotels.forEach((hotel) => {
    const coordinates = getCoordinates(hotel);
    if (!coordinates) {
      hotel.__marker = null;
      return;
    }

    const key = getCoordinateGroupKey(coordinates);
    const hotelsAtCoordinates = hotelsByCoordinates.get(key) || [];
    hotelsAtCoordinates.push({ hotel, coordinates });
    hotelsByCoordinates.set(key, hotelsAtCoordinates);
  });

  hotelsByCoordinates.forEach((hotelsAtCoordinates) => {
    const total = hotelsAtCoordinates.length;

    hotelsAtCoordinates.forEach(({ hotel, coordinates }, index) => {
      const markerPosition = getMarkerPosition(coordinates, index, total);
      const marker = window.L.marker([markerPosition.lat, markerPosition.lng], {
        icon: window.L.divIcon({
          className: "map-pin-wrapper",
          html: markerHtml(hotel),
          iconSize: [54, 36],
          iconAnchor: [27, 18],
        }),
      });

      marker.bindPopup(`
        <div class="popup-card">
          <strong>${escapeHtml(hotel.name)}</strong>
          <span>${escapeHtml(getLocationLabel(hotel))}</span>
          <span>${escapeHtml(buildPriceLabel(hotel))}</span>
        </div>
      `);

      marker.on("click", () => {
        selectHotel(hotel.id);
      });

      markersLayer.addLayer(marker);
      hotel.__marker = marker;
      bounds.push([markerPosition.lat, markerPosition.lng]);
    });
  });

  if (!bounds.length) {
    map.setView([25, -10], 2);
    return;
  }

  map.fitBounds(bounds, { padding: [30, 30] });
}

function highlightSelectedCard() {
  document.querySelectorAll(".hotel-row").forEach((row) => {
    row.classList.toggle("hotel-row--active", row.dataset.hotelId === state.selectedHotelId);
  });
}

function focusHotelOnMap(hotelId, { animate = true, openPopup = true } = {}) {
  const hotel = state.filteredHotels.find((item) => item.id === hotelId);
  if (!hotel?.__marker) {
    return;
  }

  const markerPosition = hotel.__marker.getLatLng();
  const targetZoom = Math.max(map.getZoom(), 9);

  if (animate) {
    map.flyTo(markerPosition, targetZoom, { duration: 0.8 });
  } else {
    map.setView(markerPosition, targetZoom);
  }

  if (openPopup) {
    hotel.__marker.openPopup();
  }
}

function renderDetail() {
  const hotel = getSelectedHotel();

  if (!hotel) {
    dom.detail.innerHTML = `
      <div class="detail-empty">
        <h3>No hotel selected</h3>
        <p>Pick a hotel from the list or click a marker on the map.</p>
      </div>
    `;
    return;
  }

  const location = getLocationData(hotel);
  const pricedSnapshots = getPricedSnapshots(hotel);
  const bestSnapshot = pricedSnapshots[0] || null;
  const tripAdvisor = getTripAdvisorData(hotel);
  const tripAdvisorRating = toFiniteNumber(tripAdvisor?.rating);
  const tripAdvisorReviewCount = formatReviewCount(tripAdvisor?.reviewCount);
  const tripAdvisorAddress = tripAdvisor?.address || tripAdvisor?.locationText || null;
  const locationLines = uniqueValues([
    uniqueValues([location.city, location.region, location.country]).join(", ") || null,
    tripAdvisorAddress,
  ]);
  const tripAdvisorMarkup = tripAdvisor
    ? `
      <section class="detail-tripadvisor">
        <div class="detail-tripadvisor__header">
          <h3>TripAdvisor</h3>
        </div>
        ${
          tripAdvisorRating !== null || tripAdvisorReviewCount
            ? `
          <div class="detail-tripadvisor__stats">
            ${
              tripAdvisorRating !== null
                ? `
              <div class="detail-stat-pill">
                <strong>${escapeHtml(tripAdvisorRating.toFixed(1))}</strong>
                <span>rating</span>
              </div>
            `
                : ""
            }
            ${
              tripAdvisorReviewCount
                ? `
              <div class="detail-stat-pill">
                <strong>${escapeHtml(tripAdvisorReviewCount)}</strong>
                <span>reviews</span>
              </div>
            `
                : ""
            }
          </div>
        `
            : ""
        }
        <div class="detail-grid detail-grid--compact">
          ${
            tripAdvisor?.phone
              ? `
            <div class="detail-row">
              <span>Phone</span>
              <strong>${escapeHtml(tripAdvisor.phone)}</strong>
            </div>
          `
              : ""
          }
        </div>
      </section>
    `
    : "";
  const snapshotMarkup = pricedSnapshots.length
    ? `
      <section class="detail-price-breakdown">
        <div class="detail-price-breakdown__header">
          <h3>Reference stay prices</h3>
          <span>${pricedSnapshots.length} sampled ${pricedSnapshots.length === 1 ? "date" : "dates"}</span>
        </div>
        <div class="detail-rate-list">
        ${pricedSnapshots
          .map(
            (snapshot) => `
          <div class="detail-rate-card ${bestSnapshot === snapshot ? "detail-rate-card--best" : ""}">
            <div>
              <strong>${escapeHtml(formatStayWindow(snapshot))}</strong>
              <span>${escapeHtml(
                bestSnapshot === snapshot ? "Lowest sampled nightly rate" : "Other",
              )}</span>
            </div>
            <strong>${escapeHtml(formatCurrency(snapshot.lowestNightlyRate, snapshot.currency))}</strong>
          </div>
        `,
          )
          .join("")}
        </div>
      </section>
    `
    : "";
  const priceSummaryMarkup = bestSnapshot
    ? `
      <div class="detail-price-summary">
        <span class="detail-price-summary__eyebrow">Lowest sampled nightly rate</span>
        <strong>${escapeHtml(formatCurrency(bestSnapshot.lowestNightlyRate, bestSnapshot.currency))}</strong>
        <p>${escapeHtml(formatStayWindow(bestSnapshot))}</p>
        <p>${escapeHtml(buildPriceSubLabel(hotel))}</p>
      </div>
    `
    : `
      <div class="detail-price-summary detail-price-summary--pending">
        <span class="detail-price-summary__eyebrow">Price status</span>
        <strong>${escapeHtml(buildPriceLabel(hotel))}</strong>
        <p>${escapeHtml(buildPriceSubLabel(hotel))}</p>
      </div>
    `;

  dom.detail.innerHTML = `
    <div class="detail-card">
      <div class="card-topline">
        <span class="brand-pill">${escapeHtml(hotel.brand)}</span>
        <span class="price-pill ${getEffectivePrice(hotel) !== null && getEffectivePrice(hotel) <= 200 ? "price-pill--green" : ""}">
          ${escapeHtml(buildPriceLabel(hotel))}
        </span>
      </div>
      <h2>${escapeHtml(hotel.name)}</h2>
      <p class="detail-location">${escapeHtml(getLocationLabel(hotel))}</p>
      ${priceSummaryMarkup}
      <div class="detail-grid">
        ${
          locationLines.length
            ? `
          <div class="detail-row">
            <span>Location</span>
            <strong>${locationLines.map((line) => escapeHtml(line)).join("<br />")}</strong>
          </div>
        `
            : ""
        }
      </div>
      ${tripAdvisorMarkup}
      ${snapshotMarkup}
      <div class="detail-actions">
        <a class="primary-button" href="${hotel.hiltonUrl}" target="_blank" rel="noreferrer">
          Hilton
        </a>
        ${
          hotel.tripAdvisorUrl
            ? `
        <a class="ghost-button" href="${hotel.tripAdvisorUrl}" target="_blank" rel="noreferrer">
          TripAdvisor
        </a>
        `
            : ""
        }
        <a class="ghost-button" href="${buildGoogleMapsUrl(hotel)}" target="_blank" rel="noreferrer">
          Google Map
        </a>
      </div>
    </div>
  `;
}

function updateViewMode() {
  dom.workspace.classList.remove("view-map", "view-list");
  dom.workspace.classList.add(`view-${state.view}`);
  document
    .querySelectorAll("[data-view]")
    .forEach((button) => button.classList.toggle("is-active", button.dataset.view === state.view));

  if (!map) {
    return;
  }

  setTimeout(() => {
    map.invalidateSize();
    if (state.view === "map" && state.selectedHotelId) {
      focusHotelOnMap(state.selectedHotelId, { animate: false, openPopup: false });
    }
  }, 100);
}

function syncSelectionFromUrl({ focusMap = false } = {}) {
  const hotelId = readHotelIdFromUrl();
  if (!hotelId) {
    state.syncSelectionToUrl = false;
    return false;
  }

  const hotelExists = state.hotels.some((hotel) => hotel.id === hotelId);
  if (!hotelExists) {
    return false;
  }

  state.selectedHotelId = hotelId;
  state.syncSelectionToUrl = true;

  if (state.hotels.length) {
    render(state.meta);
    if (focusMap && state.view === "map") {
      focusHotelOnMap(hotelId);
    }
  }

  return true;
}

function render(meta) {
  state.meta = meta;
  applyFilters();
  ensureSelectedHotel();
  if (state.syncSelectionToUrl) {
    updateHotelUrl(state.selectedHotelId, { replace: true });
  }
  updateMeta(meta);
  renderList();
  renderMap();
  renderDetail();
  updateViewMode();
}

function readBrands(hotels) {
  return [...new Set(hotels.map((hotel) => hotel.brand))].sort();
}

function readCountries(hotels) {
  return [...new Set(hotels.map((hotel) => getLocationData(hotel).country).filter(Boolean))].sort();
}

function readRegions(hotels, country = state.country) {
  return [
    ...new Set(
      hotels
        .filter((hotel) => country === "all" || getLocationData(hotel).country === country)
        .map((hotel) => getLocationData(hotel).region)
        .filter(Boolean),
    ),
  ].sort();
}

function populateBrandFilter(hotels) {
  const brands = readBrands(hotels);
  dom.brand.innerHTML = '<option value="all">All brands</option>';

  brands.forEach((brand) => {
    const option = document.createElement("option");
    option.value = brand;
    option.textContent = brand;
    dom.brand.append(option);
  });
}

function populateCountryFilter(hotels) {
  const countries = readCountries(hotels);
  dom.country.innerHTML = '<option value="all">All countries</option>';

  countries.forEach((country) => {
    const option = document.createElement("option");
    option.value = country;
    option.textContent = country;
    dom.country.append(option);
  });
}

function populateRegionFilter(hotels) {
  const regions = readRegions(hotels, state.country);
  if (state.region !== "all" && !regions.includes(state.region)) {
    state.region = "all";
  }

  dom.region.innerHTML = '<option value="all">All regions</option>';

  regions.forEach((region) => {
    const option = document.createElement("option");
    option.value = region;
    option.textContent = region;
    dom.region.append(option);
  });

  dom.region.value = state.region;
}

function initMap() {
  map = window.L.map(dom.map, {
    zoomControl: false,
  }).setView([25, -10], 2);

  window.L.control.zoom({ position: "bottomright" }).addTo(map);

  window.L.tileLayer("https://{s}.tile.openstreetmap.org/{z}/{x}/{y}.png", {
    maxZoom: 18,
    attribution:
      '&copy; <a href="https://www.openstreetmap.org/copyright">OpenStreetMap</a> contributors',
  }).addTo(map);

  markersLayer = window.L.layerGroup().addTo(map);
}

function buildShell() {
  const app = document.querySelector("#app");
  app.innerHTML = `
    <main class="page-shell">
      <header class="page-header">
        <div>
          <p class="eyebrow">Hilton Aspire Resort Finder</p>
          <h1>Hilton resort credit hotels</h1>
        </div>
        <div class="page-meta">
          <strong id="results-count">0 of 0 hotels</strong>
          <span id="generated-at">Loading...</span>
          <a
            class="page-meta-link"
            href="https://github.com/kevchentw/hilton-aspire-resorts/issues"
            target="_blank"
            rel="noreferrer"
          >
            Report issue
          </a>
        </div>
      </header>

      <section class="announcement-banner" aria-label="Product announcement">
        <div class="announcement-banner__eyebrow">New tool introduced</div>
        <div class="announcement-banner__content">
          <div>
            <h2>Open Hotel Data now supports FHR and THD.</h2>
            <p>
              This Hilton Aspire resort page is no longer being updated. Use the new tool for the latest hotel data and expanded program support.
            </p>
          </div>
          <a
            class="primary-button announcement-banner__link"
            href="https://kevchentw.github.io/open-hotel-data/"
            target="_blank"
            rel="noreferrer"
          >
            Open new tool
          </a>
        </div>
      </section>

      <section class="toolbar">
        <div class="toolbar-group toolbar-group--search">
          <label>
            Search
            <input id="search-input" type="search" placeholder="Conrad, Waikiki, Fort Lauderdale..." />
          </label>
        </div>
        <div class="toolbar-group">
          <label>
            Brand
            <select id="brand-filter"></select>
          </label>
        </div>
        <div class="toolbar-group">
          <label>
            Country
            <select id="country-filter"></select>
          </label>
        </div>
        <div class="toolbar-group">
          <label>
            Region
            <select id="region-filter"></select>
          </label>
        </div>
        <div class="toolbar-group toolbar-group--toggle">
          <label>
            Price range
            <select id="price-range-filter">
              <option value="all">Any price</option>
              <option value="200">Max $200</option>
              <option value="300">Max $300</option>
              <option value="400">Max $400</option>
              <option value="500">Max $500</option>
            </select>
          </label>
        </div>
      </section>

      <section class="view-tabs">
        <button class="tab-button is-active" data-view="map">Map</button>
        <button class="tab-button" data-view="list">List</button>
      </section>

      <section class="workspace view-map" id="workspace">
        <div class="content-panel">
          <div id="map-panel" class="mode-panel">
            <div id="map"></div>
          </div>
          <div id="list-panel" class="mode-panel">
            <div class="hotel-list" id="hotel-list"></div>
          </div>
        </div>
        <aside class="detail-panel">
          <div class="detail-panel__header">
            <h2>Hotel details</h2>
          </div>
          <div class="detail-panel__body" id="detail-panel-body"></div>
        </aside>
      </section>
    </main>
  `;

  dom = {
    resultsCount: document.querySelector("#results-count"),
    generatedAt: document.querySelector("#generated-at"),
    search: document.querySelector("#search-input"),
    brand: document.querySelector("#brand-filter"),
    country: document.querySelector("#country-filter"),
    region: document.querySelector("#region-filter"),
    priceRange: document.querySelector("#price-range-filter"),
    list: document.querySelector("#hotel-list"),
    map: document.querySelector("#map"),
    detail: document.querySelector("#detail-panel-body"),
    workspace: document.querySelector("#workspace"),
  };

  initMap();
}

function selectHotel(hotelId, { focusMap = false } = {}) {
  state.selectedHotelId = hotelId;
  state.syncSelectionToUrl = true;
  updateHotelUrl(hotelId);
  highlightSelectedCard();
  renderDetail();

  if (focusMap) {
    focusHotelOnMap(hotelId);
  }
}

function attachEvents(meta) {
  dom.search.addEventListener("input", (event) => {
    state.search = event.target.value;
    render(meta);
  });

  dom.brand.addEventListener("change", (event) => {
    state.brand = event.target.value;
    render(meta);
  });

  dom.country.addEventListener("change", (event) => {
    state.country = event.target.value;
    populateRegionFilter(state.hotels);
    render(meta);
  });

  dom.region.addEventListener("change", (event) => {
    state.region = event.target.value;
    render(meta);
  });

  dom.priceRange.addEventListener("change", (event) => {
    state.maxPrice = event.target.value;
    render(meta);
  });

  document.querySelectorAll("[data-view]").forEach((button) => {
    button.addEventListener("click", () => {
      state.view = button.dataset.view;
      updateViewMode();
    });
  });

  const syncFromLocation = () => {
    syncSelectionFromUrl({ focusMap: true });
  };

  window.addEventListener("hashchange", syncFromLocation);
  window.addEventListener("popstate", syncFromLocation);
}

async function loadJson(url, { optional = false } = {}) {
  const response = await fetch(url, { cache: "no-store" });

  if (optional && response.status === 404) {
    return null;
  }

  if (!response.ok) {
    throw new Error(`Could not load ${url}`);
  }

  return response.json();
}

function mergePayloads(hotelsPayload, pricesPayload) {
  const hotels = (hotelsPayload.hotels || []).map((hotel) => ({
    ...hotel,
    xotelo: {
      ...(hotel.xotelo || {}),
      ...((pricesPayload?.prices || {})[hotel.id] || {}),
    },
  }));

  return {
    meta: {
      ...(hotelsPayload.meta || {}),
      pricing: pricesPayload?.meta || null,
      generatedAt: pricesPayload?.meta?.generatedAt || hotelsPayload.meta?.generatedAt || null,
    },
    hotels,
  };
}

function mergeTripAdvisorEnrichment(payload, enrichmentPayload) {
  const tripAdvisorHotels = enrichmentPayload?.hotels || {};
  const hotels = payload.hotels.map((hotel) => ({
    ...hotel,
    tripAdvisorEnrichment:
      tripAdvisorHotels[hotel.name] ||
      Object.values(tripAdvisorHotels).find((entry) => entry.hotelId === hotel.id) ||
      null,
  }));

  return {
    meta: {
      ...payload.meta,
      tripAdvisor: enrichmentPayload?.meta || null,
    },
    hotels,
  };
}

async function loadData() {
  const [hotelsPayload, pricesPayload, tripAdvisorPayload] = await Promise.all([
    loadJson(HOTELS_URL),
    loadJson(PRICES_URL, { optional: true }),
    loadJson(TRIPADVISOR_ENRICHMENT_URL, { optional: true }),
  ]);

  return mergeTripAdvisorEnrichment(
    mergePayloads(hotelsPayload, pricesPayload),
    tripAdvisorPayload,
  );
}

function showError(message) {
  const app = document.querySelector("#app");
  app.innerHTML = `
    <main class="page-shell error-shell">
      <h1>Data sync needed</h1>
      <p>${escapeHtml(message)}</p>
      <p>Run <code>npm run sync:data</code> before opening the app.</p>
    </main>
  `;
}

async function bootstrap() {
  buildShell();

  try {
    const payload = await loadData();
    state.hotels = payload.hotels || [];
    state.meta = payload.meta || {};
    syncSelectionFromUrl();
    populateBrandFilter(state.hotels);
    populateCountryFilter(state.hotels);
    populateRegionFilter(state.hotels);
    attachEvents(payload.meta || {});
    render(payload.meta || {});
  } catch (error) {
    showError(error.message);
    console.error(error);
  }
}

bootstrap();

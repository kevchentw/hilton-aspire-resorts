import "./styles.css";

const DATA_URL = "./data/resorts.json";

const state = {
  hotels: [],
  filteredHotels: [],
  selectedHotelId: null,
  search: "",
  brand: "all",
  priceCap: "",
  onlyCreditFriendly: false,
  view: "split",
  loading: true,
  error: null,
};

let map;
let markersLayer;
let activePopup;
let dom = {};

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

function normalizeText(value) {
  return (value || "").toLowerCase();
}

function buildPriceLabel(hotel) {
  const sample = hotel.xotelo?.sampleStay;
  if (sample?.lowestNightlyRate) {
    return `${formatCurrency(sample.lowestNightlyRate, sample.currency)} / night`;
  }

  const range = hotel.xotelo?.indicativeRange;
  if (range?.minimum && range?.maximum) {
    return `${formatCurrency(range.minimum, range.currency)}-${formatCurrency(
      range.maximum,
      range.currency,
    )}`;
  }

  return "Price pending";
}

function buildPriceSubLabel(hotel) {
  const sample = hotel.xotelo?.sampleStay;
  if (sample?.lowestNightlyRate) {
    return `Xotelo sample stay ${sample.checkIn} to ${sample.checkOut}`;
  }

  const range = hotel.xotelo?.indicativeRange;
  if (range?.minimum && range?.maximum) {
    return "Xotelo indicative range";
  }

  return hotel.xotelo?.statusNote || "Add RapidAPI bootstrap to enrich pricing";
}

function getEffectivePrice(hotel) {
  return (
    hotel.xotelo?.sampleStay?.lowestNightlyRate ||
    hotel.xotelo?.indicativeRange?.minimum ||
    null
  );
}

function getLocationLabel(hotel) {
  return (
    hotel.locationLabel ||
    hotel.geocode?.displayName ||
    hotel.xotelo?.shortPlaceName ||
    hotel.xotelo?.placeName ||
    "Location loading"
  );
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
  const priceCap = Number(state.priceCap);

  state.filteredHotels = sortHotels(
    state.hotels.filter((hotel) => {
      const haystack = normalizeText(
        `${hotel.name} ${hotel.brand} ${hotel.locationLabel || ""}`,
      );
      const effectivePrice = getEffectivePrice(hotel);
      const isCreditFriendly = effectivePrice !== null && effectivePrice <= 200;

      if (search && !haystack.includes(search)) {
        return false;
      }

      if (state.brand !== "all" && hotel.brand !== state.brand) {
        return false;
      }

      if (state.onlyCreditFriendly && !isCreditFriendly) {
        return false;
      }

      if (
        state.priceCap &&
        Number.isFinite(priceCap) &&
        priceCap > 0 &&
        effectivePrice !== null &&
        effectivePrice > priceCap
      ) {
        return false;
      }

      return true;
    }),
  );
}

function updateStats(meta) {
  const withMap = state.hotels.filter((hotel) => hotel.geo?.lat && hotel.geo?.lng).length;
  const withPrice = state.hotels.filter((hotel) => getEffectivePrice(hotel) !== null).length;
  const creditFriendly = state.hotels.filter((hotel) => {
    const price = getEffectivePrice(hotel);
    return price !== null && price <= 200;
  }).length;

  dom.generatedAt.textContent = meta.generatedAt
    ? new Date(meta.generatedAt).toLocaleString("en-US", {
        dateStyle: "medium",
        timeStyle: "short",
      })
    : "Not synced yet";

  dom.totalCount.textContent = `${state.hotels.length}`;
  dom.mappedCount.textContent = `${withMap}`;
  dom.priceCount.textContent = `${withPrice}`;
  dom.creditCount.textContent = `${creditFriendly}`;

  if (!meta.rapidApiBootstrapEnabled) {
    dom.syncNote.innerHTML = `
      <strong>Heads up:</strong>
      Xotelo hotel matching now needs <code>RAPIDAPI_KEY</code>. Without it, this static build can still show the Hilton list and some fallback map matches, but full map coverage and richer price snapshots will be limited.
    `;
  } else {
    dom.syncNote.innerHTML = `
      <strong>Pricing mode:</strong>
      This build used the Xotelo bootstrap path, so hotel matching, map placement, and sample rate data should be much more complete.
    `;
  }
}

function createHotelCard(hotel) {
  const card = document.createElement("article");
  card.className = "hotel-card";
  card.dataset.hotelId = hotel.id;

  const price = getEffectivePrice(hotel);
  const creditFriendly = price !== null && price <= 200;

  card.innerHTML = `
    <div class="card-topline">
      <span class="brand-pill">${hotel.brand}</span>
      <span class="price-pill ${creditFriendly ? "price-pill--green" : ""}">
        ${buildPriceLabel(hotel)}
      </span>
    </div>
    <h3>${hotel.name}</h3>
    <p class="hotel-location">${getLocationLabel(hotel)}</p>
    <p class="hotel-price-note">${buildPriceSubLabel(hotel)}</p>
    <div class="card-actions">
      <button class="ghost-button" data-action="map">Show on map</button>
      <a class="primary-button" href="${hotel.hiltonUrl}" target="_blank" rel="noreferrer">
        Book with Hilton
      </a>
    </div>
  `;

  card.querySelector('[data-action="map"]').addEventListener("click", () => {
    focusHotel(hotel.id);
  });

  return card;
}

function renderList() {
  dom.resultsCount.textContent = `${state.filteredHotels.length} hotels`;
  dom.list.innerHTML = "";

  if (!state.filteredHotels.length) {
    const emptyState = document.createElement("div");
    emptyState.className = "empty-state";
    emptyState.innerHTML = `
      <h3>No resorts match those filters</h3>
      <p>Try clearing the brand filter or widening the price cap.</p>
    `;
    dom.list.append(emptyState);
    return;
  }

  const fragment = document.createDocumentFragment();
  state.filteredHotels.forEach((hotel) => {
    fragment.append(createHotelCard(hotel));
  });
  dom.list.append(fragment);
}

function markerHtml(hotel) {
  const price = getEffectivePrice(hotel);
  return `
    <div class="map-pin ${price !== null && price <= 200 ? "map-pin--green" : ""}">
      <span>${price !== null ? formatCurrency(price) : "?"}</span>
    </div>
  `;
}

function renderMap() {
  if (!map || !markersLayer) {
    return;
  }

  markersLayer.clearLayers();
  const bounds = [];

  state.filteredHotels.forEach((hotel) => {
    if (!hotel.geo?.lat || !hotel.geo?.lng) {
      return;
    }

    const marker = window.L.marker([hotel.geo.lat, hotel.geo.lng], {
      icon: window.L.divIcon({
        className: "map-pin-wrapper",
        html: markerHtml(hotel),
        iconSize: [54, 36],
        iconAnchor: [27, 18],
      }),
    });

    marker.bindPopup(`
      <div class="popup-card">
        <strong>${hotel.name}</strong>
        <span>${hotel.brand}</span>
        <span>${getLocationLabel(hotel)}</span>
        <span>${buildPriceLabel(hotel)}</span>
        <a href="${hotel.hiltonUrl}" target="_blank" rel="noreferrer">Book with Hilton</a>
      </div>
    `);

    marker.on("click", () => {
      state.selectedHotelId = hotel.id;
      activePopup = marker;
      highlightSelectedCard();
    });

    markersLayer.addLayer(marker);
    hotel.__marker = marker;
    bounds.push([hotel.geo.lat, hotel.geo.lng]);
  });

  if (bounds.length) {
    map.fitBounds(bounds, { padding: [30, 30] });
  }
}

function highlightSelectedCard() {
  document.querySelectorAll(".hotel-card").forEach((card) => {
    card.classList.toggle("hotel-card--active", card.dataset.hotelId === state.selectedHotelId);
  });
}

function focusHotel(hotelId) {
  const hotel = state.hotels.find((item) => item.id === hotelId);
  if (!hotel || !hotel.geo?.lat || !hotel.geo?.lng || !hotel.__marker) {
    return;
  }

  state.selectedHotelId = hotelId;
  highlightSelectedCard();
  map.flyTo([hotel.geo.lat, hotel.geo.lng], 9, { duration: 0.8 });
  hotel.__marker.openPopup();
}

function updateViewMode() {
  dom.results.classList.remove("view-split", "view-map", "view-list");
  dom.results.classList.add(`view-${state.view}`);
  document
    .querySelectorAll("[data-view]")
    .forEach((button) => button.classList.toggle("is-active", button.dataset.view === state.view));

  if (map) {
    setTimeout(() => map.invalidateSize(), 100);
  }
}

function render(meta) {
  applyFilters();
  updateStats(meta);
  renderList();
  renderMap();
  updateViewMode();
}

function readBrands(hotels) {
  return [...new Set(hotels.map((hotel) => hotel.brand))].sort();
}

function populateBrandFilter(hotels) {
  const brands = readBrands(hotels);
  dom.brand.innerHTML = '<option value="all">All Hilton brands</option>';

  brands.forEach((brand) => {
    const option = document.createElement("option");
    option.value = brand;
    option.textContent = brand;
    dom.brand.append(option);
  });
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
      <section class="hero">
        <div class="hero-copy">
          <p class="eyebrow">Hilton Honors Aspire</p>
          <h1>Map the Hilton resorts where that semiannual $200 credit can actually do work.</h1>
          <p class="hero-text">
            This static site tracks Hilton resort-credit eligible hotels, plots them on a map, and
            overlays cached Xotelo price signals so people can spot credit-friendly stays faster.
          </p>
          <div class="hero-note">
            <strong>Important:</strong>
            Xotelo pricing here is a cached snapshot from the most recent data sync, not a live quote.
          </div>
          <div class="hero-note hero-note--secondary" id="sync-note">
            <strong>Sync mode:</strong>
            Checking dataset capabilities...
          </div>
        </div>
        <div class="hero-stats">
          <div class="stat-card">
            <span class="stat-label">Eligible resorts</span>
            <strong id="total-count">0</strong>
          </div>
          <div class="stat-card">
            <span class="stat-label">Mapped</span>
            <strong id="mapped-count">0</strong>
          </div>
          <div class="stat-card">
            <span class="stat-label">With price data</span>
            <strong id="price-count">0</strong>
          </div>
          <div class="stat-card stat-card--accent">
            <span class="stat-label">At or under $200</span>
            <strong id="credit-count">0</strong>
          </div>
        </div>
      </section>

      <section class="toolbar">
        <div class="toolbar-group toolbar-group--search">
          <label>
            Search
            <input id="search-input" type="search" placeholder="Waikiki, Waldorf, Arizona Biltmore..." />
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
            Max nightly price
            <input id="price-cap" type="number" min="0" step="1" placeholder="200" />
          </label>
        </div>
        <div class="toolbar-group toolbar-group--toggle">
          <label class="checkbox-row">
            <input id="credit-friendly-only" type="checkbox" />
            Only show resorts at or under $200
          </label>
        </div>
        <div class="toolbar-group toolbar-group--views">
          <button class="view-button is-active" data-view="split">Split</button>
          <button class="view-button" data-view="list">List</button>
          <button class="view-button" data-view="map">Map</button>
        </div>
      </section>

      <section class="meta-bar">
        <p>Last synced: <strong id="generated-at">Loading...</strong></p>
        <p>
          Source: <a href="https://www.hilton.com/en/p/hilton-honors/resort-credit-eligible-hotels/" target="_blank" rel="noreferrer">
            Hilton resort credit list
          </a>
        </p>
      </section>

      <section class="results view-split" id="results-shell">
        <div class="list-panel">
          <div class="panel-header">
            <h2>Resort list</h2>
            <span id="results-count">0 hotels</span>
          </div>
          <div class="hotel-list" id="hotel-list"></div>
        </div>
        <div class="map-panel">
          <div class="panel-header">
            <h2>Map view</h2>
            <span>Leaflet + OpenStreetMap</span>
          </div>
          <div id="map"></div>
        </div>
      </section>
    </main>
  `;

  dom = {
    totalCount: document.querySelector("#total-count"),
    mappedCount: document.querySelector("#mapped-count"),
    priceCount: document.querySelector("#price-count"),
    creditCount: document.querySelector("#credit-count"),
    generatedAt: document.querySelector("#generated-at"),
    search: document.querySelector("#search-input"),
    brand: document.querySelector("#brand-filter"),
    priceCap: document.querySelector("#price-cap"),
    creditOnly: document.querySelector("#credit-friendly-only"),
    list: document.querySelector("#hotel-list"),
    resultsCount: document.querySelector("#results-count"),
    map: document.querySelector("#map"),
    results: document.querySelector("#results-shell"),
    syncNote: document.querySelector("#sync-note"),
  };

  initMap();
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

  dom.priceCap.addEventListener("input", (event) => {
    state.priceCap = event.target.value;
    render(meta);
  });

  dom.creditOnly.addEventListener("change", (event) => {
    state.onlyCreditFriendly = event.target.checked;
    render(meta);
  });

  document.querySelectorAll("[data-view]").forEach((button) => {
    button.addEventListener("click", () => {
      state.view = button.dataset.view;
      updateViewMode();
    });
  });
}

async function loadData() {
  const response = await fetch(DATA_URL, { cache: "no-store" });
  if (!response.ok) {
    throw new Error(`Could not load ${DATA_URL}`);
  }

  return response.json();
}

function showError(message) {
  const app = document.querySelector("#app");
  app.innerHTML = `
    <main class="page-shell error-shell">
      <h1>Data sync needed</h1>
      <p>${message}</p>
      <p>Run <code>npm run sync:data</code> locally or let the GitHub Action build the latest dataset before deploying Pages.</p>
    </main>
  `;
}

async function bootstrap() {
  buildShell();

  try {
    const payload = await loadData();
    state.hotels = payload.hotels || [];

    populateBrandFilter(state.hotels);
    attachEvents(payload.meta || {});
    render(payload.meta || {});
  } catch (error) {
    showError(error.message);
    console.error(error);
  }
}

bootstrap();

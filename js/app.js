// NutriScan - Food & Nutrition Explorer
// CSE-2340 Software Development I - MP3 & MP4
//
// Data comes from the Open Food Facts API (free, no API key needed).
// Quick map of the file:
//   1. Setup (variables + elements)
//   2. localStorage helpers          -> MP4 requirement 4
//   3. fetch + async/await           -> MP4 requirement 3
//   4. Rendering with the DOM        -> MP3 requirement 1
//   5. Event listeners               -> MP3 requirement 2

// ---------- 1. Setup ----------

const API_URL = "https://world.openfoodfacts.org/cgi/search.pl";
const FAV_KEY = "nutriscan_favourites";
const COMPARE_KEY = "nutriscan_compare";
const LAST_SEARCH_KEY = "nutriscan_last_search";
const MAX_COMPARE = 3;

// data
let products = [];                          // results of the latest search
let favourites = loadFromStorage(FAV_KEY);  // saved foods (survive refresh)
let compareList = loadFromStorage(COMPARE_KEY);
let currentView = "explore";

// elements from index.html
const greeting = document.querySelector("#greeting");
const searchForm = document.querySelector("#search-form");
const searchInput = document.querySelector("#search-input");
const chips = document.querySelector("#chips");
const gradeFilter = document.querySelector("#grade-filter");
const sortSelect = document.querySelector("#sort-select");
const resultCount = document.querySelector("#result-count");
const statusBox = document.querySelector("#status-box");
const resultsBox = document.querySelector("#results");
const favList = document.querySelector("#fav-list");
const compareBox = document.querySelector("#compare-box");
const favBadge = document.querySelector("#fav-badge");
const compareBadge = document.querySelector("#compare-badge");
const modal = document.querySelector("#modal");
const modalContent = document.querySelector("#modal-content");
const toast = document.querySelector("#toast");
const navButtons = document.querySelectorAll(".nav-btn");

// ---------- 2. localStorage helpers ----------

function loadFromStorage(key) {
  // localStorage only stores text, so we parse it back into an array.
  // COMMON MISTAKE: forgetting JSON.parse and getting a string instead of an array
  try {
    const saved = localStorage.getItem(key);
    return saved ? JSON.parse(saved) : [];
  } catch (error) {
    console.log("Could not read " + key, error);
    return [];
  }
}

function saveToStorage(key, data) {
  // COMMON MISTAKE: saving an object directly gives "[object Object]"
  // always use JSON.stringify first
  localStorage.setItem(key, JSON.stringify(data));
}

// ---------- 3. Talking to the API ----------

// Open Food Facts has two free search endpoints.
// The first one is much faster. The old one is our backup if the first fails.
const FAST_API = "https://search.openfoodfacts.org/search";
const OLD_API = "https://world.openfoodfacts.org/cgi/search.pl";
const FIELDS = "code,product_name,brands,image_front_small_url,image_small_url,nutriscore_grade,nutriments";

let searchCache = {};   // remembers old searches so the same search is instant
let latestRequest = 0;  // number of the newest search, used to ignore old answers

// COMMON MISTAKE: fetch() never gives up by itself, so the loading spinner can
// stay forever. AbortController lets us cancel the request after some time.
async function fetchWithTimeout(url, ms) {
  const controller = new AbortController();
  const timer = setTimeout(function () {
    controller.abort();
  }, ms);

  try {
    const response = await fetch(url, { signal: controller.signal });

    // fetch does NOT throw on 404/500, so we check ourselves
    if (!response.ok) {
      throw new Error("Server answered with status " + response.status);
    }
    return await response.json();
  } finally {
    clearTimeout(timer); // always stop the timer, success or fail
  }
}

async function searchFood(query) {
  const requestId = ++latestRequest;
  const cacheKey = query.toLowerCase();
  localStorage.setItem(LAST_SEARCH_KEY, query);

  // same search again? show it instantly
  if (searchCache[cacheKey]) {
    products = searchCache[cacheKey];
    applyFilters();
    return;
  }

  showLoading();

  // if it takes more than 4 seconds, tell the user to wait
  const slowTimer = setTimeout(function () {
    if (requestId === latestRequest) showSlowMessage();
  }, 4000);

  const fastUrl = FAST_API + "?q=" + encodeURIComponent(query) + "&page_size=24&fields=" + FIELDS;
  const oldUrl =
    OLD_API + "?search_terms=" + encodeURIComponent(query) +
    "&search_simple=1&action=process&json=1&page_size=24&fields=" + FIELDS;

  try {
    let found = [];

    // step 1: try the fast API
    try {
      const data = await fetchWithTimeout(fastUrl, 8000);
      found = cleanList(data.hits || data.products || []);
    } catch (error) {
      console.log("Fast API failed, trying backup:", error);
    }

    // step 2: nothing from the fast one? try the old API
    if (found.length === 0) {
      const data = await fetchWithTimeout(oldUrl, 20000);
      found = cleanList(data.products || []);
    }

    // a newer search started while we were waiting, so ignore this answer
    if (requestId !== latestRequest) return;

    products = found;
    searchCache[cacheKey] = found;

    if (products.length === 0) {
      showEmpty(query);
    } else {
      applyFilters();
    }
  } catch (error) {
    if (requestId !== latestRequest) return;
    console.log("Fetch failed:", error);

    if (error.name === "AbortError") {
      showError("The food server is taking too long. Please try again in a moment.");
    } else {
      showError("Could not load foods. Check your internet and try again.");
    }
  } finally {
    clearTimeout(slowTimer);
  }
}

// clean every item and remove the ones we cannot use
function cleanList(rawList) {
  return rawList.map(cleanProduct).filter(function (item) {
    return item !== null;
  });
}

// The API returns a lot of fields we don't need. Keep only what the app uses.
function cleanProduct(item) {
  const n = item.nutriments || {};

  // calories: use kcal if it exists, otherwise convert from kJ (1 kcal = 4.184 kJ)
  let kcal = n["energy-kcal_100g"];
  if (kcal === undefined && n["energy_100g"] !== undefined) {
    kcal = n["energy_100g"] / 4.184;
  }

  // skip products with no name or no calories
  if (!item.product_name || kcal === undefined) {
    return null;
  }

  // brands can be a text ("Nestle, Maggi") or a list depending on the API
  let brand = "Unknown brand";
  if (Array.isArray(item.brands) && item.brands.length > 0) {
    brand = item.brands[0];
  } else if (typeof item.brands === "string" && item.brands !== "") {
    brand = item.brands.split(",")[0];
  }

  return {
    id: item.code,
    name: item.product_name,
    brand: brand,
    image: item.image_front_small_url || item.image_small_url || "images/no-image.svg",
    grade: item.nutriscore_grade || "none",
    kcal: round(kcal),
    protein: round(n["proteins_100g"]),
    carbs: round(n["carbohydrates_100g"]),
    fat: round(n["fat_100g"]),
    sugar: round(n["sugars_100g"]),
    fibre: round(n["fiber_100g"]),
    salt: round(n["salt_100g"])
  };
}

function round(value) {
  // missing values become 0, and we keep one decimal place
  const num = Number(value) || 0;
  return Math.round(num * 10) / 10;
}

// ---------- 4. Showing things on the page ----------

// --- loading / error / empty states ---

function showLoading() {
  resultsBox.innerHTML = "";
  resultCount.textContent = "";
  statusBox.classList.remove("hidden");
  statusBox.innerHTML =
    '<div class="status-card">' +
    '<div class="spinner mb-4"></div>' +
    '<p class="text-slate-500">Looking for foods...</p>' +
    "</div>";
}

function showSlowMessage() {
  const text = statusBox.querySelector("p");
  if (text) {
    text.textContent = "Still loading... the free food database can be slow, please wait a little.";
  }
}

function showError(message) {
  resultsBox.innerHTML = "";
  resultCount.textContent = "";
  statusBox.classList.remove("hidden");
  statusBox.innerHTML =
    '<div class="status-card">' +
    '<p class="text-4xl mb-2">⚠️</p>' +
    '<p class="font-semibold mb-1">Something went wrong</p>' +
    '<p class="text-slate-500 mb-4">' + message + "</p>" +
    '<button id="retry-btn" class="bg-slate-800 text-white rounded-xl px-5 py-2 text-sm">Try again</button>' +
    "</div>";
}

function showEmpty(query) {
  resultsBox.innerHTML = "";
  resultCount.textContent = "";
  statusBox.classList.remove("hidden");
  statusBox.innerHTML =
    '<div class="status-card">' +
    '<img src="images/empty.svg" alt="" class="mx-auto mb-3">' +
    '<p class="font-semibold mb-1">No foods found for "' + escapeHtml(query) + '"</p>' +
    '<p class="text-slate-500">Try a simpler word, like "milk" or "biscuit".</p>' +
    "</div>";
}

function hideStatus() {
  statusBox.classList.add("hidden");
  statusBox.innerHTML = "";
}

// --- filter + sort, then draw the cards ---

function applyFilters() {
  let list = products.slice(); // copy, so we never change the original search results

  // filter by Nutri-Score grade
  const grade = gradeFilter.value;
  if (grade !== "all") {
    list = list.filter(function (item) {
      return item.grade === grade;
    });
  }

  // sort
  const sortBy = sortSelect.value;
  if (sortBy === "kcal-low") {
    list.sort(function (a, b) { return a.kcal - b.kcal; });
  } else if (sortBy === "kcal-high") {
    list.sort(function (a, b) { return b.kcal - a.kcal; });
  } else if (sortBy === "protein-high") {
    list.sort(function (a, b) { return b.protein - a.protein; });
  } else if (sortBy === "fat-low") {
    list.sort(function (a, b) { return a.fat - b.fat; });
  }

  if (list.length === 0) {
    resultsBox.innerHTML = "";
    resultCount.textContent = "0 results";
    statusBox.classList.remove("hidden");
    statusBox.innerHTML =
      '<div class="status-card"><p class="font-semibold mb-1">No foods match this filter</p>' +
      '<p class="text-slate-500">Change the Nutri-Score filter to see more.</p></div>';
    return;
  }

  hideStatus();
  resultCount.textContent = list.length + " foods";
  renderCards(list, resultsBox);
}

function renderCards(list, container) {
  // map() turns every food object into a block of HTML, join() glues them together
  container.innerHTML = list.map(buildCard).join("");
}

function buildCard(food) {
  const isFav = favourites.some(function (f) { return f.id === food.id; });
  const isCompared = compareList.some(function (f) { return f.id === food.id; });

  return `
    <article class="food-card">
      <div class="flex gap-3">
        <img src="${food.image}" alt="${escapeHtml(food.name)}" class="food-img" loading="lazy"
             onerror="this.src='images/no-image.svg'">
        <div class="min-w-0 flex-1">
          <h3 class="font-semibold leading-tight truncate" title="${escapeHtml(food.name)}">${escapeHtml(food.name)}</h3>
          <p class="text-sm text-slate-500 truncate">${escapeHtml(food.brand)}</p>
          <div class="flex items-center gap-2 mt-2">
            <span class="text-2xl font-bold">${food.kcal}</span>
            <span class="text-xs text-slate-500">kcal / 100 g</span>
            <span class="grade grade-${food.grade} ml-auto">${food.grade === "none" ? "?" : food.grade.toUpperCase()}</span>
          </div>
        </div>
      </div>

      ${macroBar("Protein", food.protein, "bar-protein")}
      ${macroBar("Carbs", food.carbs, "bar-carbs")}
      ${macroBar("Fat", food.fat, "bar-fat")}

      <div class="flex gap-2 mt-1">
        <button class="card-btn" data-action="details" data-id="${food.id}">Details</button>
        <button class="card-btn ${isFav ? "on" : ""}" data-action="fav" data-id="${food.id}">${isFav ? "❤️ Saved" : "🤍 Save"}</button>
        <button class="card-btn ${isCompared ? "on" : ""}" data-action="compare" data-id="${food.id}">${isCompared ? "✔ Added" : "⚖️ Compare"}</button>
      </div>
    </article>
  `;
}

function macroBar(label, grams, colorClass) {
  // the bar is simply "grams out of 100 g", so it never goes past 100%
  const width = Math.min(grams, 100);
  return `
    <div>
      <div class="flex justify-between text-sm mb-1">
        <span class="text-slate-500">${label}</span>
        <span class="font-medium">${grams} g</span>
      </div>
      <div class="bar-track"><div class="bar-fill ${colorClass}" style="width:${width}%"></div></div>
    </div>
  `;
}

// --- favourites page ---

function renderFavourites() {
  if (favourites.length === 0) {
    favList.innerHTML =
      '<div class="status-card sm:col-span-2 lg:col-span-3">' +
      '<img src="images/empty.svg" alt="" class="mx-auto mb-3">' +
      '<p class="font-semibold mb-1">No favourites yet</p>' +
      '<p class="text-slate-500">Press "Save" on any food and it will show up here.</p></div>';
    return;
  }
  renderCards(favourites, favList);
}

// --- compare page ---

// each row of the compare table. "best" says if a lower or higher number is better
const compareRows = [
  { label: "Calories (kcal)", key: "kcal", best: "low" },
  { label: "Protein (g)", key: "protein", best: "high" },
  { label: "Carbs (g)", key: "carbs", best: "none" },
  { label: "Fat (g)", key: "fat", best: "low" },
  { label: "Sugar (g)", key: "sugar", best: "low" },
  { label: "Fibre (g)", key: "fibre", best: "high" },
  { label: "Salt (g)", key: "salt", best: "low" }
];

function renderCompare() {
  if (compareList.length < 2) {
    compareBox.innerHTML =
      '<div class="status-card">' +
      '<img src="images/empty.svg" alt="" class="mx-auto mb-3">' +
      '<p class="font-semibold mb-1">Pick at least 2 foods to compare</p>' +
      '<p class="text-slate-500">You have ' + compareList.length + " selected. Press \"Compare\" on a food card (max " + MAX_COMPARE + ").</p></div>";
    return;
  }

  // table header: one column per food
  const headCells = compareList.map(function (food) {
    return `<th>
      <img src="${food.image}" alt="" class="food-img mx-auto mb-2" onerror="this.src='images/no-image.svg'">
      <div class="font-semibold text-slate-800">${escapeHtml(food.name)}</div>
      <button class="text-xs text-red-500 mt-1 hover:underline" data-action="remove-compare" data-id="${food.id}">Remove</button>
    </th>`;
  }).join("");

  // table body: one row per nutrient
  const bodyRows = compareRows.map(function (row) {
    const values = compareList.map(function (food) { return food[row.key]; });
    const bestValue = row.best === "low" ? Math.min(...values) : Math.max(...values);

    const cells = compareList.map(function (food) {
      const isBest = row.best !== "none" && food[row.key] === bestValue;
      return `<td class="${isBest ? "best" : ""}">${food[row.key]}</td>`;
    }).join("");

    return `<tr><td>${row.label}</td>${cells}</tr>`;
  }).join("");

  compareBox.innerHTML = `
    <div class="overflow-x-auto">
      <table class="compare-table">
        <thead><tr><th></th>${headCells}</tr></thead>
        <tbody>${bodyRows}</tbody>
      </table>
    </div>
    <p class="text-sm text-slate-500 mt-3">Green cells show the better value (less calories, fat, sugar, salt - more protein and fibre).</p>
  `;
}

// --- details popup ---

function openDetails(food) {
  modalContent.innerHTML = `
    <div class="flex gap-4 mb-4">
      <img src="${food.image}" alt="" class="food-img" style="width:96px;height:96px" onerror="this.src='images/no-image.svg'">
      <div>
        <h2 class="text-xl font-semibold leading-tight">${escapeHtml(food.name)}</h2>
        <p class="text-slate-500 text-sm mb-2">${escapeHtml(food.brand)}</p>
        <span class="grade grade-${food.grade}">${food.grade === "none" ? "?" : food.grade.toUpperCase()}</span>
        <span class="text-xs text-slate-500 ml-1">Nutri-Score</span>
      </div>
    </div>

    <p class="text-3xl font-bold mb-4">${food.kcal} <span class="text-base font-normal text-slate-500">kcal per 100 g</span></p>

    <div class="space-y-3 mb-5">
      ${macroBar("Protein", food.protein, "bar-protein")}
      ${macroBar("Carbohydrates", food.carbs, "bar-carbs")}
      ${macroBar("Fat", food.fat, "bar-fat")}
    </div>

    <div class="grid grid-cols-3 gap-2 text-center text-sm mb-5">
      <div class="bg-slate-50 rounded-xl py-2"><div class="font-semibold">${food.sugar} g</div><div class="text-slate-500">Sugar</div></div>
      <div class="bg-slate-50 rounded-xl py-2"><div class="font-semibold">${food.fibre} g</div><div class="text-slate-500">Fibre</div></div>
      <div class="bg-slate-50 rounded-xl py-2"><div class="font-semibold">${food.salt} g</div><div class="text-slate-500">Salt</div></div>
    </div>

    <button id="close-modal" class="w-full bg-slate-800 text-white rounded-xl py-3 font-medium">Close</button>
  `;
  modal.classList.remove("hidden");
}

function closeDetails() {
  modal.classList.add("hidden");
}

// --- small helpers ---

function updateBadges() {
  favBadge.textContent = favourites.length;
  compareBadge.textContent = compareList.length;
}

// redraw every part that can change after a click
function refreshAll() {
  updateBadges();
  if (products.length > 0) {
    applyFilters();
  }
  renderFavourites();
  renderCompare();
}

function showToast(message) {
  toast.textContent = message;
  toast.classList.remove("hidden");
  setTimeout(function () {
    toast.classList.add("hidden");
  }, 2000);
}

function escapeHtml(text) {
  // product names come from the internet, so we make them safe before putting in innerHTML
  const div = document.createElement("div");
  div.textContent = text;
  return div.innerHTML;
}

function switchView(name) {
  currentView = name;
  ["explore", "favourites", "compare"].forEach(function (view) {
    document.querySelector("#view-" + view).classList.toggle("hidden", view !== name);
  });
  navButtons.forEach(function (btn) {
    btn.classList.toggle("active", btn.dataset.view === name);
  });
  if (name === "favourites") renderFavourites();
  if (name === "compare") renderCompare();
}

// find a food by id in any list we have
function findFood(id) {
  return (
    products.find(function (f) { return f.id === id; }) ||
    favourites.find(function (f) { return f.id === id; }) ||
    compareList.find(function (f) { return f.id === id; })
  );
}

// ---------- 5. Actions + event listeners ----------

function toggleFavourite(id) {
  const food = findFood(id);
  if (!food) return;

  const alreadySaved = favourites.some(function (f) { return f.id === id; });

  if (alreadySaved) {
    favourites = favourites.filter(function (f) { return f.id !== id; });
    showToast("Removed from favourites");
  } else {
    favourites.push(food);
    showToast("Saved to favourites");
  }

  saveToStorage(FAV_KEY, favourites); // this is what keeps it after refresh
  refreshAll();
}

function toggleCompare(id) {
  const food = findFood(id);
  if (!food) return;

  const alreadyAdded = compareList.some(function (f) { return f.id === id; });

  if (alreadyAdded) {
    compareList = compareList.filter(function (f) { return f.id !== id; });
  } else if (compareList.length >= MAX_COMPARE) {
    showToast("You can compare only " + MAX_COMPARE + " foods");
    return;
  } else {
    compareList.push(food);
    showToast("Added to compare (" + compareList.length + "/" + MAX_COMPARE + ")");
  }

  saveToStorage(COMPARE_KEY, compareList);
  refreshAll();
}

// One listener handles the buttons on ALL cards (event delegation).
// COMMON MISTAKE: adding a listener to each button before the cards exist - it never fires
function handleCardClick(event) {
  const button = event.target.closest("button[data-action]");
  if (!button) return;

  const id = button.dataset.id;
  const action = button.dataset.action;

  if (action === "details") openDetails(findFood(id));
  if (action === "fav") toggleFavourite(id);
  if (action === "compare") toggleCompare(id);
  if (action === "remove-compare") toggleCompare(id);
}

resultsBox.addEventListener("click", handleCardClick);
favList.addEventListener("click", handleCardClick);
compareBox.addEventListener("click", handleCardClick);

// search form
searchForm.addEventListener("submit", function (event) {
  event.preventDefault(); // COMMON MISTAKE: forgetting this reloads the whole page
  const query = searchInput.value.trim();

  if (query === "") {
    showToast("Type a food name first");
    return;
  }
  switchView("explore");
  searchFood(query);
});

// quick search chips
chips.addEventListener("click", function (event) {
  const chip = event.target.closest(".chip");
  if (!chip) return;
  searchInput.value = chip.dataset.query;
  switchView("explore");
  searchFood(chip.dataset.query);
});

// filter + sort dropdowns
gradeFilter.addEventListener("change", applyFilters);
sortSelect.addEventListener("change", applyFilters);

// retry button inside the error box (the button is created later, so we listen on the box)
statusBox.addEventListener("click", function (event) {
  if (event.target.id === "retry-btn") {
    searchFood(localStorage.getItem(LAST_SEARCH_KEY) || searchInput.value || "oats");
  }
});

// sidebar navigation
navButtons.forEach(function (btn) {
  btn.addEventListener("click", function () {
    switchView(btn.dataset.view);
  });
});

// clear buttons
document.querySelector("#clear-favs").addEventListener("click", function () {
  favourites = [];
  saveToStorage(FAV_KEY, favourites);
  refreshAll();
});

document.querySelector("#clear-compare").addEventListener("click", function () {
  compareList = [];
  saveToStorage(COMPARE_KEY, compareList);
  refreshAll();
});

// close popup: close button, click on dark area, or Escape key
modal.addEventListener("click", function (event) {
  if (event.target === modal || event.target.id === "close-modal") {
    closeDetails();
  }
});
document.addEventListener("keydown", function (event) {
  if (event.key === "Escape") closeDetails();
});

// ---------- 6. Start the app ----------

function startApp() {
  const hour = new Date().getHours();
  const word = hour < 12 ? "Good morning" : hour < 18 ? "Good afternoon" : "Good evening";
  greeting.textContent = word + ",";

  updateBadges();
  renderFavourites();
  renderCompare();

  // reopen the last thing the user searched for
  const lastSearch = localStorage.getItem(LAST_SEARCH_KEY) || "oats";
  searchInput.value = lastSearch;
  searchFood(lastSearch);
}

startApp();

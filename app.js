/* Food Items PWA - main logic
   AJAX data load, screen navigation, Google Maps + Places "Where to Find",
   user-saved localStorage pins, PWA install, and real push subscribe/receive. */

const DATA_URL = "https://inec.sg/assignment/retrieve_records";

// PUBLIC VAPID key - MUST match the one in your push server (push-server.js).
const VAPID_PUBLIC_KEY = "BOz1H6xlMNKinnHdMpacu7f5Oso5PKEhhLkCQXGaRJUBJJ4hB4okzrK6PQQmjwv6UB7_vjmqz-C6yWqd9UQ7-Mk";

// Your deployed push server. For Netlify, this is your site's base URL, e.g.
// "https://your-site.netlify.app". Leave "" to skip server registration.
const PUSH_SERVER_URL = "";  // <-- paste your Netlify site URL here after deploying

// INEC endpoint sends no CORS headers. Order of attempts:
// The INEC endpoint sends no CORS header, so the browser can't read it
// directly. We fetch it through a CORS proxy (server-to-server, where CORS
// does not apply). The reliable proxy is tried FIRST so it succeeds on the
// first attempt and the console stays clean. Direct is kept as a last resort
// for when the app is hosted on a CORS-enabled server.
const FETCH_TARGETS = [
    url => "https://corsproxy.io/?url=" + encodeURIComponent(url),
    url => "https://api.allorigins.win/raw?url=" + encodeURIComponent(url),
    url => url
];

const REFRESH_MS = 30000; // auto re-fetch interval (live update)

/* ---- Google Maps config ----
   Replace YOUR_KEY_HERE with your own Google Maps API key.
   In Google Cloud, enable "Maps JavaScript API" AND "Places API (New)",
   and RESTRICT the key by HTTP referrer (e.g. http://127.0.0.1:5500/*)
   so it can't be abused if it leaks. Never submit a live, unrestricted key. */
const GOOGLE_MAPS_KEY = "AIzaSyD-DvN7p-4-qAWFtCTkWeG6e-HJsxNWTBM";

// Search + view are locked to Singapore.
const SG_CENTER = { lat: 1.3521, lng: 103.8198 };
const SG_BOUNDS = { south: 1.144, west: 103.535, north: 1.494, east: 104.502 };

let products = [];
let currentProduct = null;
let map = null;                 // google.maps.Map instance
let infoWindow = null;
let userMarkers = [];           // pins the user saved (localStorage)
let placeMarkers = [];          // pins from Google Places "Find nearby"
let googleReady = null;         // promise that resolves when the API is loaded
let userLocation = null;        // {lat,lng} from "My location"
let userLocMarker = null;       // the "you are here" marker
let placeClusterer = null;      // marker clusterer for place pins
let foundPlaces = [];           // [{place, marker, openNow}] from last search
let addPinMode = false;         // when true, the next map tap drops a saved pin


/* ---------- Navigation ---------- */
function displayPage(divID) {
    const pages = document.getElementsByClassName("page");
    for (let i = 0; i < pages.length; i++) {
        pages[i].style.display = (pages[i].id === divID) ? "block" : "none";
    }
}

/* ---------- AJAX load (re-callable for live refresh) ---------- */
async function loadProducts(isManual) {
    const status = document.getElementById("listing_status");
    if (isManual) status.textContent = "Refreshing…";
    else if (!products.length) status.textContent = "Fetching latest items…";
    status.style.display = "block";

    let lastError = null;
    for (let i = 0; i < FETCH_TARGETS.length; i++) {
        try {
            const res = await fetch(FETCH_TARGETS[i](DATA_URL), { method: "GET", cache: "no-store" });
            if (!res.ok) throw new Error("HTTP " + res.status);
            const data = await res.json();
            products = normalize(data.products || []);
            renderListing(products);
            document.getElementById("span_header_date").textContent = data.last_update || "";
            markSynced();
            status.style.display = products.length ? "none" : "block";
            if (!products.length) status.textContent = "No items available.";
            console.log("Loaded via target #" + (i + 1));
            return;
        } catch (err) {
            lastError = err;
            console.warn("Fetch target #" + (i + 1) + " failed:", err.message);
        }
    }
    console.error("All fetch attempts failed:", lastError);
    status.style.display = "block";
    status.textContent = "Couldn't reach the data endpoint (blocked by CORS). See console.";
}

function markSynced() {
    const el = document.getElementById("synced_at");
    if (el) {
        const t = new Date().toLocaleTimeString();
        el.textContent = "Synced " + t;
        el.style.opacity = "1";
        setTimeout(() => { el.style.opacity = "0.55"; }, 800);
    }
}

/* JSON has a stray space in the "gluten" key -> normalize */
function normalize(list) {
    return list.map(p => {
        const clean = {};
        Object.keys(p).forEach(k => { clean[k.trim()] = p[k]; });
        return {
            name: (clean.name || "").trim(),
            product_type: clean.product_type || "-",
            gluten: clean.gluten || "-",
            promo_duration: clean.promo_duration ?? "-",
            price: clean.price ?? "-",
            image: clean.image || ""
        };
    });
}

/* ---------- Listing ---------- */
function renderListing(items) {
    const ul = document.getElementById("ul_products_list");
    ul.innerHTML = "";
    items.forEach((p, index) => {
        const li = document.createElement("li");
        li.className = "li_product_item";
        li.onclick = () => showDetails(index);
        li.innerHTML =
            '<div class="li_product_image"><img src="' + p.image + '" alt="' + p.name + '"></div>' +
            '<div class="li_product_name">' + p.name +
            '<br><span class="li_product_price">' + formatPrice(p.price) + '</span></div>';
        ul.appendChild(li);
    });
}

function formatPrice(v) {
    const n = parseFloat(v);
    return isNaN(n) ? v : n.toFixed(2);
}

/* ---------- Details ---------- */
function showDetails(index) {
    const p = products[index];
    currentProduct = p;
    document.getElementById("details_title").textContent = p.name;
    document.getElementById("details_image").src = p.image;
    document.getElementById("details_image").alt = p.name;
    document.getElementById("details_promo").textContent = p.promo_duration;
    document.getElementById("details_type").textContent = p.product_type;
    document.getElementById("details_gluten").textContent = p.gluten;
    document.getElementById("details_price").textContent = formatPrice(p.price);
    displayPage("page_details");
}

/* ---------- Map ("Where to Find") - Google Maps + Places ---------- */
function markerKey(name) { return "markers_" + name; }

/* Update the "N saved" counter in the map footer. */
function updateSavedCount() {
    const el = document.getElementById("saved_count");
    if (!el || !currentProduct) return;
    const n = JSON.parse(localStorage.getItem(markerKey(currentProduct.name)) || "[]").length;
    el.textContent = n + " saved";
}

/* Load the Google Maps JS API (with Places) once, on demand. */
function loadGoogleMaps() {
    if (googleReady) return googleReady;
    googleReady = new Promise((resolve, reject) => {
        if (window.google && window.google.maps) return resolve();
        const s = document.createElement("script");
        s.src = "https://maps.googleapis.com/maps/api/js?key=" + GOOGLE_MAPS_KEY +
                "&libraries=places,geometry&v=weekly";
        s.async = true;
        s.onload = () => {
            // Also load the marker clustering helper (optional, degrades gracefully).
            if (!window.markerClusterer) {
                const c = document.createElement("script");
                c.src = "https://unpkg.com/@googlemaps/markerclusterer/dist/index.min.js";
                c.onload = () => resolve();
                c.onerror = () => resolve(); // clustering is optional
                document.head.appendChild(c);
            } else {
                resolve();
            }
        };
        s.onerror = () => reject(new Error("Google Maps failed to load - check the API key."));
        document.head.appendChild(s);
    });
    return googleReady;
}

/* Open the map screen: load API, build the map, draw saved pins. */
async function showMap() {
    if (!currentProduct) return;
    document.getElementById("map_title").textContent = "Where \u00b7 " + currentProduct.name;
    displayPage("page_map");

    if (GOOGLE_MAPS_KEY === "YOUR_KEY_HERE") {
        document.getElementById("div_product_map").innerHTML =
            "<p style='padding:16px;color:#666'>Add your Google Maps API key in app.js " +
            "(GOOGLE_MAPS_KEY) to enable the map.</p>";
        return;
    }

    try {
        await loadGoogleMaps();
        initMap();
        loadMarkers();
        // Google Maps can measure the container as 0px if it was just shown.
        // Force a resize + recenter so tiles actually render.
        setTimeout(() => {
            google.maps.event.trigger(map, "resize");
            if (!userMarkers.length) map.setCenter(SG_CENTER);
        }, 250);
    } catch (err) {
        console.error(err);
        document.getElementById("div_product_map").innerHTML =
            "<p style='padding:16px;color:#c0392b'>" + err.message + "</p>";
    }
}

/* Create the Google map once, restricted to Singapore. */
function initMap() {
    if (map) return;
    map = new google.maps.Map(document.getElementById("div_product_map"), {
        center: SG_CENTER,
        zoom: 12,
        restriction: { latLngBounds: SG_BOUNDS, strictBounds: false },
        mapTypeControl: false,
        streetViewControl: false,
        fullscreenControl: false
    });
    infoWindow = new google.maps.InfoWindow();

    // Tap the map to drop + permanently save a pin for this product.
    map.addListener("click", e => {
        if (!addPinMode) return;              // ignore taps unless "Add pin" is active
        addUserMarker(e.latLng.lat(), e.latLng.lng(), true);
        updateSavedCount();
        setAddPinMode(false);                 // one pin per activation
    });
}

/* Load this product's saved pins from localStorage. */
function loadMarkers() {
    userMarkers.forEach(m => m.setMap(null));
    userMarkers = [];
    const saved = JSON.parse(localStorage.getItem(markerKey(currentProduct.name)) || "[]");
    saved.forEach(m => addUserMarker(m.lat, m.lng, false));
    updateSavedCount();
    if (saved.length) {
        const b = new google.maps.LatLngBounds();
        saved.forEach(m => b.extend({ lat: m.lat, lng: m.lng }));
        map.fitBounds(b);
    }
}

/* Add a user pin (red). persist=true also writes it to localStorage. */
function addUserMarker(lat, lng, persist) {
    const marker = new google.maps.Marker({
        position: { lat: lat, lng: lng },
        map: map,
        title: currentProduct.name + " (saved)"
    });
    marker.addListener("click", () => {
        infoWindow.setContent(
            "<div style='max-width:200px'>" +
            "<b>" + currentProduct.name + "</b> (saved)<br>" +
            "<span style='color:#666;font-size:12px'>" + lat.toFixed(4) + ", " + lng.toFixed(4) + "</span><br>" +
            "<a href='#' onclick='deleteUserMarker(" + lat + "," + lng + ");return false;' " +
            "style='color:#c0392b;font-weight:600;display:inline-block;margin-top:6px'>Delete this pin</a>" +
            "</div>");
        infoWindow.open(map, marker);
    });
    userMarkers.push(marker);

    if (persist) {
        const key = markerKey(currentProduct.name);
        const saved = JSON.parse(localStorage.getItem(key) || "[]");
        saved.push({ lat: lat, lng: lng });
        localStorage.setItem(key, JSON.stringify(saved));
    }
}

/* Delete ONE saved pin (matched by its coordinates) from localStorage. */
function deleteUserMarker(lat, lng) {
    if (!currentProduct) return;
    const key = markerKey(currentProduct.name);
    const saved = JSON.parse(localStorage.getItem(key) || "[]");
    const idx = saved.findIndex(m => m.lat === lat && m.lng === lng);
    if (idx !== -1) saved.splice(idx, 1);   // remove just that one
    localStorage.setItem(key, JSON.stringify(saved));
    if (infoWindow) infoWindow.close();
    loadMarkers();
}

/* Remove ALL saved pins for this product. */
function clearMarkers() {
    if (!currentProduct || !map) return;
    localStorage.removeItem(markerKey(currentProduct.name));
    loadMarkers();
}

/* ADVANCED FEATURE: use Google Places to auto-find real stalls that sell
   this product in Singapore. Shows rating, open/closed, distance, a photo,
   and a "Get directions" link. Pins are clustered when they overlap. */
async function findNearby() {
    if (!currentProduct || !map) return;

    if (placeClusterer) { placeClusterer.clearMarkers(); placeClusterer = null; }
    placeMarkers.forEach(m => m.setMap(null));
    placeMarkers = [];
    foundPlaces = [];
    setBanner("Searching…");

    try {
        const request = {
            textQuery: currentProduct.name,                 // e.g. "Nasi Lemak"
            fields: ["displayName", "location", "formattedAddress",
                     "rating", "userRatingCount", "photos",
                     "regularOpeningHours", "utcOffsetMinutes"],
            region: "sg",
            language: "en",
            maxResultCount: 15
        };
        if (userLocation) request.locationBias = { center: userLocation, radius: 6000 };
        else request.locationRestriction = SG_BOUNDS;

        const { places } = await google.maps.places.Place.searchByText(request);

        if (!places || !places.length) {
            setBanner("No results found for \"" + currentProduct.name + "\"");
            return;
        }

        // Build a record per place, including whether it's open now (for filtering).
        for (const place of places) {
            let openNow = null;
            try {
                const o = await place.isOpen();
                openNow = (o === true) ? true : (o === false) ? false : null;
            } catch (e) { /* hours unknown */ }

            const marker = new google.maps.Marker({
                position: place.location,
                title: place.displayName,
                icon: "https://maps.google.com/mapfiles/ms/icons/blue-dot.png"
            });
            marker.addListener("click", () => {
                const openText = openNow === true ? "🟢 Open now"
                               : openNow === false ? "🔴 Closed" : "";
                infoWindow.setContent(buildPlaceInfo(place, openText));
                infoWindow.open(map, marker);
            });
            foundPlaces.push({ place: place, marker: marker, openNow: openNow });
        }

        renderFoundPlaces();
    } catch (err) {
        console.error("Places search failed:", err);
        setBanner("Search failed: " + err.message);
    }
}

/* Draw the found stalls, applying the "Open now" filter, clustering,
   fitting bounds, and updating the result-count banner. */
function renderFoundPlaces() {
    const openOnly = document.getElementById("chk_open_now") &&
                     document.getElementById("chk_open_now").checked;

    if (placeClusterer) { placeClusterer.clearMarkers(); placeClusterer = null; }
    placeMarkers.forEach(m => m.setMap(null));
    placeMarkers = [];

    const visible = foundPlaces.filter(fp => !openOnly || fp.openNow === true);
    visible.forEach(fp => placeMarkers.push(fp.marker));

    if (window.markerClusterer && markerClusterer.MarkerClusterer) {
        placeClusterer = new markerClusterer.MarkerClusterer({ map: map, markers: placeMarkers });
    } else {
        placeMarkers.forEach(m => m.setMap(map));
    }

    const bounds = new google.maps.LatLngBounds();
    visible.forEach(fp => bounds.extend(fp.place.location));
    if (userLocation) bounds.extend(userLocation);
    if (visible.length) map.fitBounds(bounds);

    if (openOnly) {
        setBanner("Showing " + visible.length + " of " + foundPlaces.length + " (open now)");
    } else {
        setBanner("Found " + foundPlaces.length + " stall" + (foundPlaces.length === 1 ? "" : "s"));
    }
}

/* Small status banner near the top of the map. */
function setBanner(text) {
    const el = document.getElementById("map_banner");
    if (!el) return;
    el.textContent = text;
    el.style.display = text ? "block" : "none";
}

/* Convert a Google result into a permanent saved (red) pin. */
function saveFoundStall(lat, lng) {
    if (!currentProduct) return;
    addUserMarker(lat, lng, true);   // draws + persists to localStorage
    updateSavedCount();
    if (infoWindow) infoWindow.close();
}

/* Recenter the map to the Singapore overview. */
function recenterMap() {
    if (!map) return;
    map.setCenter(SG_CENTER);
    map.setZoom(11);
}

/* Toggle "Add pin" mode: when on, the next map tap saves a pin. */
function setAddPinMode(on) {
    addPinMode = on;
    const btn = document.getElementById("btn_add_pin");
    const banner = document.getElementById("map_banner");
    if (btn) {
        btn.textContent = on ? "Tap map to place… (cancel)" : "Add pin";
        btn.style.color = on ? "#ffd166" : "";
    }
    if (on) setBanner("Tap anywhere on the map to save that spot");
    else if (banner) banner.style.display = "none";
    if (map) map.setOptions({ draggableCursor: on ? "crosshair" : null });
}

function toggleAddPin() { setAddPinMode(!addPinMode); }

/* Build the info-window HTML: name, rating, open state, distance, photo, directions. */
function buildPlaceInfo(place, openText) {
    const name = place.displayName || "Stall";
    const addr = place.formattedAddress || "";

    // Rating line
    let rating = "";
    if (place.rating) {
        rating = "⭐ " + place.rating.toFixed(1) +
                 (place.userRatingCount ? " (" + place.userRatingCount + ")" : "");
    }
    const ratingLine = [rating, openText].filter(Boolean).join(" · ");

    // Today's opening / closing time (from regularOpeningHours)
    let hoursLine = "";
    try {
        const desc = place.regularOpeningHours && place.regularOpeningHours.weekdayDescriptions;
        if (desc && desc.length) {
            const days = ["Sunday", "Monday", "Tuesday", "Wednesday", "Thursday", "Friday", "Saturday"];
            const today = days[new Date().getDay()];
            const line = desc.find(d => d.indexOf(today) === 0);
            // line looks like "Monday: 9:00 AM – 9:00 PM" -> keep just the times
            if (line) hoursLine = "🕒 " + line.replace(today + ": ", "");
        }
    } catch (e) { /* ignore */ }

    // Distance from the user (needs the geometry library + a known user location)
    let distance = "";
    try {
        if (userLocation && google.maps.geometry) {
            const m = google.maps.geometry.spherical.computeDistanceBetween(
                new google.maps.LatLng(userLocation), place.location);
            distance = (m < 1000) ? Math.round(m) + " m away" : (m / 1000).toFixed(1) + " km away";
        }
    } catch (e) { /* ignore */ }

    // Photo (first one, if any)
    let photo = "";
    try {
        if (place.photos && place.photos.length) {
            const uri = place.photos[0].getURI({ maxWidth: 220, maxHeight: 160 });
            console.log("Place photo URI:", uri);
            photo = "<img src='" + uri + "' alt='' " +
                "onerror=\"this.style.display='none'\" " +
                "style='width:100%;max-width:220px;border-radius:4px;margin-top:6px'>";
        } else {
            console.log("No photos for", place.displayName);
        }
    } catch (e) { console.warn("Photo failed:", e.message); }

    // Directions: opens Google Maps navigation (origin = user if known)
    const dest = place.location.lat() + "," + place.location.lng();
    let dir = "https://www.google.com/maps/dir/?api=1&destination=" + dest;
    if (userLocation) dir += "&origin=" + userLocation.lat + "," + userLocation.lng;

    const saveLink = "<a href='#' onclick='saveFoundStall(" +
        place.location.lat() + "," + place.location.lng() + ");return false;' " +
        "style='display:inline-block;margin-top:6px;margin-right:10px;font-weight:600;color:#c0392b'>➕ Save this spot</a>";

    return "<div style='max-width:230px'>" +
        "<b>" + name + "</b><br>" +
        (ratingLine ? ratingLine + "<br>" : "") +
        (hoursLine ? "<span style='font-size:12px'>" + hoursLine + "</span><br>" : "") +
        (distance ? distance + "<br>" : "") +
        (addr ? "<span style='color:#666;font-size:12px'>" + addr + "</span><br>" : "") +
        photo +
        "<div style='margin-top:6px'>" + saveLink +
        "<a href='" + dir + "' target='_blank' style='font-weight:600'>Get directions ›</a></div>" +
        "</div>";
}

/* ADVANCED FEATURE: center the map on the user's real location (browser
   Geolocation - free, no Google needed) and search stalls around them. */
function myLocation() {
    if (!map) return;
    if (!navigator.geolocation) { alert("Geolocation is not supported on this device."); return; }

    navigator.geolocation.getCurrentPosition(pos => {
        userLocation = { lat: pos.coords.latitude, lng: pos.coords.longitude };
        map.setCenter(userLocation);
        map.setZoom(15);

        if (userLocMarker) userLocMarker.setMap(null);
        userLocMarker = new google.maps.Marker({
            position: userLocation,
            map: map,
            title: "You are here",
            icon: "https://maps.google.com/mapfiles/ms/icons/green-dot.png"
        });

        // Re-run the search so results are around the user.
        findNearby();
    }, err => {
        console.warn("Geolocation failed:", err.message);
        alert("Could not get your location: " + err.message);
    });
}

/* =========================================================
   PWA: install, PUSH (subscribe + receive)
   (Service Worker is REGISTERED in index.html; here we just
    use navigator.serviceWorker.ready to talk to it.)
   ========================================================= */
let deferredInstall = null;

window.addEventListener("beforeinstallprompt", e => {
    e.preventDefault();
    deferredInstall = e;
    document.getElementById("btn_install").style.display = "inline-block";
});

async function installApp() {
    if (!deferredInstall) return;
    deferredInstall.prompt();
    await deferredInstall.userChoice;
    deferredInstall = null;
    document.getElementById("btn_install").style.display = "none";
}

/* Convert the base64url VAPID key to the Uint8Array subscribe() needs */
function urlBase64ToUint8Array(base64String) {
    const padding = "=".repeat((4 - base64String.length % 4) % 4);
    const base64 = (base64String + padding).replace(/-/g, "+").replace(/_/g, "/");
    const raw = atob(base64);
    const out = new Uint8Array(raw.length);
    for (let i = 0; i < raw.length; i++) out[i] = raw.charCodeAt(i);
    return out;
}

/* Real push: ask permission, then SUBSCRIBE to the push service.
   Once subscribed, a push sent to that subscription (or a DevTools
   "Push" test) fires the SW 'push' handler, which displays it. */
async function enablePush() {
    if (!("Notification" in window) || !("PushManager" in window)) {
        alert("Push is not supported on this device/browser.");
        return;
    }
    const perm = await Notification.requestPermission();
    if (perm !== "granted") { alert("Notification permission denied."); return; }

    const reg = await navigator.serviceWorker.ready;
    try {
        let sub = await reg.pushManager.getSubscription();
        if (!sub) {
            sub = await reg.pushManager.subscribe({
                userVisibleOnly: true,
                applicationServerKey: urlBase64ToUint8Array(VAPID_PUBLIC_KEY)
            });
        }
        console.log("Push subscription:", JSON.stringify(sub));

        // Register this device with the push server so it can send us pushes.
        if (PUSH_SERVER_URL) {
            try {
                await fetch(PUSH_SERVER_URL + "/.netlify/functions/subscribe", {
                    method: "POST",
                    headers: { "Content-Type": "application/json" },
                    body: JSON.stringify(sub)
                });
                console.log("Subscription sent to push server.");
            } catch (e) {
                console.warn("Could not reach push server:", e.message);
            }
        }

        // Confirm to the user that the receive path is live.
        reg.showNotification("Push enabled", {
            body: "You're subscribed. Incoming pushes will appear here.",
            icon: "img/icon-192.png",
            badge: "img/icon-192.png",
            data: { url: "./" }
        });
    } catch (err) {
        console.error("Push subscribe failed:", err);
        alert("Push subscribe failed: " + err.message);
    }
}

/* Optional: fire a local test notification through the SW display path */
async function testNotification() {
    if (!("Notification" in window)) { alert("Notifications not supported."); return; }
    const perm = await Notification.requestPermission();
    if (perm !== "granted") { alert("Notification permission denied."); return; }
    const reg = await navigator.serviceWorker.ready;
    reg.showNotification("Food Items", {
        body: "New promo items are available. Tap to open the listing.",
        icon: "img/icon-192.png",
        badge: "img/icon-192.png",
        data: { url: "./" }
    });
}

/* ---------- Boot: buttons + live refresh ---------- */
window.addEventListener("DOMContentLoaded", () => {
    const actions = document.createElement("div");
    actions.id = "pwa_actions";
    actions.innerHTML =
        '<span id="synced_at" class="synced_tag"></span>' +
        '<button id="btn_refresh" class="pwa_btn">Refresh</button>' +
        '<button id="btn_install" class="pwa_btn" style="display:none;">Install</button>' +
        '<button id="btn_push" class="pwa_btn">Push</button>' +
        '<button id="btn_notify" class="pwa_btn">Notify</button>';
    document.body.appendChild(actions);

    document.getElementById("btn_refresh").onclick = () => loadProducts(true);
    document.getElementById("btn_install").onclick = installApp;
    document.getElementById("btn_push").onclick = enablePush;
    document.getElementById("btn_notify").onclick = testNotification;
    document.getElementById("btn_clear_markers").onclick = clearMarkers;
    document.getElementById("btn_find_nearby").onclick = findNearby;
    document.getElementById("btn_my_location").onclick = myLocation;
    document.getElementById("btn_recenter").onclick = recenterMap;
    document.getElementById("btn_add_pin").onclick = toggleAddPin;
    document.getElementById("chk_open_now").onchange = () => {
        if (foundPlaces.length) renderFoundPlaces();
    };

    loadProducts();
    // Live update: re-fetch periodically so UI reflects service changes.
    setInterval(() => loadProducts(), REFRESH_MS);
});

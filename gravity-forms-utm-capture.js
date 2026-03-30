console.log("UTM script loaded");

/* ---------------------------------
   CONFIG
--------------------------------- */

var CONFIG = {
  storageKeyAttribution: "lead_attribution_last_touch",
  storageKeyNav: "lead_internal_nav",
  persistenceDays: 60,

  // params we care about for paid attribution
  trackedParams: [
    "utm_source",
    "utm_medium",
    "utm_campaign",
    "utm_term",
    "utm_content",
    "gclid",
    "fbclid",
  ],
};

/*
  GF field map by form id

  key = logical value name we want to inject
  value = GF field id for that form

  form ids:
  5 = website top form
  2 = website bottom form
  1 = mobile form
*/
var FORM_FIELD_MAP = {
  // website top form
  5: {
    utm_source: 24,
    utm_medium: 15,
    utm_campaign: 16,
    utm_term: 17,
    utm_content: 18,
    gclid: 19,
    fbclid: 22,
    request_uri: 20,
    http_referer: 21,
  },

  // website bottom form
  2: {
    utm_source: 15,
    utm_medium: 16,
    utm_campaign: 17,
    utm_term: 18,
    utm_content: 19,
    gclid: 20,
    fbclid: 23,
    request_uri: 21,
    http_referer: 22,
  },

  // mobile form
  1: {
    utm_source: 21,
    utm_medium: 22,
    utm_campaign: 23,
    utm_term: 24,
    utm_content: 25,
    gclid: 26,
    fbclid: 29,
    request_uri: 27,
    http_referer: 28,
  },
};

/* ---------------------------------
   EMPTY STATE FACTORIES
--------------------------------- */

function createEmptyAttribution() {
  return {
    version: 1,
    updatedAt: 0,
    expiresAt: 0,
    utms: {
      utm_source: "",
      utm_medium: "",
      utm_campaign: "",
      utm_term: "",
      utm_content: "",
      gclid: "",
      fbclid: "",
    },
    context: {
      http_referer: "",
    },
  };
}

function createEmptyNavState() {
  return {
    currentInternalPage: "",
    previousInternalPage: "",
    updatedAt: 0,
  };
}

/* ---------------------------------
   STORAGE HELPERS
--------------------------------- */

function readStorage(key, createFallback) {
  try {
    var raw = localStorage.getItem(key);
    return raw ? JSON.parse(raw) : createFallback();
  } catch (e) {
    return createFallback();
  }
}

function writeStorage(key, value) {
  try {
    localStorage.setItem(key, JSON.stringify(value));
  } catch (e) {}
}

/* ---------------------------------
   GENERAL HELPERS
--------------------------------- */

function nowTs() {
  return Date.now();
}

function getExpiryTs(days) {
  return nowTs() + days * 24 * 60 * 60 * 1000;
}

function isExpired(attribution) {
  return !attribution.expiresAt || nowTs() > attribution.expiresAt;
}

/*
  Pull current tracking params from the URL.
  Missing params become blank strings so object shape stays stable.
*/
function getCurrentTouchParams() {
  var params = new URLSearchParams(window.location.search);

  var touch = {
    utm_source: "",
    utm_medium: "",
    utm_campaign: "",
    utm_term: "",
    utm_content: "",
    gclid: "",
    fbclid: "",
  };

  for (var i = 0; i < CONFIG.trackedParams.length; i++) {
    var key = CONFIG.trackedParams[i];
    touch[key] = params.get(key) || "";
  }

  return touch;
}

/*
  Core UTM touch = real campaign landing touch.
  We use this to decide whether to overwrite stored attribution.
  This avoids wiping UTMs just because gclid survives on internal nav.
*/
function hasCoreUtmTouch(touch) {
  return !!(
    touch.utm_source ||
    touch.utm_medium ||
    touch.utm_campaign ||
    touch.utm_term ||
    touch.utm_content
  );
}

/*
  Broader "has any marketing related param" check.
  Left in for logging / debugging visibility.
*/
function hasMarketingTouch(touch) {
  for (var i = 0; i < CONFIG.trackedParams.length; i++) {
    var key = CONFIG.trackedParams[i];

    if (touch[key]) {
      return true;
    }
  }

  return false;
}

/*
  Best-effort external referrer check.
*/
function isExternalReferrer(referrer) {
  if (!referrer) return false;

  try {
    var refURL = new URL(referrer);
    return refURL.hostname !== window.location.hostname;
  } catch (e) {
    return false;
  }
}

/* ---------------------------------
   ATTRIBUTION STATE
--------------------------------- */

/*
  Build a last-touch attribution state from the current URL touch.
  True core UTM touch = UTM params only.
*/
function buildAttributionFromTouch(touch) {
  var externalReferrer = isExternalReferrer(document.referrer)
    ? document.referrer
    : "";

  return {
    version: 1,
    updatedAt: nowTs(),
    expiresAt: getExpiryTs(CONFIG.persistenceDays),
    utms: {
      utm_source: touch.utm_source || "",
      utm_medium: touch.utm_medium || "",
      utm_campaign: touch.utm_campaign || "",
      utm_term: touch.utm_term || "",
      utm_content: touch.utm_content || "",
      gclid: touch.gclid || "",
      fbclid: touch.fbclid || "",
    },
    context: {
      http_referer: externalReferrer,
    },
  };
}

/*
  Read stored attribution state and wipe it if expired.
*/
function getValidAttributionState() {
  var stored = readStorage(
    CONFIG.storageKeyAttribution,
    createEmptyAttribution,
  );

  if (isExpired(stored)) {
    return createEmptyAttribution();
  }

  return stored;
}

/* ---------------------------------
   NAV STATE
--------------------------------- */

/*
  Only want the pathname, not the full query string.
  UTMs already live in stored attribution, no need to duplicate in nav state.
*/
function getCurrentPagePath() {
  return window.location.pathname;
}

/*
  Track:
  - current internal page
  - previous internal page

  If the page is refreshed, keep the previous page stable.
*/
function updateNavState(existingNav) {
  var currentPage = getCurrentPagePath();

  if (existingNav.currentInternalPage === currentPage) {
    return {
      currentInternalPage: existingNav.currentInternalPage || currentPage,
      previousInternalPage: existingNav.previousInternalPage || "",
      updatedAt: nowTs(),
    };
  }

  return {
    currentInternalPage: currentPage,
    previousInternalPage: existingNav.currentInternalPage || "",
    updatedAt: nowTs(),
  };
}

/* ---------------------------------
   FIELD VALUE BUILDERS
--------------------------------- */

/*
  Build the values that will be injected into GF hidden fields.

  request_uri logic:
  - prefer previous page if it exists
  - otherwise fallback to current page

  This gives us data on first-page submit and multi-page journeys.

  http_referer logic:
  - prefer stored http_referer from attribution state because it is more likely
    to be the true external referrer
  - otherwise stay blank
*/
function getFieldValues(attributionState, navState) {
  return {
    utm_source: attributionState.utms.utm_source || "",
    utm_medium: attributionState.utms.utm_medium || "",
    utm_campaign: attributionState.utms.utm_campaign || "",
    utm_term: attributionState.utms.utm_term || "",
    utm_content: attributionState.utms.utm_content || "",
    gclid: attributionState.utms.gclid || "",
    fbclid: attributionState.utms.fbclid || "",
    request_uri:
      navState.previousInternalPage || navState.currentInternalPage || "",
    http_referer: attributionState.context.http_referer || "",
  };
}

/* ---------------------------------
   FORM FIELD INJECTION
--------------------------------- */

/*
  Inject hidden fields into GF forms using the field map.

  Important:
  We use querySelectorAll here instead of getElementById because form 1 has
  duplicate IDs in the DOM on mobile. getElementById only returns the first
  match, which means only the top form would get populated on mobile.
  querySelectorAll returns all matching elements so we can populate all copies.
*/
function injectFieldsIntoForm(formId, fieldValues) {
  var fieldMap = FORM_FIELD_MAP[formId];
  if (!fieldMap) return;

  for (var key in fieldMap) {
    if (!fieldMap.hasOwnProperty(key)) continue;

    var fieldId = fieldMap[key];
    var inputId = "input_" + formId + "_" + fieldId;
    var inputs = document.querySelectorAll("#" + inputId);

    if (!inputs.length) continue;

    var value = fieldValues[key] || "";

    for (var i = 0; i < inputs.length; i++) {
      var input = inputs[i];

      if (input.value !== value) {
        input.value = value;

        try {
          input.dispatchEvent(new Event("change", { bubbles: true }));
        } catch (e) {}
      }
    }
  }
}

/* ---------------------------------
   INJECT INTO ALL TRACKED FORMS
--------------------------------- */

function injectAllTrackedForms(attributionState, navState) {
  var fieldValues = getFieldValues(attributionState, navState);

  injectFieldsIntoForm(5, fieldValues);
  injectFieldsIntoForm(2, fieldValues);
  injectFieldsIntoForm(1, fieldValues);

  // safety log during rollout
  console.log("fieldValues", fieldValues);
}

/* ---------------------------------
   SUBMIT SAFEGUARD
--------------------------------- */

/*
  Bind submit listeners to all matching form nodes.

  - forms can rerender
  - mobile had duplicate form IDs in DOM
  - we want one last injection right before submit
*/
function bindFormSubmitSafeguard() {
  for (var formId in FORM_FIELD_MAP) {
    if (!FORM_FIELD_MAP.hasOwnProperty(formId)) continue;

    var forms = document.querySelectorAll("#gform_" + formId);
    if (!forms.length) continue;

    for (var i = 0; i < forms.length; i++) {
      var form = forms[i];

      if (!form || form.getAttribute("data-utm-bound") === "true") continue;

      form.addEventListener("submit", function () {
        var latestAttributionState = getValidAttributionState();
        var latestNavState = readStorage(
          CONFIG.storageKeyNav,
          createEmptyNavState,
        );

        injectAllTrackedForms(latestAttributionState, latestNavState);
      });

      form.setAttribute("data-utm-bound", "true");
    }
  }
}

/* ---------------------------------
   GF AJAX RENDER HOOK
--------------------------------- */

/*
  GF forms can rerender after AJAX so we inject again after render.
*/
if (window.jQuery) {
  jQuery(document).on("gform_post_render", function () {
    var latestAttributionState = getValidAttributionState();
    var latestNavState = readStorage(CONFIG.storageKeyNav, createEmptyNavState);

    injectAllTrackedForms(latestAttributionState, latestNavState);
    bindFormSubmitSafeguard();
  });
}

/* ---------------------------------
   MAIN RUNTIME FLOW
--------------------------------- */

var attributionState = getValidAttributionState();
var navState = readStorage(CONFIG.storageKeyNav, createEmptyNavState);

var currentTouch = getCurrentTouchParams();
var hasTouch = hasMarketingTouch(currentTouch);
var hasCoreTouch = hasCoreUtmTouch(currentTouch);

/*
  Only overwrite attribution on a true core UTM touch.
  This prevents internal pages with lingering gclid or fbclid from wiping out attribution.
*/
if (hasCoreTouch) {
  attributionState = buildAttributionFromTouch(currentTouch);
}

// always update internal nav state
navState = updateNavState(navState);

// persist both objects
writeStorage(CONFIG.storageKeyAttribution, attributionState);
writeStorage(CONFIG.storageKeyNav, navState);

// inject fields on initial load
injectAllTrackedForms(attributionState, navState);

// bind submit safeguard to catch any changes since initial load and before submit
bindFormSubmitSafeguard();

/* ---------------------------------
   SAFETY / DEBUG LOGS
--------------------------------- */

console.log("hasMarketingTouch", hasTouch);
console.log("hasCoreUtmTouch", hasCoreTouch);
console.log("final attributionState", attributionState);
console.log("final navState", navState);

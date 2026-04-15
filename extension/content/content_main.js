/**
 * Content script entry point.
 * Orchestrates: scan fields -> match -> preview -> fill.
 * Communicates with the background service worker via chrome.runtime messages.
 */

window.JobAutofill = window.JobAutofill || {};

(function () {
  var JA = window.JobAutofill;

  // Current state
  var currentMappings = null;

  function normalizeKeyPart(str) {
    return String(str || "")
      .trim()
      .toLowerCase()
      .replace(/\s+/g, " ")
      .replace(/[^a-z0-9 _-]/g, "")
      .replace(/\s/g, "-")
      .slice(0, 80);
  }

  // Small deterministic hash (avoid async crypto for speed)
  function hashString(str) {
    var s = String(str || "");
    var hash = 5381;
    for (var i = 0; i < s.length; i++) {
      hash = ((hash << 5) + hash) ^ s.charCodeAt(i);
      hash = hash >>> 0;
    }
    return hash.toString(16);
  }

  function firstText(selectors) {
    for (var i = 0; i < selectors.length; i++) {
      var el = document.querySelector(selectors[i]);
      if (!el) continue;
      var t = (el.innerText || el.textContent || "").trim();
      if (t) return t;
    }
    return "";
  }

  function extractJobMeta() {
    var url = window.location.href;
    var title = firstText(["h1", '[data-automation-id="jobPostingHeader"]']) || document.title || "";

    // Best-effort company extraction
    var ogSite = document.querySelector('meta[property="og:site_name"]');
    var ogTitle = document.querySelector('meta[property="og:title"]');
    var company = (ogSite && ogSite.content) ? ogSite.content.trim() : "";
    if (!company && ogTitle && ogTitle.content) {
      // Often "Role at Company"
      var parts = ogTitle.content.split(" at ");
      if (parts.length === 2) company = parts[1].trim();
    }
    if (!company && title) {
      // Often "Company - Role" or "Role | Company"
      var m = title.split(" | ");
      if (m.length >= 2) company = m[m.length - 1].trim();
      if (!company) {
        var m2 = title.split(" - ");
        if (m2.length >= 2) company = m2[0].trim();
      }
    }

    // Best-effort location extraction
    var location =
      firstText([
        '[class*="location" i]',
        '[data-automation-id*="location" i]',
        '[data-testid*="location" i]',
      ]) || "";
    if (location && location.length > 120) location = location.slice(0, 120);

    return {
      url: url,
      hostname: window.location.hostname,
      title: title,
      company: company,
      location: location,
      capturedAt: new Date().toISOString(),
    };
  }

  function buildJobKey(jobMeta) {
    var company = normalizeKeyPart(jobMeta && jobMeta.company);
    var title = normalizeKeyPart(jobMeta && jobMeta.title);
    var location = normalizeKeyPart(jobMeta && jobMeta.location);
    var urlHash = hashString(jobMeta && jobMeta.url);

    var parts = [company, title, location].filter(Boolean);
    if (parts.length === 0) {
      parts = [normalizeKeyPart(window.location.hostname)];
    }
    return parts.join("|") + "|" + urlHash;
  }

  // ---- JD Extraction --------------------------------------------------------

  var ATS_SIGNAL_WORDS = [
    "requirements", "responsibilities", "qualifications", "you will",
    "we're looking for", "we are looking for", "what you'll do",
    "what you will do", "about the role", "about this role",
    "job description", "who you are", "must have", "nice to have",
    "preferred", "minimum qualifications", "basic qualifications",
  ];

  var KNOWN_JD_SELECTORS = [
    // Jobright
    '[class*="job-description"]', '[class*="jd-"]',
    // LinkedIn
    '.jobs-description__content', '.jobs-description-content',
    // Greenhouse
    '#content .job-description', '#app_body .job-description',
    // Lever
    '.section-wrapper .content', '.posting-categories + div',
    // Workday
    '[data-automation-id="jobPostingDescription"]',
  ];

  var GENERIC_JD_SELECTORS = [
    '[class*="job-desc"]', '[id*="job-desc"]',
    '[class*="jobDescription"]', '[id*="jobDescription"]',
    '[class*="description"]', '[data-testid*="description"]',
    'article', 'main', '[role="main"]',
  ];

  function countSignalWords(text) {
    var lower = text.toLowerCase();
    var count = 0;
    for (var i = 0; i < ATS_SIGNAL_WORDS.length; i++) {
      if (lower.indexOf(ATS_SIGNAL_WORDS[i]) !== -1) count++;
    }
    return count;
  }

  function getCleanText(el) {
    return (el.innerText || el.textContent || "").trim();
  }

  function wordCount(text) {
    return text.split(/\s+/).filter(Boolean).length;
  }

  function scoreCandidate(el) {
    var text = getCleanText(el);
    var wc = wordCount(text);
    if (wc < 50) return -1;
    var signals = countSignalWords(text);
    if (signals < 2) return -1;
    return wc + (signals * 200);
  }

  // Expose to opportunity detector via JA._extractJobDescription
  JA._extractJobDescription = extractJobDescription;

  function extractJobDescription() {
    var method = "none";
    var text = "";

    // Tier 1: Known job board selectors
    for (var i = 0; i < KNOWN_JD_SELECTORS.length; i++) {
      var el = document.querySelector(KNOWN_JD_SELECTORS[i]);
      if (!el) continue;
      var t = getCleanText(el);
      if (wordCount(t) >= 50) {
        text = t;
        method = "known_selector";
        break;
      }
    }

    // Tier 2: Generic career page selectors, scored
    if (!text) {
      var bestScore = -1;
      var bestText = "";
      for (var j = 0; j < GENERIC_JD_SELECTORS.length; j++) {
        var els = document.querySelectorAll(GENERIC_JD_SELECTORS[j]);
        for (var k = 0; k < els.length; k++) {
          var s = scoreCandidate(els[k]);
          if (s > bestScore) {
            bestScore = s;
            bestText = getCleanText(els[k]);
          }
        }
      }
      if (bestText) {
        text = bestText;
        method = "generic_selector";
      }
    }

    // Tier 3: Full DOM walk
    if (!text) {
      var candidates = document.querySelectorAll("section, div");
      var bestScore2 = -1;
      var bestText2 = "";
      for (var n = 0; n < candidates.length; n++) {
        var s2 = scoreCandidate(candidates[n]);
        if (s2 > bestScore2) {
          bestScore2 = s2;
          bestText2 = getCleanText(candidates[n]);
        }
      }
      if (bestText2) {
        text = bestText2;
        method = "dom_walk";
      }
    }

    // Cap at ~15000 chars to stay within token budget
    if (text.length > 15000) {
      text = text.substring(0, 15000);
    }

    return {
      jdText: text,
      wordCount: wordCount(text),
      extractionMethod: method,
    };
  }

  // ---- Message handler ------------------------------------------------------

  chrome.runtime.onMessage.addListener(function (msg, sender, sendResponse) {
    if (!msg || !msg.action) return false;

    switch (msg.action) {
      case "toggleSidebar":
        if (JA.toggleSidebar) JA.toggleSidebar();
        return false;

      case "openSidebar":
        if (JA.openSidebar) JA.openSidebar();
        return false;

      case "hideSidebar":
        if (JA.hideSidebar) JA.hideSidebar();
        return false;

      case "scanFields":
        handleScan(sendResponse);
        return true; // async response

      case "previewFill":
        handlePreview(msg.mappings, sendResponse);
        return true;

      case "executeFill":
        handleFill(msg.mappings, sendResponse);
        return true;

      case "clearPreview":
        JA.clearPreview();
        sendResponse({ ok: true });
        return false;

      case "ping":
        sendResponse({ ok: true, url: window.location.href });
        return false;

      case "getJobContext":
        try {
          var meta = extractJobMeta();
          sendResponse({ ok: true, jobMeta: meta, jobKey: buildJobKey(meta) });
        } catch (e) {
          sendResponse({ ok: false, error: String(e) });
        }
        return false;

      case "extractJobDescription":
        try {
          var jdResult = extractJobDescription();
          sendResponse({
            ok: true,
            jdText: jdResult.jdText,
            wordCount: jdResult.wordCount,
            extractionMethod: jdResult.extractionMethod,
          });
        } catch (e) {
          sendResponse({ ok: false, error: String(e) });
        }
        return false;

      default:
        // Sidebar and other scripts may handle the same message; do not respond.
        return false;
    }
  });

  /**
   * Scan the current page for form fields.
   */
  function handleScan(sendResponse) {
    try {
      // Get the adapter for this site
      var adapter = JA.adapterRegistry
        ? JA.adapterRegistry.getAdapter(window.location.href)
        : null;

      var fields;
      if (adapter && adapter.extractFields) {
        fields = adapter.extractFields();
      } else {
        fields = JA.extractFields();
      }

      // Detect navigation buttons
      var navButton = JA.detectNavigationButton();
      var formLayout = JA.detectFormLayout ? JA.detectFormLayout(navButton) : null;
      var repeatSectionHints = JA.detectRepeatSectionHints ? JA.detectRepeatSectionHints() : [];
      var jobMeta = extractJobMeta();
      var jobKey = buildJobKey(jobMeta);

      JA.log("INFO", "Scanned " + fields.length + " fields on " + window.location.href);

      sendResponse({
        ok: true,
        fields: fields,
        navButton: navButton,
        formLayout: formLayout,
        repeatSectionHints: repeatSectionHints,
        url: window.location.href,
        adapterName: adapter ? adapter.name : "generic",
        jobMeta: jobMeta,
        jobKey: jobKey,
      });
    } catch (err) {
      JA.log("ERROR", "Scan failed: " + err);
      sendResponse({ ok: false, error: String(err) });
    }
  }

  /**
   * Show preview of proposed fills.
   */
  function handlePreview(mappings, sendResponse) {
    try {
      currentMappings = mappings;
      JA.showPreview(mappings);

      var previewCount = mappings.filter(function (m) {
        return m.confidence >= JA.constants.CONFIDENCE_THRESHOLD && m.value;
      }).length;

      JA.log("INFO", "Preview: " + previewCount + " fields will be filled");
      sendResponse({ ok: true, previewCount: previewCount });
    } catch (err) {
      JA.log("ERROR", "Preview failed: " + err);
      sendResponse({ ok: false, error: String(err) });
    }
  }

  /**
   * Execute the fill using current or provided mappings.
   */
  function handleFill(mappings, sendResponse) {
    try {
      var toFill = mappings || currentMappings;
      if (!toFill || toFill.length === 0) {
        sendResponse({ ok: false, error: "No mappings to fill" });
        return;
      }

      // Clear any existing preview
      JA.clearPreview();

      // Get the adapter for possible fill overrides
      var adapter = JA.adapterRegistry
        ? JA.adapterRegistry.getAdapter(window.location.href)
        : null;

      var results;
      if (adapter && adapter.fillFields) {
        results = adapter.fillFields(toFill);
      } else {
        results = JA.fillFields(toFill);
      }

      JA.log(
        "INFO",
        "Fill complete: " +
          results.filled.length +
          " filled, " +
          results.skipped.length +
          " skipped"
      );

      currentMappings = null;

      sendResponse({
        ok: true,
        filled: results.filled,
        skipped: results.skipped,
        log: JA.getLog(),
      });
    } catch (err) {
      JA.log("ERROR", "Fill failed: " + err);
      sendResponse({ ok: false, error: String(err) });
    }
  }

  JA.extractJobMeta = extractJobMeta;
  JA.buildJobKey = buildJobKey;

  JA.log("INFO", "Job Autofill content script loaded on " + window.location.href);

  // ---- Opportunity detection on load -----------------------------------------

  // Slight delay to let page finish rendering dynamic content
  setTimeout(function () {
    if (JA.detectOpportunities) {
      JA.detectOpportunities();
    }
  }, 1500);

  // Re-detect only on SPA navigation (URL or title change), not on every DOM
  // mutation. A broad subtree MutationObserver causes an infinite loop because
  // showOpportunityWidget() itself modifies the DOM, re-triggering detection.
  // Poll every 30 s (lightweight); store the ID so it can be cleared on unload.
  var _lastUrl = window.location.href;
  var _lastTitle = document.title;
  var _spaNavTimer = setInterval(function () {
    var url = window.location.href;
    var title = document.title;
    if (url !== _lastUrl || title !== _lastTitle) {
      _lastUrl = url;
      _lastTitle = title;
      if (JA.resetOpportunityDetection) JA.resetOpportunityDetection();
      if (JA.detectOpportunities) JA.detectOpportunities();
    }
  }, 30000);

  window.addEventListener("pagehide", function () {
    clearInterval(_spaNavTimer);
  });
})();

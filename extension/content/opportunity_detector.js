/**
 * Opportunity detector.
 * Runs on page load (and on significant DOM mutations) to detect:
 *   1. Autofill-able form fields
 *   2. Job description content suitable for resume optimization
 *   3. Resume file upload inputs
 * Notifies the background (badge update) and shows the in-page widget.
 */

window.JobAutofill = window.JobAutofill || {};

(function () {
  var JA = window.JobAutofill;
  var RESUME_FILE_PATTERN = /resume|cv|curriculum\s*vitae/i;
  var hasRun = false;

  /**
   * Gather nearby text for a given element (used by widget attach logic too).
   */
  JA.nearbyTextForElement = function (el) {
    var node = el.previousSibling;
    for (var i = 0; i < 3 && node; i++) {
      if (node.nodeType === Node.TEXT_NODE) {
        var t = (node.textContent || "").trim();
        if (t) return t;
      }
      if (node.nodeType === Node.ELEMENT_NODE) {
        var t2 = (node.innerText || "").trim();
        if (t2 && t2.length < 200) return t2;
      }
      node = node.previousSibling;
    }
    var wrapper = el.closest("div, fieldset, section, li");
    if (wrapper) {
      var heading = wrapper.querySelector("h1, h2, h3, h4, h5, h6, legend");
      if (heading) return (heading.innerText || "").trim();
    }
    return "";
  };

  function detectResumeFileInputs() {
    var fileInputs = document.querySelectorAll('input[type="file"]');
    var found = [];
    for (var i = 0; i < fileInputs.length; i++) {
      var el = fileInputs[i];
      var rect = el.getBoundingClientRect();

      var context = [
        el.name || "", el.id || "",
        el.getAttribute("aria-label") || "",
        el.getAttribute("accept") || "",
      ].join(" ");

      var label = "";
      if (el.id) {
        var lbl = document.querySelector('label[for="' + el.id + '"]');
        if (lbl) label = (lbl.innerText || "").trim();
      }
      if (!label) {
        var parent = el.closest("label");
        if (parent) label = (parent.innerText || "").trim();
      }
      context += " " + label + " " + JA.nearbyTextForElement(el);

      if ((rect.width > 0 || rect.height > 0 || RESUME_FILE_PATTERN.test(context)) && RESUME_FILE_PATTERN.test(context)) {
        found.push(el);
      }
    }
    return found;
  }

  function safeSendMessage(msg, callback) {
    if (!chrome.runtime || !chrome.runtime.id) return;
    try {
      chrome.runtime.sendMessage(msg, function (resp) {
        try {
          if (chrome.runtime.lastError) return;
          if (callback) callback(resp);
        } catch (e) {
          // Extension context was invalidated between send and callback
        }
      });
    } catch (e) {
      // Extension context was invalidated at send time
    }
  }

  /**
   * Main detection entry point.
   */
  JA.detectOpportunities = function () {
    if (hasRun) return;
    hasRun = true;

    // Check if profile exists before bothering
    safeSendMessage({ action: "getProfile" }, function (resp) {
      if (!resp || !resp.ok || !resp.profile) return;

      var fields = [];
      try {
        var adapter = JA.adapterRegistry
          ? JA.adapterRegistry.getAdapter(window.location.href)
          : null;
        if (adapter && adapter.extractFields) {
          fields = adapter.extractFields();
        } else if (JA.extractFields) {
          fields = JA.extractFields();
        }
      } catch (e) {
        JA.log("WARN", "Opportunity scan field extraction failed: " + e);
      }

      var autofillOpportunity = fields.length > 0;

      var optimizeOpportunity = false;
      try {
        if (typeof JA._extractJobDescription === "function") {
          var jdResult = JA._extractJobDescription();
          optimizeOpportunity = jdResult && jdResult.wordCount >= 50;
        }
      } catch (e) {
        // extractJobDescription may not be exposed yet — that's ok
      }

      var resumeInputs = detectResumeFileInputs();
      var resumeUploadOpportunity = resumeInputs.length > 0;

      var hasOpportunity = autofillOpportunity || optimizeOpportunity || resumeUploadOpportunity;
      if (!hasOpportunity) return;

      // Notify background for badge
      safeSendMessage({
        action: "opportunityDetected",
        autofill: autofillOpportunity,
        optimize: optimizeOpportunity,
        resumeUpload: resumeUploadOpportunity,
        fieldCount: fields.length,
        url: window.location.href,
      });

      // Show in-page widget
      if (JA.showOpportunityWidget) {
        JA.showOpportunityWidget({
          autofill: autofillOpportunity,
          optimize: optimizeOpportunity,
          resumeUpload: resumeUploadOpportunity,
          fieldCount: fields.length,
        });
      }
    });
  };

  /**
   * Allow re-detection (e.g. after SPA navigation).
   */
  JA.resetOpportunityDetection = function () {
    hasRun = false;
  };
})();

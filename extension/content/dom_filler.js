/**
 * DOM field filler.
 * Adapted from resume_tool/autofill_agent.py fill_fields() (lines 243-292).
 * Replaces Playwright's page.fill / page.select_option with native DOM
 * operations + framework-safe event dispatch.
 */

window.JobAutofill = window.JobAutofill || {};

(function () {
  var THRESHOLD = window.JobAutofill.constants.CONFIDENCE_THRESHOLD;
  var log = window.JobAutofill.log;
  var setValueAndDispatch = window.JobAutofill.setValueAndDispatch;

  /**
   * Fill form fields from a mappings array.
   * Mirrors autofill_agent.py fill_fields: sorts by confidence, skips low-confidence,
   * handles select/input/textarea/checkbox.
   *
   * @param {Array} mappings - [{field_label, selector, value, confidence, ...}]
   * @returns {{filled: Array, skipped: Array}}
   */
  window.JobAutofill.fillFields = function (mappings) {
    var filled = [];
    var skipped = [];

    // Sort by confidence descending (same strategy as autofill_agent.py)
    var sorted = mappings.slice().sort(function (a, b) {
      return (b.confidence || 0) - (a.confidence || 0);
    });

    for (var i = 0; i < sorted.length; i++) {
      var m = sorted[i];
      var selector = m.selector || "";
      var value = m.value || "";
      var confidence = m.confidence || 0;
      var label = m.field_label || selector;

      if (confidence < THRESHOLD || !value) {
        skipped.push({
          field: label,
          reason: !value ? "no value" : "low confidence (" + confidence.toFixed(2) + ")",
          confidence: confidence,
        });
        log("SKIP", label + " -- " + (!value ? "no value" : "confidence " + confidence.toFixed(2)));
        continue;
      }

      try {
        var element = document.querySelector(selector);
        if (!element) {
          skipped.push({ field: label, reason: "element not found", confidence: confidence });
          log("SKIP", label + " -- selector not found: " + selector);
          continue;
        }

        var tag = element.tagName.toLowerCase();
        var type = (element.type || "").toLowerCase();

        if (tag === "select") {
          // Verify the value is a valid option
          var validOption = Array.from(element.options).some(function (o) {
            return o.value === value;
          });
          if (!validOption) {
            skipped.push({ field: label, reason: "value not in select options", confidence: confidence });
            log("SKIP", label + " -- value '" + value + "' not in options");
            continue;
          }
          setValueAndDispatch(element, value);
          filled.push({ field: label, value: value });
          log("SELECT", label + " <- " + value);
        } else if (type === "checkbox" || type === "radio") {
          setValueAndDispatch(element, value);
          filled.push({ field: label, value: String(value) });
          log("CHECK", label + " <- " + value);
        } else if (type === "file") {
          var fileData = m.__fileData;
          if (fileData && fileData.dataBase64 && JA.attachFileToElement) {
            try {
              JA.attachFileToElement(element, fileData);
              filled.push({ field: label, value: fileData.name || "resume.pdf" });
              log("FILE", label + " <- " + (fileData.name || "resume.pdf"));
            } catch (fileErr) {
              skipped.push({ field: label, reason: "file attach failed: " + fileErr, confidence: confidence });
              log("ERROR", label + " -- file attach failed: " + fileErr);
            }
          } else {
            skipped.push({ field: label, reason: "no resume file configured", confidence: confidence });
            log("SKIP", label + " -- no resume file for upload");
          }
        } else {
          // text, email, tel, url, textarea, number, etc.
          setValueAndDispatch(element, value);
          filled.push({ field: label, value: value });
          log("FILL", label + " <- " + value);
        }
      } catch (err) {
        skipped.push({ field: label, reason: String(err), confidence: confidence });
        log("ERROR", label + " -- " + err);
      }
    }

    return { filled: filled, skipped: skipped };
  };

  /**
   * Show preview highlights on fields that would be filled.
   * Adds a colored border and a tooltip-like overlay showing the proposed value.
   */
  window.JobAutofill.showPreview = function (mappings) {
    var constants = window.JobAutofill.constants;
    var PREFIX = constants.CSS_PREFIX;
    var THRESHOLD_VAL = constants.CONFIDENCE_THRESHOLD;

    // Remove any existing previews first
    window.JobAutofill.clearPreview();

    for (var i = 0; i < mappings.length; i++) {
      var m = mappings[i];
      if (!m.selector) continue;

      try {
        var el = document.querySelector(m.selector);
        if (!el) continue;

        var confidence = m.confidence || 0;
        var value = m.value || "";

        if (confidence >= THRESHOLD_VAL && value) {
          el.style.outline = constants.PREVIEW_BORDER;
          el.style.backgroundColor = constants.PREVIEW_BG;
          el.setAttribute("data-" + PREFIX + "preview", value);

          // Add a tooltip showing the proposed value
          var tooltip = document.createElement("div");
          tooltip.className = PREFIX + "tooltip";
          tooltip.textContent = value.length > 60 ? value.substring(0, 57) + "..." : value;
          tooltip.style.cssText =
            "position:absolute;z-index:999999;background:#1e40af;color:#fff;" +
            "padding:2px 8px;border-radius:4px;font-size:11px;font-family:system-ui,sans-serif;" +
            "pointer-events:none;white-space:nowrap;max-width:300px;overflow:hidden;" +
            "text-overflow:ellipsis;box-shadow:0 2px 8px rgba(0,0,0,.15);";

          var rect = el.getBoundingClientRect();
          tooltip.style.top = (window.scrollY + rect.top - 22) + "px";
          tooltip.style.left = (window.scrollX + rect.left) + "px";
          document.body.appendChild(tooltip);
        } else if (confidence > 0) {
          el.style.outline = constants.SKIPPED_BORDER;
          el.style.backgroundColor = constants.SKIPPED_BG;
          el.setAttribute("data-" + PREFIX + "skipped", "1");
        }
      } catch (e) {
        // Ignore selector errors during preview
      }
    }
  };

  /**
   * Remove all preview highlights and tooltips.
   */
  window.JobAutofill.clearPreview = function () {
    var PREFIX = window.JobAutofill.constants.CSS_PREFIX;

    // Remove tooltips
    var tooltips = document.querySelectorAll("." + PREFIX + "tooltip");
    for (var i = 0; i < tooltips.length; i++) {
      tooltips[i].remove();
    }

    // Reset styles on previewed elements
    var previewed = document.querySelectorAll("[data-" + PREFIX + "preview]");
    for (var j = 0; j < previewed.length; j++) {
      previewed[j].style.outline = "";
      previewed[j].style.backgroundColor = "";
      previewed[j].removeAttribute("data-" + PREFIX + "preview");
    }

    // Reset skipped-style elements (only those we marked)
    var skipped = document.querySelectorAll("[data-" + PREFIX + "skipped]");
    for (var k = 0; k < skipped.length; k++) {
      skipped[k].style.outline = "";
      skipped[k].style.backgroundColor = "";
      skipped[k].removeAttribute("data-" + PREFIX + "skipped");
    }
  };

  /**
   * Mark filled fields with a green highlight.
   */
  window.JobAutofill.highlightFilled = function (filledResults) {
    var constants = window.JobAutofill.constants;
    // filledResults come from fillFields, but we need to find elements by matching
    // We'll just apply green highlight to all fields that have data-jaf-preview
    var previewed = document.querySelectorAll(
      "[data-" + constants.CSS_PREFIX + "preview]"
    );
    for (var i = 0; i < previewed.length; i++) {
      previewed[i].style.outline = constants.FILLED_BORDER;
      previewed[i].style.backgroundColor = constants.FILLED_BG;
    }
  };
})();

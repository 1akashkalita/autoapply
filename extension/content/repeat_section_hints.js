/**
 * Form layout (single vs multi-step) and repeat-section ("Add experience") hints.
 */

window.JobAutofill = window.JobAutofill || {};

(function () {
  var JA = window.JobAutofill;

  function detectWizardCues() {
    var cues = [];
    if (document.querySelector('[role="progressbar"]')) cues.push("progressbar");
    if (document.querySelector('[aria-current="step"]')) cues.push("aria-current-step");
    if (
      document.querySelector(
        '[aria-label*="step" i], nav[class*="step" i], [class*="step-indicator" i], [class*="wizard" i], [data-testid*="step" i]'
      )
    ) {
      cues.push("step-ui");
    }
    var bodyText = "";
    try {
      bodyText = (document.body && document.body.innerText) ? document.body.innerText.slice(0, 12000) : "";
    } catch (e) {
      bodyText = "";
    }
    if (/\bstep\s+\d+\s+of\s+\d+/i.test(bodyText)) cues.push("step-N-of-M");
    if (/\bpage\s+\d+\s+of\s+\d+/i.test(bodyText)) cues.push("page-N-of-M");
    return cues;
  }

  /**
   * @param {{ type: string, text: string }} navButton
   */
  JA.detectFormLayout = function (navButton) {
    var nb = navButton || { type: "none", text: "" };
    var wizardCues = detectWizardCues();
    var multiStepLikely = nb.type === "next" || wizardCues.length > 0;
    var submitNearby = nb.type === "submit";
    return {
      multiStepLikely: multiStepLikely,
      submitNearby: submitNearby,
      wizardCues: wizardCues,
      navButtonType: nb.type,
    };
  };

  var SECTION_CTX_RE =
    /experience|employment|work\s*history|education|school|university|activities|extracurricular|leadership|volunteer|position|job\s*title/i;
  var ADD_LOOSE_RE = /\badd\b/i;
  var ADD_STRONG_RE =
    /another\s+(entry|row|position|experience|activity|education|school|degree)/i;
  var NEW_ENTRY_RE = /new\s+(experience|activity|education|position|school)/i;

  function buttonText(el) {
    var t =
      (el.innerText && el.innerText.trim()) ||
      (el.textContent && el.textContent.trim()) ||
      el.getAttribute("aria-label") ||
      el.getAttribute("title") ||
      "";
    return t.replace(/\s+/g, " ").trim();
  }

  function nearestContext(el) {
    var w = el.closest(
      "section, fieldset, [role='region'], form, article, [class*='section'], [class*='card'], li, tbody, table"
    );
    if (!w) w = el.parentElement;
    if (!w) return "";
    try {
      return (w.innerText || "").slice(0, 900);
    } catch (e) {
      return "";
    }
  }

  function selectorFor(el) {
    try {
      if (el.id) return "#" + CSS.escape(el.id);
    } catch (e) { /* ignore */ }
    return "";
  }

  /**
   * @returns {Array<{ kind: string, actionText: string, selector: string }>}
   */
  JA.detectRepeatSectionHints = function () {
    var hints = [];
    var max = 8;
    var seen = {};
    var candidates = document.querySelectorAll(
      'button, input[type="button"], [role="button"], a[href], a[role="button"]'
    );

    for (var i = 0; i < candidates.length && hints.length < max; i++) {
      var btn = candidates[i];
      var rect = btn.getBoundingClientRect();
      if (!rect || rect.width === 0 || rect.height === 0) continue;

      var text = buttonText(btn);
      if (!text || text.length > 140) continue;

      var strong = ADD_STRONG_RE.test(text) || NEW_ENTRY_RE.test(text);
      var looseAdd = ADD_LOOSE_RE.test(text);
      if (!strong && !looseAdd) continue;

      var ctx = nearestContext(btn);
      var inSection = SECTION_CTX_RE.test(ctx);
      if (!strong && !inSection) continue;

      var kind = "other";
      if (/experience|employment|work\s*history|position|job/i.test(ctx)) kind = "experience";
      else if (/education|school|university|degree/i.test(ctx)) kind = "education";
      else if (/activit|extracurricular|leadership|volunteer/i.test(ctx)) kind = "activity";

      var key = text.slice(0, 60) + "|" + kind;
      if (seen[key]) continue;
      seen[key] = true;

      hints.push({
        kind: kind,
        actionText: text.slice(0, 100),
        selector: selectorFor(btn),
      });
    }

    return hints;
  };
})();

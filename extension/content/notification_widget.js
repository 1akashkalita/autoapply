/**
 * In-page floating notification widget.
 * After the auto-hide timer the full card collapses to a slim side-tab that
 * the user can click to expand again. The ✕ button fully dismisses.
 * All CSS is scoped with the `jaf-` prefix to avoid collisions.
 */

window.JobAutofill = window.JobAutofill || {};

(function () {
  var JA = window.JobAutofill;
  var WIDGET_ID   = "jaf-opportunity-widget";
  var TAB_ID      = "jaf-opportunity-tab";
  var DISMISS_KEY = "jaf_widget_dismissed";
  var AUTO_HIDE_MS = 30000;

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

  var hideTimer       = null;
  var currentOpps     = null;   // remember opportunities so tab can restore widget

  // ---- Styles ----------------------------------------------------------------

  function injectStyles() {
    if (document.getElementById("jaf-widget-styles")) return;
    var style = document.createElement("style");
    style.id = "jaf-widget-styles";
    style.textContent = [
      // ---- Full widget ----
      "#" + WIDGET_ID + " {",
      "  position: fixed; bottom: 20px; right: 20px; z-index: 2147483647;",
      "  width: 300px; background: #fff; border-radius: 16px;",
      "  box-shadow: 0 8px 32px rgba(99,102,241,0.18), 0 2px 8px rgba(0,0,0,0.06);",
      "  font-family: -apple-system, BlinkMacSystemFont, 'Segoe UI', Roboto, sans-serif;",
      "  font-size: 13px; color: #334155; overflow: hidden;",
      "  animation: jaf-slide-in 0.35s ease-out;",
      "}",
      "#" + WIDGET_ID + ".jaf-hiding {",
      "  animation: jaf-slide-out 0.25s ease-in forwards;",
      "}",
      "@keyframes jaf-slide-in {",
      "  from { opacity: 0; transform: translateX(20px) scale(0.97); }",
      "  to   { opacity: 1; transform: translateX(0)    scale(1);    }",
      "}",
      "@keyframes jaf-slide-out {",
      "  from { opacity: 1; transform: translateX(0)    scale(1);    }",
      "  to   { opacity: 0; transform: translateX(20px) scale(0.97); }",
      "}",

      // ---- Side tab ----
      "#" + TAB_ID + " {",
      "  position: fixed; right: 0; top: 50%; transform: translateY(-50%);",
      "  z-index: 2147483647;",
      "  width: 32px; min-height: 88px;",
      "  background: linear-gradient(180deg, #6366f1 0%, #8b5cf6 100%);",
      "  border-radius: 12px 0 0 12px;",
      "  box-shadow: -3px 0 18px rgba(99,102,241,0.28);",
      "  cursor: pointer;",
      "  display: flex; flex-direction: column; align-items: center;",
      "  justify-content: center; gap: 6px;",
      "  padding: 10px 0;",
      "  animation: jaf-tab-in 0.3s ease-out;",
      "  transition: width 0.2s ease, box-shadow 0.2s ease;",
      "}",
      "#" + TAB_ID + ":hover {",
      "  width: 38px;",
      "  box-shadow: -5px 0 24px rgba(99,102,241,0.38);",
      "}",
      "@keyframes jaf-tab-in {",
      "  from { opacity: 0; transform: translateY(-50%) translateX(100%); }",
      "  to   { opacity: 1; transform: translateY(-50%) translateX(0);    }",
      "}",
      "#" + TAB_ID + ".jaf-tab-hiding {",
      "  animation: jaf-tab-out 0.2s ease-in forwards;",
      "}",
      "@keyframes jaf-tab-out {",
      "  from { opacity: 1; transform: translateY(-50%) translateX(0);    }",
      "  to   { opacity: 0; transform: translateY(-50%) translateX(100%); }",
      "}",
      ".jaf-tab-symbol {",
      "  color: #fff; font-size: 14px; line-height: 1; user-select: none;",
      "}",
      ".jaf-tab-label {",
      "  color: rgba(255,255,255,0.9); font-size: 9px; font-weight: 700;",
      "  letter-spacing: 0.8px; text-transform: uppercase;",
      "  writing-mode: vertical-rl; text-orientation: mixed;",
      "  transform: rotate(180deg); user-select: none;",
      "  font-family: -apple-system, BlinkMacSystemFont, 'Segoe UI', Roboto, sans-serif;",
      "}",
      ".jaf-tab-dots {",
      "  display: flex; flex-direction: column; gap: 4px; align-items: center;",
      "}",
      ".jaf-tab-dot {",
      "  width: 5px; height: 5px; border-radius: 50%;",
      "  background: rgba(255,255,255,0.7);",
      "}",

      // ---- Widget internals ----
      ".jaf-w-header {",
      "  display: flex; align-items: center; justify-content: space-between;",
      "  padding: 12px 16px 8px; border-bottom: 1px solid #f1f5f9;",
      "}",
      ".jaf-w-title {",
      "  font-size: 14px; font-weight: 700;",
      "  background: linear-gradient(135deg, #6366f1, #818cf8);",
      "  -webkit-background-clip: text; -webkit-text-fill-color: transparent;",
      "  background-clip: text;",
      "}",
      ".jaf-w-close {",
      "  background: none; border: none; cursor: pointer; font-size: 16px;",
      "  color: #94a3b8; padding: 2px 6px; border-radius: 8px; line-height: 1;",
      "  transition: background 0.15s, color 0.15s;",
      "}",
      ".jaf-w-close:hover { background: #f1f5f9; color: #475569; }",
      ".jaf-w-body { padding: 8px 12px 12px; }",
      ".jaf-w-row {",
      "  display: flex; align-items: center; gap: 10px;",
      "  padding: 8px 4px; border-bottom: 1px solid #f8fafc;",
      "}",
      ".jaf-w-row:last-child { border-bottom: none; }",
      ".jaf-w-emoji { font-size: 18px; flex-shrink: 0; }",
      ".jaf-w-label { flex: 1; font-size: 12px; color: #475569; line-height: 1.4; }",
      ".jaf-w-btn {",
      "  padding: 5px 12px; border: none; border-radius: 10px;",
      "  font-size: 12px; font-weight: 600; cursor: pointer;",
      "  color: #fff; transition: all 0.15s; flex-shrink: 0;",
      "}",
      ".jaf-w-btn:hover { transform: translateY(-1px); }",
      ".jaf-w-btn-fill { background: linear-gradient(135deg, #6366f1, #818cf8); box-shadow: 0 2px 6px rgba(99,102,241,0.25); }",
      ".jaf-w-btn-fill:hover { box-shadow: 0 4px 10px rgba(99,102,241,0.35); }",
      ".jaf-w-btn-optimize { background: linear-gradient(135deg, #8b5cf6, #a78bfa); box-shadow: 0 2px 6px rgba(139,92,246,0.25); }",
      ".jaf-w-btn-optimize:hover { box-shadow: 0 4px 10px rgba(139,92,246,0.35); }",
      ".jaf-w-btn-attach { background: linear-gradient(135deg, #059669, #34d399); box-shadow: 0 2px 6px rgba(5,150,105,0.25); }",
      ".jaf-w-btn-attach:hover { box-shadow: 0 4px 10px rgba(5,150,105,0.35); }",
    ].join("\n");
    document.head.appendChild(style);
  }

  // ---- State helpers ---------------------------------------------------------

  function isDismissed() {
    try { return sessionStorage.getItem(DISMISS_KEY) === "1"; } catch (e) { return false; }
  }

  function setDismissed() {
    try { sessionStorage.setItem(DISMISS_KEY, "1"); } catch (e) { /* ignore */ }
  }

  function clearHideTimer() {
    if (hideTimer) { clearTimeout(hideTimer); hideTimer = null; }
  }

  // ---- Remove full widget (dismissed completely) ----------------------------

  function removeWidget(animate) {
    clearHideTimer();
    var el = document.getElementById(WIDGET_ID);
    if (!el) return;
    if (animate) {
      el.classList.add("jaf-hiding");
      el.addEventListener("animationend", function () { el.remove(); }, { once: true });
    } else {
      el.remove();
    }
  }

  // ---- Collapse to side tab -------------------------------------------------

  function collapseToTab() {
    clearHideTimer();
    var el = document.getElementById(WIDGET_ID);
    if (el) {
      el.classList.add("jaf-hiding");
      el.addEventListener("animationend", function () { el.remove(); }, { once: true });
    }
    showTab();
  }

  function showTab() {
    if (document.getElementById(TAB_ID)) return;   // already showing
    if (isDismissed()) return;

    var tab = document.createElement("div");
    tab.id = TAB_ID;
    tab.title = "Job Autofill — click to expand";

    // Count how many opportunity types are active
    var dotCount = 0;
    if (currentOpps) {
      if (currentOpps.autofill)    dotCount++;
      if (currentOpps.optimize)    dotCount++;
      if (currentOpps.resumeUpload) dotCount++;
    }
    dotCount = Math.max(dotCount, 1);

    var dotsHtml = "";
    for (var i = 0; i < dotCount; i++) {
      dotsHtml += '<div class="jaf-tab-dot"></div>';
    }

    tab.innerHTML =
      '<span class="jaf-tab-symbol">✦</span>' +
      '<span class="jaf-tab-label">Autofill</span>' +
      '<div class="jaf-tab-dots">' + dotsHtml + '</div>';

    tab.addEventListener("click", function () {
      removeTab(true);
      if (currentOpps) {
        JA.showOpportunityWidget(currentOpps);
      }
    });

    document.body.appendChild(tab);
  }

  function removeTab(animate) {
    var tab = document.getElementById(TAB_ID);
    if (!tab) return;
    if (animate) {
      tab.classList.add("jaf-tab-hiding");
      tab.addEventListener("animationend", function () { tab.remove(); }, { once: true });
    } else {
      tab.remove();
    }
  }

  // ---- Public: show widget --------------------------------------------------

  JA.showOpportunityWidget = function (opportunities) {
    if (isDismissed()) return;
    if (!opportunities) return;

    var hasAny = opportunities.autofill || opportunities.optimize || opportunities.resumeUpload;
    if (!hasAny) return;

    currentOpps = opportunities;     // save for tab restore

    removeWidget(false);
    removeTab(false);
    injectStyles();

    var widget = document.createElement("div");
    widget.id = WIDGET_ID;

    // Header
    var header = document.createElement("div");
    header.className = "jaf-w-header";
    header.innerHTML =
      '<span class="jaf-w-title">✦ Job Autofill</span>' +
      '<button class="jaf-w-close" title="Dismiss">✕</button>';
    widget.appendChild(header);

    header.querySelector(".jaf-w-close").addEventListener("click", function () {
      setDismissed();
      removeWidget(true);
      removeTab(false);
    });

    // Body rows
    var body = document.createElement("div");
    body.className = "jaf-w-body";

    if (opportunities.autofill) {
      var row1 = document.createElement("div");
      row1.className = "jaf-w-row";
      row1.innerHTML =
        '<span class="jaf-w-emoji">📝</span>' +
        '<span class="jaf-w-label">' + (opportunities.fieldCount || "Form") + ' fields found</span>' +
        '<button class="jaf-w-btn jaf-w-btn-fill">Autofill</button>';
      row1.querySelector(".jaf-w-btn").addEventListener("click", function () {
        if (JA.openSidebar) { JA.openSidebar(); }
        else { safeSendMessage({ action: "startAutofill", mode: "fill" }); }
        collapseToTab();
      });
      body.appendChild(row1);
    }

    if (opportunities.optimize) {
      var row2 = document.createElement("div");
      row2.className = "jaf-w-row";
      row2.innerHTML =
        '<span class="jaf-w-emoji">✨</span>' +
        '<span class="jaf-w-label">Optimize your resume</span>' +
        '<button class="jaf-w-btn jaf-w-btn-optimize">Optimize</button>';
      row2.querySelector(".jaf-w-btn").addEventListener("click", function () {
        if (JA.openSidebar) { JA.openSidebar(); }
        else { safeSendMessage({ action: "requestOptimize" }); }
        collapseToTab();
      });
      body.appendChild(row2);
    }

    if (opportunities.resumeUpload) {
      var row3 = document.createElement("div");
      row3.className = "jaf-w-row";
      row3.innerHTML =
        '<span class="jaf-w-emoji">📎</span>' +
        '<span class="jaf-w-label">Resume upload detected</span>' +
        '<button class="jaf-w-btn jaf-w-btn-attach">Attach</button>';
      row3.querySelector(".jaf-w-btn").addEventListener("click", function () {
        attachResumeToFileInput();
        collapseToTab();
      });
      body.appendChild(row3);
    }

    widget.appendChild(body);
    document.body.appendChild(widget);

    // Pause auto-collapse on hover; resume on leave
    widget.addEventListener("mouseenter", clearHideTimer);
    widget.addEventListener("mouseleave", function () {
      hideTimer = setTimeout(collapseToTab, AUTO_HIDE_MS);
    });

    // Start the auto-collapse countdown
    hideTimer = setTimeout(collapseToTab, AUTO_HIDE_MS);
  };

  JA.removeOpportunityWidget = function () {
    removeWidget(true);
    removeTab(false);
  };

  // ---- Attach resume to file input ------------------------------------------

  function attachResumeToFileInput() {
    safeSendMessage({ action: "getBaseResumePdf" }, function (resp) {
      if (!resp || !resp.ok || !resp.pdf || !resp.pdf.dataBase64) {
        JA.log("WARN", "No base resume PDF configured for auto-attach.");
        return;
      }
      try {
        if (!JA.attachFileToPage) throw new Error("Upload helper unavailable");
        JA.attachFileToPage(resp.pdf, "resume");
        JA.log("INFO", "Resume auto-attached to file input.");
      } catch (e) {
        JA.log("ERROR", "Failed to auto-attach resume: " + e);
      }
    });
  }
})();

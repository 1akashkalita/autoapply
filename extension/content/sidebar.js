/**
 * Injected sidebar panel for the Job Autofill extension.
 * Replaces the separate popup tab with a fixed right-side panel
 * that lives inside every page and can be toggled via the extension icon.
 */

window.JobAutofill = window.JobAutofill || {};

(function () {
  var JA = window.JobAutofill;

  var HOST_ID = "jaf-sidebar-host";
  var TAB_ID  = "jaf-sidebar-tab";

  var injected = false;
  var visible  = false;
  var host     = null;
  var root     = null;
  var hideVisTimer = null;

  var currentMappings     = null;
  var currentJobKey       = null;
  var currentJobMeta      = null;
  var lastAiResult        = null;
  var cachedJdAnalysis    = null;
  var cachedJdText        = null;
  var lastCoverLetterText = null;
  var currentSettings     = null;
  var currentActiveResume = null;

  var $ = {};

  // ======== CSS (shadow-DOM scoped, based on popup.css) ========

  var CSS = "\
:host {\
  all: initial !important;\
  display: block !important;\
  position: fixed !important;\
  top: 0 !important;\
  right: 0 !important;\
  bottom: 0 !important;\
  width: 420px !important;\
  z-index: 2147483646 !important;\
  transform: translateX(100%) !important;\
  transition: transform 0.3s cubic-bezier(.4,0,.2,1) !important;\
  pointer-events: none !important;\
}\
:host(.jaf-visible) {\
  transform: translateX(0) !important;\
  pointer-events: auto !important;\
}\
* { margin: 0; padding: 0; box-sizing: border-box; }\
.container {\
  width: 100%; height: 100vh; overflow-y: auto; overflow-x: hidden;\
  padding: 18px 20px 24px;\
  font-family: -apple-system, BlinkMacSystemFont, 'Segoe UI', Roboto, sans-serif;\
  font-size: 13px; color: #334155; background: #f8f9ff; line-height: 1.6;\
  box-shadow: -4px 0 24px rgba(99,102,241,0.15);\
}\
.header { display: flex; align-items: center; justify-content: space-between; margin-bottom: 14px; gap: 8px; }\
.header-left { display: flex; align-items: center; gap: 10px; }\
.title {\
  font-size: 16px; font-weight: 700;\
  background: linear-gradient(135deg, #6366f1, #818cf8);\
  -webkit-background-clip: text; -webkit-text-fill-color: transparent;\
  background-clip: text; white-space: nowrap;\
}\
.badge { font-size: 11px; font-weight: 600; padding: 3px 10px; border-radius: 20px; letter-spacing: 0.2px; white-space: nowrap; }\
.badge-neutral { background: #f1f5f9; color: #64748b; }\
.badge-success { background: #ecfdf5; color: #059669; }\
.badge-warning { background: #fffbeb; color: #d97706; }\
.badge-error   { background: #fef2f2; color: #ef4444; }\
.badge-active  { background: #eef2ff; color: #6366f1; }\
.btn-collapse {\
  background: none; border: 1px solid #e2e8f0; border-radius: 10px;\
  color: #94a3b8; font-size: 12px; font-weight: 500; cursor: pointer;\
  padding: 4px 10px; white-space: nowrap; transition: all 0.15s; flex-shrink: 0;\
}\
.btn-collapse:hover { background: #eef2ff; border-color: #c7d2fe; color: #6366f1; }\
.card {\
  background: #fff; border-radius: 14px; padding: 14px 16px;\
  margin-bottom: 12px; box-shadow: 0 2px 12px rgba(99,102,241,0.07);\
}\
.profile-summary { display: flex; align-items: center; gap: 12px; }\
.profile-avatar {\
  width: 38px; height: 38px; border-radius: 50%;\
  background: linear-gradient(135deg, #6366f1, #a5b4fc);\
  color: #fff; display: flex; align-items: center; justify-content: center;\
  font-weight: 700; font-size: 15px; flex-shrink: 0;\
}\
.profile-info .name { font-weight: 600; font-size: 14px; color: #1e293b; }\
.profile-info .detail { font-size: 12px; color: #94a3b8; }\
.placeholder-text { color: #94a3b8; font-style: italic; font-size: 12px; }\
.link-sm { font-size: 12px; color: #6366f1; text-decoration: none; cursor: pointer; display: inline-block; margin-top: 6px; }\
.link-sm:hover { text-decoration: underline; }\
.section { margin-bottom: 12px; }\
.section-header { display: flex; justify-content: space-between; align-items: center; margin-bottom: 8px; }\
.section-title { font-size: 13px; font-weight: 600; color: #475569; }\
.hidden { display: none !important; }\
.actions { display: grid; grid-template-columns: 1fr 1fr; gap: 8px; margin-bottom: 14px; }\
.actions-row2 { display: grid; grid-template-columns: 1fr 1fr; gap: 8px; margin-top: -6px; margin-bottom: 14px; }\
.btn {\
  display: flex; align-items: center; justify-content: center; gap: 6px;\
  padding: 10px 12px; border: none; border-radius: 12px;\
  font-size: 13px; font-weight: 600; cursor: pointer; transition: all 0.2s ease;\
}\
.btn:disabled { opacity: 0.4; cursor: not-allowed; }\
.btn-primary { background: linear-gradient(135deg, #6366f1, #818cf8); color: #fff; box-shadow: 0 2px 8px rgba(99,102,241,0.25); }\
.btn-primary:hover:not(:disabled) { box-shadow: 0 4px 14px rgba(99,102,241,0.35); transform: translateY(-1px); }\
.btn-secondary { background: rgba(255,255,255,0.8); color: #475569; border: 1px solid #e2e8f0; backdrop-filter: blur(8px); }\
.btn-secondary:hover:not(:disabled) { background: #f1f5f9; }\
.btn-ai { background: linear-gradient(135deg, #8b5cf6, #a78bfa); color: #fff; box-shadow: 0 2px 8px rgba(139,92,246,0.25); }\
.btn-ai:hover:not(:disabled) { box-shadow: 0 4px 14px rgba(139,92,246,0.35); transform: translateY(-1px); }\
.btn-cover { background: linear-gradient(135deg, #0891b2, #22d3ee); color: #fff; box-shadow: 0 2px 8px rgba(8,145,178,0.25); }\
.btn-cover:hover:not(:disabled) { box-shadow: 0 4px 14px rgba(8,145,178,0.35); transform: translateY(-1px); }\
.btn-full { width: 100%; margin-top: 10px; }\
.btn-text { background: none; border: none; color: #6366f1; font-size: 12px; cursor: pointer; padding: 3px 8px; border-radius: 8px; font-weight: 500; transition: background 0.15s; }\
.btn-text:hover { background: #eef2ff; }\
.stats { display: flex; flex-wrap: wrap; gap: 10px; margin-bottom: 8px; }\
.stat { display: flex; align-items: center; gap: 5px; font-size: 12px; font-weight: 500; color: #64748b; }\
.result-list { max-height: 300px; overflow-y: auto; background: #fff; border-radius: 12px; box-shadow: 0 1px 6px rgba(99,102,241,0.06); }\
.result-item { display: flex; justify-content: space-between; align-items: center; padding: 8px 12px; border-bottom: 1px solid #f1f5f9; font-size: 12px; gap: 8px; }\
.result-item:last-child { border-bottom: none; }\
.result-field { font-weight: 500; color: #334155; min-width: 0; flex: 1; overflow: hidden; text-overflow: ellipsis; white-space: nowrap; }\
.result-value { color: #059669; max-width: 180px; overflow: hidden; text-overflow: ellipsis; white-space: nowrap; text-align: right; flex-shrink: 0; }\
.result-value.skipped { color: #d97706; font-style: italic; }\
.badge-llm { display: inline-block; font-size: 10px; font-weight: 600; background: #f5f3ff; color: #7c3aed; padding: 1px 6px; border-radius: 8px; margin-left: 4px; vertical-align: middle; flex-shrink: 0; }\
.skill-tags { display: flex; flex-wrap: wrap; gap: 5px; flex: 1; }\
.skill-tag { display: inline-block; font-size: 11px; font-weight: 500; padding: 2px 8px; border-radius: 10px; white-space: nowrap; }\
.skill-tag-green { background: #dcfce7; color: #15803d; border: 1px solid #bbf7d0; }\
.skill-tag-red { background: #fee2e2; color: #dc2626; border: 1px solid #fecaca; }\
.skill-tag-yellow { background: #fef9c3; color: #a16207; border: 1px solid #fef08a; }\
.docs-toggle { display: flex; align-items: center; justify-content: space-between; cursor: pointer; padding: 10px 0 6px; user-select: none; }\
.docs-toggle-arrow { font-size: 11px; color: #94a3b8; transition: transform 0.2s; }\
.docs-toggle-arrow.open { transform: rotate(90deg); }\
.docs-body { overflow: hidden; max-height: 0; transition: max-height 0.3s ease; }\
.docs-body.open { max-height: 700px; }\
.docs-actions { display: flex; gap: 10px; margin-top: 8px; margin-bottom: 10px; }\
.docs-action { flex: 1; display: flex; flex-direction: column; gap: 4px; }\
.docs-action input[type='file'] { width: 100%; font-size: 11px; color: #64748b; }\
.docs-compose textarea {\
  width: 100%; resize: vertical; min-height: 60px; padding: 10px 12px;\
  border: 1px solid #e2e8f0; border-radius: 12px; background: #fff;\
  font-family: inherit; font-size: 12px; color: #334155; transition: border-color 0.15s;\
}\
.docs-compose textarea:focus { outline: none; border-color: #6366f1; box-shadow: 0 0 0 3px rgba(99,102,241,0.1); }\
.warning-banner { background: #fffbeb; border-left: 3px solid #f59e0b; border-radius: 10px; padding: 8px 12px; margin-bottom: 8px; font-size: 12px; color: #92400e; }\
.info-banner { background: #eff6ff; border-left: 3px solid #3b82f6; border-radius: 10px; padding: 8px 12px; margin-bottom: 8px; font-size: 12px; color: #1e40af; }\
.ai-status { padding: 10px 14px; border-radius: 12px; font-size: 12px; margin-bottom: 10px; display: flex; align-items: center; gap: 8px; }\
.ai-status-loading { background: #f5f3ff; color: #7c3aed; }\
.ai-status-success { background: #ecfdf5; color: #059669; }\
.ai-status-error   { background: #fef2f2; color: #ef4444; }\
.ai-spinner { display: inline-block; width: 14px; height: 14px; border: 2px solid #c4b5fd; border-top-color: #8b5cf6; border-radius: 50%; animation: spin 0.6s linear infinite; flex-shrink: 0; }\
.ai-spinner-cover { border-color: #a5f3fc; border-top-color: #0891b2; }\
@keyframes spin { to { transform: rotate(360deg); } }\
.subsection-title { font-size: 12px; font-weight: 600; color: #475569; margin-bottom: 6px; margin-top: 6px; }\
.ai-preview-card { background: #fff; border-radius: 12px; box-shadow: 0 1px 6px rgba(99,102,241,0.06); margin-bottom: 10px; overflow: hidden; }\
.ai-preview-row { display: flex; align-items: flex-start; gap: 8px; padding: 10px 12px; border-bottom: 1px solid #f1f5f9; font-size: 12px; line-height: 1.5; }\
.ai-preview-row:last-child { border-bottom: none; }\
.ai-preview-emoji { flex-shrink: 0; font-size: 14px; line-height: 1.6; }\
.ai-preview-label { font-weight: 600; color: #475569; min-width: 72px; flex-shrink: 0; padding-top: 2px; }\
.ai-preview-items { color: #64748b; flex: 1; }\
.ai-preview-actions { display: flex; gap: 8px; margin-top: 10px; }\
.optimize-summary { background: #f5f3ff; border-radius: 10px; padding: 8px 12px; font-size: 12px; color: #5b21b6; font-weight: 500; margin-bottom: 10px; display: flex; flex-wrap: wrap; gap: 6px; align-items: center; }\
.optimize-summary-item { display: flex; align-items: center; gap: 3px; }\
.optimize-summary-sep { color: #c4b5fd; font-weight: 300; }\
.gap-list { background: #fff; border-radius: 12px; box-shadow: 0 1px 6px rgba(99,102,241,0.06); max-height: 300px; overflow-y: auto; margin-bottom: 10px; }\
.gap-row { display: flex; align-items: flex-start; gap: 8px; padding: 9px 12px; border-bottom: 1px solid #f1f5f9; font-size: 12px; }\
.gap-row:last-child { border-bottom: none; }\
.gap-status-badge { font-size: 10px; font-weight: 700; padding: 2px 8px; border-radius: 10px; text-transform: uppercase; letter-spacing: 0.3px; flex-shrink: 0; margin-top: 1px; }\
.gap-met .gap-status-badge       { background: #ecfdf5; color: #059669; }\
.gap-partial .gap-status-badge   { background: #fffbeb; color: #d97706; }\
.gap-missing .gap-status-badge   { background: #fef2f2; color: #ef4444; }\
.gap-generated .gap-status-badge { background: #f5f3ff; color: #7c3aed; }\
.gap-text { color: #334155; flex: 1; }\
.gap-notes { display: block; font-size: 11px; color: #94a3b8; font-style: italic; margin-top: 2px; }\
.diff-list { background: #fff; border-radius: 12px; box-shadow: 0 1px 6px rgba(99,102,241,0.06); max-height: 320px; overflow-y: auto; margin-bottom: 10px; font-size: 12px; }\
.diff-header { font-weight: 600; color: #334155; padding: 9px 12px 4px; border-bottom: 1px solid #f1f5f9; display: flex; align-items: center; gap: 6px; }\
.diff-section-label { font-size: 10px; font-weight: 500; color: #94a3b8; text-transform: uppercase; letter-spacing: 0.3px; }\
.diff-generated-header { color: #7c3aed; }\
.diff-generated-badge { font-size: 10px; font-weight: 600; background: #f5f3ff; color: #7c3aed; padding: 2px 8px; border-radius: 10px; margin-left: auto; }\
.diff-line { padding: 4px 12px 4px 20px; font-size: 11px; line-height: 1.5; word-break: break-word; }\
.diff-removed { background: #fef2f2; color: #dc2626; }\
.diff-added   { background: #ecfdf5; color: #059669; }\
.cover-letter-output { background: #fff; border-radius: 12px; box-shadow: 0 1px 6px rgba(8,145,178,0.08); padding: 12px 14px; margin-bottom: 10px; }\
.cover-letter-actions { display: flex; gap: 8px; margin-top: 8px; }\
#aiCoverLetter, #standaloneCoverLetter {\
  width: 100%; resize: vertical; min-height: 140px; padding: 10px 12px;\
  border: 1px solid #e2e8f0; border-radius: 12px; background: #fff;\
  font-family: inherit; font-size: 12px; line-height: 1.6; color: #334155;\
}\
#aiCoverLetter:focus, #standaloneCoverLetter:focus { outline: none; border-color: #0891b2; box-shadow: 0 0 0 3px rgba(8,145,178,0.1); }\
.footer { display: flex; justify-content: space-between; padding-top: 10px; }\
.text-muted { font-size: 11px; color: #94a3b8; }\
";

  // ======== HTML (same structure as popup.html) ========

  var HTML = '\
<div class="container" id="mainContainer">\
  <header class="header">\
    <div class="header-left">\
      <h1 class="title">\u2726 Job Autofill</h1>\
      <span id="statusBadge" class="badge badge-neutral">Ready</span>\
    </div>\
    <button type="button" id="btnCollapse" class="btn-collapse" title="Hide panel">\u27F5 Hide</button>\
  </header>\
  <section id="profileSection" class="card">\
    <div class="profile-summary" id="profileSummary">\
      <p class="placeholder-text">No profile configured.</p>\
    </div>\
    <a href="#" id="openOptions" class="link-sm">Edit profile &amp; settings</a>\
  </section>\
  <section class="actions">\
    <button id="btnPreview" class="btn btn-secondary" disabled>\ud83d\udd0d Preview</button>\
    <button id="btnFill" class="btn btn-primary" disabled>\u270f\ufe0f Fill Form</button>\
  </section>\
  <section class="actions-row2">\
    <button id="btnAiOptimize" class="btn btn-ai" disabled title="Enable LLM in Options to use AI Optimize">\u2728 Optimize Resume</button>\
    <button id="btnCoverLetter" class="btn btn-cover" disabled title="Enable LLM in Options to generate a cover letter">\u2709\ufe0f Cover Letter</button>\
  </section>\
  <section id="docsSection" class="section">\
    <div class="docs-toggle" id="docsToggle">\
      <h2 class="section-title">\ud83d\udcc4 Documents</h2>\
      <span class="docs-toggle-arrow" id="docsArrow">\u25b6</span>\
    </div>\
    <div id="jobContextLine" class="text-muted" style="margin-bottom:4px;"></div>\
    <div class="docs-body" id="docsBody">\
      <div class="docs-actions">\
        <div class="docs-action">\
          <label class="link-sm" for="uploadEditedResume">Add resume (PDF)</label>\
          <input id="uploadEditedResume" type="file" accept="application/pdf">\
        </div>\
        <div class="docs-action">\
          <label class="link-sm" for="uploadCoverLetterFile">Add cover letter (PDF)</label>\
          <input id="uploadCoverLetterFile" type="file" accept="application/pdf">\
        </div>\
      </div>\
      <div class="docs-compose">\
        <textarea id="coverLetterText" rows="4" placeholder="Paste cover letter text..."></textarea>\
        <button id="btnSaveCoverLetterText" class="btn btn-secondary btn-full">Save cover letter</button>\
      </div>\
      <div id="docsStatus" class="text-muted" style="margin-top:8px;"></div>\
      <div id="docsList" class="result-list" style="margin-top:8px;"></div>\
    </div>\
  </section>\
  <section id="previewSection" class="section hidden">\
    <div class="section-header">\
      <h2 class="section-title">\ud83d\udcdd Preview</h2>\
      <button id="btnClearPreview" class="btn-text">Clear</button>\
    </div>\
    <div id="previewStats" class="stats"></div>\
    <div id="previewList" class="result-list"></div>\
    <button id="btnConfirmFill" class="btn btn-primary btn-full">Confirm &amp; Fill</button>\
  </section>\
  <section id="resultsSection" class="section hidden">\
    <h2 class="section-title">\u2705 Results</h2>\
    <div id="resultStats" class="stats"></div>\
    <div id="resultList" class="result-list"></div>\
  </section>\
  <section id="aiPreviewSection" class="section hidden">\
    <div class="section-header">\
      <h2 class="section-title">\ud83d\udd0d Resume Analysis</h2>\
      <button id="btnCancelAiPreview" class="btn-text">Cancel</button>\
    </div>\
    <div id="aiPreviewStatus" class="ai-status"></div>\
    <div id="aiPreviewContent" class="ai-preview-card"></div>\
    <div class="ai-preview-actions">\
      <button id="btnConfirmOptimize" class="btn btn-ai btn-full" disabled>\u2728 Confirm &amp; Optimize</button>\
    </div>\
  </section>\
  <section id="aiSection" class="section hidden">\
    <div class="section-header">\
      <h2 class="section-title">\u2728 AI Optimize</h2>\
    </div>\
    <div id="aiStatus" class="ai-status"></div>\
    <div id="aiOptimizeSummary" class="optimize-summary hidden"></div>\
    <div id="aiGapSection" class="hidden">\
      <h3 class="subsection-title">Requirements Gap</h3>\
      <div id="aiGapList" class="gap-list"></div>\
    </div>\
    <div id="aiDiffSection" class="hidden">\
      <h3 class="subsection-title">Resume Changes</h3>\
      <div id="aiResumeDiff" class="diff-list"></div>\
    </div>\
    <div id="aiCoverLetterSection" class="hidden">\
      <h3 class="subsection-title">Cover Letter</h3>\
      <textarea id="aiCoverLetter" rows="8" readonly></textarea>\
    </div>\
  </section>\
  <section id="coverLetterSection" class="section hidden">\
    <div class="section-header">\
      <h2 class="section-title">\u2709\ufe0f Cover Letter</h2>\
      <button id="btnCancelCoverLetter" class="btn-text">Cancel</button>\
    </div>\
    <div id="coverLetterStatus" class="ai-status"></div>\
    <div id="coverLetterOutput" class="cover-letter-output hidden">\
      <textarea id="standaloneCoverLetter" rows="10"></textarea>\
      <div class="cover-letter-actions">\
        <button id="btnDownloadCoverLetter" class="btn btn-cover btn-full">\u2193 Download Cover Letter</button>\
      </div>\
    </div>\
  </section>\
  <footer class="footer">\
    <span id="adapterName" class="text-muted"></span>\
    <span id="llmStatus" class="text-muted"></span>\
  </footer>\
</div>';

  // ======== Utilities ========

  function sendBg(msg) {
    return new Promise(function (resolve) {
      if (!chrome.runtime || !chrome.runtime.id) { resolve({ ok: false, error: "Extension context lost" }); return; }
      try {
        chrome.runtime.sendMessage(msg, function (resp) {
          if (chrome.runtime.lastError) { resolve({ ok: false, error: chrome.runtime.lastError.message }); return; }
          resolve(resp || { ok: false, error: "No response" });
        });
      } catch (e) {
        resolve({ ok: false, error: String(e) });
      }
    });
  }

  function escHtml(str) {
    var div = document.createElement("div");
    div.textContent = str;
    return div.innerHTML;
  }

  function truncate(str, len) {
    if (!str) return "";
    return str.length > len ? str.substring(0, len - 3) + "\u2026" : str;
  }

  function genId() {
    return (window.crypto && window.crypto.randomUUID)
      ? window.crypto.randomUUID()
      : ("doc_" + Date.now() + "_" + Math.random().toString(36).slice(2, 8));
  }

  function safeFilePart(s) {
    return String(s || "").trim().replace(/[\/\\?%*:|"<>]/g, "").replace(/\s+/g, "-").slice(0, 40);
  }

  function isoDatePart(iso) {
    if (!iso) return "";
    var d = new Date(iso);
    if (isNaN(d.getTime())) return "";
    return "" + d.getFullYear() + String(d.getMonth() + 1).padStart(2, "0") + String(d.getDate()).padStart(2, "0");
  }

  function inferExt(name, mime) {
    var n = String(name || "").toLowerCase();
    if (n.endsWith(".pdf"))  return "pdf";
    if (n.endsWith(".txt"))  return "txt";
    if (n.endsWith(".html")) return "html";
    if (mime === "application/pdf") return "pdf";
    if (mime === "text/plain")      return "txt";
    if (mime === "text/html")       return "html";
    return "bin";
  }

  function readFileAsBase64(file) {
    return new Promise(function (resolve, reject) {
      var reader = new FileReader();
      reader.onerror = function () { reject(new Error("Failed to read file")); };
      reader.onload  = function () { resolve(arrayBufferToBase64(reader.result)); };
      reader.readAsArrayBuffer(file);
    });
  }

  function arrayBufferToBase64(ab) {
    var bytes = new Uint8Array(ab);
    var binary = "";
    var chunk = 0x8000;
    for (var i = 0; i < bytes.length; i += chunk) {
      binary += String.fromCharCode.apply(null, bytes.subarray(i, i + chunk));
    }
    return btoa(binary);
  }

  function base64FromUtf8(text) {
    return btoa(unescape(encodeURIComponent(String(text || ""))));
  }

  function downloadBase64(base64, filename, mime) {
    var byteChars = atob(base64);
    var byteNumbers = new Array(byteChars.length);
    for (var i = 0; i < byteChars.length; i++) byteNumbers[i] = byteChars.charCodeAt(i);
    var bytes = new Uint8Array(byteNumbers);
    var blob = new Blob([bytes], { type: mime || "application/octet-stream" });
    var url = URL.createObjectURL(blob);
    var a = document.createElement("a");
    a.href = url;
    a.download = filename || "download";
    a.style.display = "none";
    document.body.appendChild(a);
    a.click();
    document.body.removeChild(a);
    setTimeout(function () { URL.revokeObjectURL(url); }, 2000);
  }

  function downloadHtmlAsFile(htmlString, filename) {
    var blob = new Blob([htmlString], { type: "text/html" });
    var url = URL.createObjectURL(blob);
    var a = document.createElement("a");
    a.href = url;
    a.download = filename;
    a.style.display = "none";
    document.body.appendChild(a);
    a.click();
    document.body.removeChild(a);
    setTimeout(function () { URL.revokeObjectURL(url); }, 2000);
  }

  function buildAiFilename(kind, ext) {
    var company = safeFilePart(currentJobMeta && currentJobMeta.company);
    var title   = safeFilePart(currentJobMeta && currentJobMeta.title);
    var date    = isoDatePart(new Date().toISOString());
    var parts   = [company, title, date, kind].filter(Boolean);
    var base    = parts.length > 1 ? parts.join("-") : (date + "-" + kind);
    return base + "." + ext;
  }

  function buildJobFilename(jobMeta, docType, doc) {
    var company = safeFilePart(jobMeta && jobMeta.company);
    var title   = safeFilePart(jobMeta && jobMeta.title);
    var date    = isoDatePart(doc && doc.createdAt);
    var kind    = docType === "editedResume" ? "edited-resume" : "cover-letter";
    var ext     = inferExt(doc && doc.name, doc && doc.mime);
    var parts   = [company, title, date, kind].filter(Boolean);
    var base    = parts.length ? parts.join("-") : ("job-" + (date || "document") + "-" + kind);
    return base + "." + ext;
  }

  function getJobContext() {
    try {
      var meta = JA.extractJobMeta ? JA.extractJobMeta() : null;
      if (!meta) return { ok: false };
      return { ok: true, jobMeta: meta, jobKey: JA.buildJobKey ? JA.buildJobKey(meta) : "" };
    } catch (e) {
      return { ok: false, error: String(e) };
    }
  }

  function extractJd() {
    try {
      var result = JA._extractJobDescription ? JA._extractJobDescription() : null;
      if (!result) return { ok: false, wordCount: 0 };
      return { ok: true, jdText: result.jdText, wordCount: result.wordCount, extractionMethod: result.extractionMethod };
    } catch (e) {
      return { ok: false, error: String(e), wordCount: 0 };
    }
  }

  // ======== Sidebar DOM injection ========

  function injectSidebar() {
    if (injected) return;
    injected = true;

    host = document.createElement("div");
    host.id = HOST_ID;
    document.body.appendChild(host);

    root = host.attachShadow({ mode: "open" });
    root.innerHTML = "<style>" + CSS + "</style>" + HTML;

    cacheRefs();
    bindEvents();
  }

  function cacheRefs() {
    $.mainContainer         = root.getElementById("mainContainer");
    $.statusBadge           = root.getElementById("statusBadge");
    $.btnCollapse           = root.getElementById("btnCollapse");
    $.profileSummary        = root.getElementById("profileSummary");
    $.openOptions           = root.getElementById("openOptions");
    $.btnPreview            = root.getElementById("btnPreview");
    $.btnFill               = root.getElementById("btnFill");
    $.btnAiOptimize         = root.getElementById("btnAiOptimize");
    $.btnCoverLetter        = root.getElementById("btnCoverLetter");
    $.previewSection        = root.getElementById("previewSection");
    $.previewStats          = root.getElementById("previewStats");
    $.previewList           = root.getElementById("previewList");
    $.btnClearPreview       = root.getElementById("btnClearPreview");
    $.btnConfirmFill        = root.getElementById("btnConfirmFill");
    $.resultsSection        = root.getElementById("resultsSection");
    $.resultStats           = root.getElementById("resultStats");
    $.resultList            = root.getElementById("resultList");
    $.adapterName           = root.getElementById("adapterName");
    $.llmStatus             = root.getElementById("llmStatus");
    $.docsToggle            = root.getElementById("docsToggle");
    $.docsArrow             = root.getElementById("docsArrow");
    $.docsBody              = root.getElementById("docsBody");
    $.jobContextLine        = root.getElementById("jobContextLine");
    $.docsStatus            = root.getElementById("docsStatus");
    $.docsList              = root.getElementById("docsList");
    $.uploadEditedResume    = root.getElementById("uploadEditedResume");
    $.uploadCoverLetterFile = root.getElementById("uploadCoverLetterFile");
    $.coverLetterText       = root.getElementById("coverLetterText");
    $.btnSaveCoverLetterText = root.getElementById("btnSaveCoverLetterText");
    $.aiPreviewSection      = root.getElementById("aiPreviewSection");
    $.aiPreviewStatus       = root.getElementById("aiPreviewStatus");
    $.aiPreviewContent      = root.getElementById("aiPreviewContent");
    $.btnConfirmOptimize    = root.getElementById("btnConfirmOptimize");
    $.btnCancelAiPreview    = root.getElementById("btnCancelAiPreview");
    $.aiSection             = root.getElementById("aiSection");
    $.aiStatus              = root.getElementById("aiStatus");
    $.aiOptimizeSummary     = root.getElementById("aiOptimizeSummary");
    $.aiGapSection          = root.getElementById("aiGapSection");
    $.aiGapList             = root.getElementById("aiGapList");
    $.aiDiffSection         = root.getElementById("aiDiffSection");
    $.aiResumeDiff          = root.getElementById("aiResumeDiff");
    $.aiCoverLetterSection  = root.getElementById("aiCoverLetterSection");
    $.aiCoverLetter         = root.getElementById("aiCoverLetter");
    $.coverLetterSection    = root.getElementById("coverLetterSection");
    $.coverLetterStatus     = root.getElementById("coverLetterStatus");
    $.coverLetterOutput     = root.getElementById("coverLetterOutput");
    $.standaloneCoverLetter = root.getElementById("standaloneCoverLetter");
    $.btnDownloadCoverLetter = root.getElementById("btnDownloadCoverLetter");
    $.btnCancelCoverLetter  = root.getElementById("btnCancelCoverLetter");
  }

  // ======== Show / Hide / Toggle ========

  function cancelHideVisibility() {
    if (hideVisTimer) {
      clearTimeout(hideVisTimer);
      hideVisTimer = null;
    }
    if (host) {
      host.removeEventListener("transitionend", onHostTransitionEnd);
    }
  }

  function finalizeHideVisibility() {
    cancelHideVisibility();
    if (host && !visible) {
      host.style.visibility = "hidden";
      host.setAttribute("aria-hidden", "true");
    }
  }

  function onHostTransitionEnd(e) {
    if (e.target !== host) return;
    if (e.propertyName !== "transform") return;
    finalizeHideVisibility();
  }

  function show() {
    injectSidebar();
    cancelHideVisibility();
    if (host) {
      host.style.visibility = "";
      host.removeAttribute("aria-hidden");
    }
    if (visible) return;
    visible = true;
    host.classList.add("jaf-visible");
    removeSidebarTab();
    if (JA.removeOpportunityWidget) JA.removeOpportunityWidget();
    refreshSidebar();
  }

  function hide() {
    if (!visible) return;
    visible = false;
    if (host) {
      cancelHideVisibility();
      host.addEventListener("transitionend", onHostTransitionEnd);
      host.classList.remove("jaf-visible");
      hideVisTimer = setTimeout(finalizeHideVisibility, 400);
    }
    showSidebarTab();
  }

  function toggle() {
    if (visible) hide();
    else show();
  }

  // ======== Refresh sidebar state ========

  async function refreshSidebar() {
    var settings = await sendBg({ action: "getSettings" });
    currentSettings = settings.ok ? settings : null;

    if (settings.ok && settings.profile) {
      renderProfile(settings.profile);
      $.btnPreview.disabled = false;
      $.btnFill.disabled = false;
    } else {
      $.profileSummary.innerHTML =
        '<p class="placeholder-text">No profile configured. <a href="#" id="setupLink">Set up now</a></p>';
      var setupLink = root.getElementById("setupLink");
      if (setupLink) {
        setupLink.addEventListener("click", function (e) {
          e.preventDefault();
          sendBg({ action: "openOptionsPage" });
        });
      }
      $.btnPreview.disabled = true;
      $.btnFill.disabled = true;
    }

    await refreshActiveResumeContext();
    updateAiAvailability();

    await refreshJobContextAndDocs();
  }

  function updateAiAvailability() {
    if (!currentSettings) return;
    var llmReady = currentSettings.llmEnabled && currentSettings.apiKey;
    var hasResumeForAi = !!(currentSettings.resumeAvailableForAi ||
      (currentActiveResume && currentActiveResume.sourceType !== "profileOnly"));
    $.llmStatus.textContent = llmReady ? "LLM: On" : "LLM: Off";
    $.btnAiOptimize.disabled = !(llmReady && hasResumeForAi);
    $.btnCoverLetter.disabled = !(llmReady && hasResumeForAi);
    if (llmReady && hasResumeForAi) {
      $.btnAiOptimize.title = "Optimize resume & generate cover letter for this job";
      $.btnCoverLetter.title = "Generate a cover letter for this job";
    } else if (llmReady) {
      $.btnAiOptimize.title = "Add a resume PDF or resume JSON to use AI features";
      $.btnCoverLetter.title = "Add a resume PDF or resume JSON to generate a cover letter";
    }
  }

  async function refreshActiveResumeContext() {
    var resp = await sendBg({ action: "getActiveResumeContext", jobKey: currentJobKey || "" });
    currentActiveResume = resp.ok ? resp.activeResume : null;
    return currentActiveResume;
  }

  async function getCurrentPersonalInfo() {
    var active = await refreshActiveResumeContext();
    if (active && active.personal) return active.personal;
    if (currentSettings && currentSettings.resume && currentSettings.resume.personal) return currentSettings.resume.personal;
    return {};
  }

  // ======== Event binding ========

  function bindEvents() {
    $.btnCollapse.addEventListener("click", function (e) {
      e.preventDefault();
      e.stopPropagation();
      hide();
    });

    $.openOptions.addEventListener("click", function (e) {
      e.preventDefault();
      sendBg({ action: "openOptionsPage" });
    });

    $.docsToggle.addEventListener("click", function () {
      var isOpen = $.docsBody.classList.toggle("open");
      $.docsArrow.classList.toggle("open", isOpen);
    });

    // ---- Preview ----
    $.btnPreview.addEventListener("click", async function () {
      setStatus("\ud83d\udd35 Scanning\u2026", "active");
      $.btnPreview.disabled = true;
      $.btnFill.disabled = true;

      var result = await sendBg({ action: "startAutofill", mode: "preview" });

      if (result.ok) {
        currentMappings = result.mappings;
        renderPreview(result);
        setStatus("\ud83d\udfe1 Preview", "active");
        if (result.adapterName) $.adapterName.textContent = "Adapter: " + result.adapterName;
        if (result.jobKey) {
          currentJobKey = result.jobKey;
          currentJobMeta = result.jobMeta || currentJobMeta;
          renderJobContextLine();
          await refreshDocsList();
        }
      } else {
        setStatus("Error", "error");
        showError(result.error);
      }

      $.btnPreview.disabled = false;
      $.btnFill.disabled = false;
    });

    // ---- Fill ----
    $.btnFill.addEventListener("click", async function () {
      setStatus("\ud83d\udd35 Filling\u2026", "active");
      $.btnFill.disabled = true;
      $.btnPreview.disabled = true;

      var result = await sendBg({ action: "startAutofill", mode: "fill" });

      if (result.ok) {
        renderResults(result);
        setStatus("\ud83d\udfe2 Filled", "success");
        if (result.jobKey) {
          currentJobKey = result.jobKey;
          currentJobMeta = result.jobMeta || currentJobMeta;
          renderJobContextLine();
          await refreshDocsList();
        }
      } else {
        setStatus("Error", "error");
        showError(result.error);
      }

      $.btnFill.disabled = false;
      $.btnPreview.disabled = false;
    });

    // ---- Clear preview ----
    $.btnClearPreview.addEventListener("click", function () {
      if (JA.clearPreview) JA.clearPreview();
      $.previewSection.classList.add("hidden");
      currentMappings = null;
      setStatus("Ready", "neutral");
    });

    // ---- Confirm fill ----
    $.btnConfirmFill.addEventListener("click", async function () {
      if (!currentMappings) return;
      setStatus("\ud83d\udd35 Filling\u2026", "active");
      $.btnConfirmFill.disabled = true;

      var result = await sendBg({ action: "confirmFill", mappings: currentMappings });

      if (result.ok) {
        $.previewSection.classList.add("hidden");
        renderResults(result);
        setStatus("\ud83d\udfe2 Filled", "success");
        currentMappings = null;
        if (result.jobKey) {
          currentJobKey = result.jobKey;
          currentJobMeta = result.jobMeta || currentJobMeta;
          renderJobContextLine();
          await refreshDocsList();
        }
      } else {
        setStatus("Error", "error");
        showError(result.error);
      }

      $.btnConfirmFill.disabled = false;
    });

    // ---- Document uploads ----
    $.uploadEditedResume.addEventListener("change", async function (e) {
      var file = e.target.files && e.target.files[0];
      $.uploadEditedResume.value = "";
      if (file) await saveDocFromFile("editedResume", file);
    });

    $.uploadCoverLetterFile.addEventListener("change", async function (e) {
      var file = e.target.files && e.target.files[0];
      $.uploadCoverLetterFile.value = "";
      if (file) await saveDocFromFile("coverLetter", file);
    });

    $.btnSaveCoverLetterText.addEventListener("click", async function () {
      var text = $.coverLetterText.value ? $.coverLetterText.value.trim() : "";
      if (!text) { setDocsStatus("Paste cover letter text first.", false); return; }
      if (!currentJobKey) { setDocsStatus("No job detected for this tab yet.", false); return; }
      var personal = await getCurrentPersonalInfo();
      var doc;
      var fitted;
      try {
        fitted = await renderCoverLetterDocWithOnePageLimit(text, personal, cachedJdAnalysis);
        doc = fitted.doc;
      } catch (err) {
        setDocsStatus("PDF export failed: " + String(err), false);
        return;
      }
      var resp = await sendBg({
        action: "saveJobDocument", jobKey: currentJobKey,
        jobMeta: currentJobMeta, docType: "coverLetter", doc: doc,
      });
      if (resp.ok) {
        $.coverLetterText.value = fitted && fitted.text ? fitted.text : "";
        setDocsStatus("Cover letter saved.", true);
        await refreshDocsList();
      } else {
        setDocsStatus(resp.error || "Save failed.", false);
      }
    });

    $.docsList.addEventListener("click", async function (e) {
      var btn = e.target && e.target.closest ? e.target.closest("button[data-action]") : null;
      if (!btn) return;
      var action  = btn.getAttribute("data-action");
      var docType = btn.getAttribute("data-doc-type");
      var id      = btn.getAttribute("data-id");
      if (!action || !docType || !id) return;

      if (action === "download") {
        await downloadJobDoc(docType, id);
      } else if (action === "delete") {
        var resp = await sendBg({ action: "deleteJobDocument", jobKey: currentJobKey, docType: docType, id: id });
        if (resp.ok) { setDocsStatus("Deleted.", true); await refreshDocsList(); }
        else { setDocsStatus(resp.error || "Delete failed.", false); }
      }
    });

    // ---- AI Optimize Phase 1 ----
    $.btnAiOptimize.addEventListener("click", async function () {
      setStatus("\ud83d\udd35 Analyzing\u2026", "active");
      $.btnAiOptimize.disabled = true;
      $.aiSection.classList.add("hidden");
      $.coverLetterSection.classList.add("hidden");
      $.aiPreviewSection.classList.remove("hidden");
      $.aiPreviewContent.innerHTML = "";
      $.btnConfirmOptimize.disabled = true;
      $.aiPreviewStatus.innerHTML = '<span class="ai-spinner"></span> Extracting job description\u2026';
      $.aiPreviewStatus.className = "ai-status ai-status-loading";

      var jdResult = extractJd();
      if (!jdResult.ok || jdResult.wordCount < 50) {
        showAiPreviewError("Could not extract a job description from this page (found " + (jdResult.wordCount || 0) + " words).");
        return;
      }

      cachedJdText = jdResult.jdText;

      if (!currentJobKey) {
        var ctx = getJobContext();
        if (ctx.ok) { currentJobKey = ctx.jobKey; currentJobMeta = ctx.jobMeta; renderJobContextLine(); }
      }

      $.aiPreviewStatus.innerHTML = '<span class="ai-spinner"></span> Analyzing requirements\u2026';

      var gapResult;
      try {
        gapResult = await sendBg({ action: "analyzeResumeGaps", jdText: cachedJdText, jobKey: currentJobKey, jobMeta: currentJobMeta });
      } catch (e) { showAiPreviewError("Analysis failed: " + String(e)); return; }

      if (!gapResult || !gapResult.ok) { showAiPreviewError(gapResult ? gapResult.error : "No response from background."); return; }

      cachedJdAnalysis = gapResult.jdAnalysis;
      renderAiPreview(gapResult);
      $.aiPreviewStatus.textContent = "Analysis complete \u2014 review before optimizing.";
      $.aiPreviewStatus.className = "ai-status ai-status-success";
      $.btnConfirmOptimize.disabled = false;
      setStatus("\ud83d\udd0d Review", "active");
      $.btnAiOptimize.disabled = false;
    });

    // ---- AI Optimize Phase 2 ----
    $.btnConfirmOptimize.addEventListener("click", async function () {
      if (!cachedJdAnalysis || !cachedJdText) return;
      setStatus("\ud83d\udd35 Optimizing\u2026", "active");
      $.btnConfirmOptimize.disabled = true;
      $.aiPreviewSection.classList.add("hidden");
      $.aiSection.classList.remove("hidden");
      $.aiOptimizeSummary.classList.add("hidden");
      $.aiGapSection.classList.add("hidden");
      $.aiDiffSection.classList.add("hidden");
      $.aiCoverLetterSection.classList.add("hidden");
      $.aiStatus.innerHTML = '<span class="ai-spinner"></span> Tailoring resume &amp; cover letter\u2026 (15\u201330s)';
      $.aiStatus.className = "ai-status ai-status-loading";

      var result;
      try {
        result = await sendBg({ action: "executeResumeOptimization", jdText: cachedJdText, jdAnalysis: cachedJdAnalysis, jobKey: currentJobKey, jobMeta: currentJobMeta });
      } catch (e) { showAiError("Optimization failed: " + String(e)); return; }

      if (!result || !result.ok) { showAiError(result ? result.error : "No response from background."); return; }

      lastAiResult = result;
      renderAiResults(result);
      try {
        await saveAndDownloadAiDocs(result);
      } catch (pdfErr) {
        $.aiStatus.textContent = "Optimization completed, but PDF export failed: " + String(pdfErr);
        $.aiStatus.className = "ai-status ai-status-error";
      }
      setStatus("\ud83d\udfe2 Optimized", "success");
      $.btnConfirmOptimize.disabled = false;
    });

    $.btnCancelAiPreview.addEventListener("click", function () {
      $.aiPreviewSection.classList.add("hidden");
      cachedJdAnalysis = null;
      cachedJdText = null;
      setStatus("Ready", "neutral");
      $.btnAiOptimize.disabled = false;
    });

    // ---- Standalone Cover Letter ----
    $.btnCoverLetter.addEventListener("click", async function () {
      setStatus("\ud83d\udd35 Generating\u2026", "active");
      $.btnCoverLetter.disabled = true;
      $.aiPreviewSection.classList.add("hidden");
      $.aiSection.classList.add("hidden");
      $.coverLetterSection.classList.remove("hidden");
      $.coverLetterOutput.classList.add("hidden");
      $.coverLetterStatus.innerHTML = '<span class="ai-spinner ai-spinner-cover"></span> Extracting job description\u2026';
      $.coverLetterStatus.className = "ai-status ai-status-loading";

      var jdResult = extractJd();
      if (!jdResult.ok || jdResult.wordCount < 50) {
        showCoverLetterError("Could not extract a job description from this page (found " + (jdResult.wordCount || 0) + " words).");
        return;
      }

      if (!currentJobKey) {
        var ctx = getJobContext();
        if (ctx.ok) { currentJobKey = ctx.jobKey; currentJobMeta = ctx.jobMeta; renderJobContextLine(); }
      }

      $.coverLetterStatus.innerHTML = '<span class="ai-spinner ai-spinner-cover"></span> Writing cover letter\u2026 (10\u201320s)';

      var result;
      try {
        result = await sendBg({ action: "generateCoverLetter", jdText: jdResult.jdText, jobKey: currentJobKey, jobMeta: currentJobMeta });
      } catch (e) { showCoverLetterError("Generation failed: " + String(e)); return; }

      if (!result || !result.ok) { showCoverLetterError(result ? result.error : "No response from background."); return; }

      lastCoverLetterText = result.coverLetterText;
      $.standaloneCoverLetter.value = result.coverLetterText;
      $.coverLetterOutput.classList.remove("hidden");
      $.coverLetterStatus.textContent = "\u2705 Cover letter ready. Edit as needed.";
      $.coverLetterStatus.className = "ai-status ai-status-success";
      setStatus("\ud83d\udfe2 Done", "success");
      $.btnCoverLetter.disabled = false;

      if (result.coverLetterText) {
        var personal = (result.activeResume && result.activeResume.personal) ? result.activeResume.personal : await getCurrentPersonalInfo();
        try {
          var fittedResult = await renderCoverLetterDocWithOnePageLimit(result.coverLetterText, personal, result.jdAnalysis);
          result.coverLetterText = fittedResult.text;
          $.standaloneCoverLetter.value = fittedResult.text;
          var pdfDoc = fittedResult.doc;
          pdfDoc.createdAt = new Date().toISOString();
          JA.downloadBase64File(pdfDoc.dataBase64, pdfDoc.name, pdfDoc.mime);
          if (currentJobKey) {
            await sendBg({
              action: "saveJobDocument", jobKey: currentJobKey, jobMeta: currentJobMeta,
              docType: "coverLetter",
              doc: pdfDoc,
            });
            await refreshDocsList();
          }
        } catch (pdfErr) {
          showCoverLetterError("Cover letter generated, but PDF export failed: " + String(pdfErr));
        }
      }
    });

    $.btnDownloadCoverLetter.addEventListener("click", async function () {
      var text = $.standaloneCoverLetter ? $.standaloneCoverLetter.value : lastCoverLetterText;
      if (!text) return;
      var personal = await getCurrentPersonalInfo();
      try {
        var fitted = await renderCoverLetterDocWithOnePageLimit(text, personal, cachedJdAnalysis);
        $.standaloneCoverLetter.value = fitted.text;
        var doc = fitted.doc;
        JA.downloadBase64File(doc.dataBase64, doc.name, doc.mime);
      } catch (pdfErr) {
        showCoverLetterError("PDF export failed: " + String(pdfErr));
      }
    });

    $.btnCancelCoverLetter.addEventListener("click", function () {
      $.coverLetterSection.classList.add("hidden");
      setStatus("Ready", "neutral");
      $.btnCoverLetter.disabled = false;
    });
  }

  // ======== Status / Error helpers ========

  function setStatus(text, type) {
    if (!$.statusBadge) return;
    $.statusBadge.textContent = text;
    $.statusBadge.className = "badge badge-" + type;
  }

  function showError(message) {
    $.resultsSection.classList.remove("hidden");
    $.previewSection.classList.add("hidden");
    $.resultStats.innerHTML = "";
    $.resultList.innerHTML = '<div class="result-item"><span class="result-value skipped">' +
      escHtml(message || "Unknown error") + '</span></div>';
  }

  function preferredDownloadDoc(doc) {
    if (!doc) return null;
    if (doc.derivedPdf && doc.derivedPdf.dataBase64) return doc.derivedPdf;
    if (doc.sourcePdfDataBase64) {
      return {
        dataBase64: doc.sourcePdfDataBase64,
        name: doc.sourcePdfName || "resume.pdf",
        mime: doc.sourcePdfMime || "application/pdf",
      };
    }
    return doc;
  }

  async function renderCoverLetterDocWithOnePageLimit(text, personal, jdAnalysis) {
    var currentText = String(text || "").trim();
    var lastError = null;

    for (var attempt = 0; attempt < 3; attempt++) {
      var doc = await JA.renderCoverLetterPdfDoc(
        currentText,
        currentJobMeta,
        personal,
        buildAiFilename("cover-letter", "pdf")
      );
      if ((doc.pageCount || 1) <= 1) {
        return { doc: doc, text: currentText };
      }
      lastError = new Error("Cover letter exceeded one page.");
      var shortenResp = await sendBg({
        action: "shortenCoverLetter",
        coverLetterText: currentText,
        jdAnalysis: jdAnalysis || cachedJdAnalysis || null,
        jobKey: currentJobKey || "",
      });
      if (!shortenResp.ok || !shortenResp.coverLetterText) break;
      currentText = shortenResp.coverLetterText;
    }

    throw lastError || new Error("Cover letter could not be shortened to one page.");
  }

  function showAiPreviewError(message) {
    $.aiPreviewStatus.textContent = message;
    $.aiPreviewStatus.className = "ai-status ai-status-error";
    $.btnConfirmOptimize.disabled = true;
    $.btnAiOptimize.disabled = false;
    setStatus("Error", "error");
  }

  function showAiError(message) {
    $.aiStatus.textContent = message;
    $.aiStatus.className = "ai-status ai-status-error";
    $.btnAiOptimize.disabled = false;
    setStatus("Error", "error");
  }

  function showCoverLetterError(message) {
    $.coverLetterStatus.textContent = message;
    $.coverLetterStatus.className = "ai-status ai-status-error";
    $.btnCoverLetter.disabled = false;
    setStatus("Error", "error");
  }

  // ======== Rendering ========

  function renderProfile(profile) {
    var first = profile.first_name || "";
    var last  = profile.last_name  || "";
    var name  = [first, last].filter(Boolean).join(" ") || "No name";
    var initial = (first.charAt(0) || last.charAt(0) || "?").toUpperCase();
    var details = [profile.email, profile.phone].filter(Boolean).join(" \u00b7 ");

    $.profileSummary.innerHTML =
      '<div class="profile-avatar">' + escHtml(initial) + '</div>' +
      '<div class="profile-info">' +
        '<div class="name">' + escHtml(name) + '</div>' +
        '<div class="detail">' + escHtml(details || "No contact info") + '</div>' +
      '</div>';
  }

  function renderJobContextLine() {
    if (!$.jobContextLine) return;
    if (!currentJobKey) {
      $.jobContextLine.textContent = "No job detected on this tab.";
      if ($.uploadEditedResume)     $.uploadEditedResume.disabled     = true;
      if ($.uploadCoverLetterFile)  $.uploadCoverLetterFile.disabled  = true;
      if ($.btnSaveCoverLetterText) $.btnSaveCoverLetterText.disabled = true;
      return;
    }
    var company  = (currentJobMeta && currentJobMeta.company) ? currentJobMeta.company : "";
    var jobTitle = (currentJobMeta && currentJobMeta.title)   ? currentJobMeta.title   : "";
    var parts = [company, jobTitle].filter(Boolean);
    $.jobContextLine.textContent = parts.length ? parts.join(" \u2014 ") : "Job key: " + currentJobKey;
    if ($.uploadEditedResume)     $.uploadEditedResume.disabled     = false;
    if ($.uploadCoverLetterFile)  $.uploadCoverLetterFile.disabled  = false;
    if ($.btnSaveCoverLetterText) $.btnSaveCoverLetterText.disabled = false;
  }

  function setDocsStatus(text, ok) {
    if (!$.docsStatus) return;
    $.docsStatus.textContent = text || "";
    $.docsStatus.style.color = ok ? "#059669" : "#ef4444";
  }

  async function refreshDocsList() {
    if (!currentJobKey) {
      await refreshActiveResumeContext();
      updateAiAvailability();
      renderDocsList(null);
      return;
    }
    var resp = await sendBg({ action: "getJobDocuments", jobKey: currentJobKey });
    if (!resp.ok) { setDocsStatus(resp.error || "Failed to load documents.", false); renderDocsList(null); return; }
    currentActiveResume = resp.bucket ? resp.bucket.activeResume : currentActiveResume;
    updateAiAvailability();
    setDocsStatus("", true);
    renderDocsList(resp.bucket);
  }

  function renderDocsList(bucket) {
    if (!$.docsList) return;
    if (!currentJobKey) {
      $.docsList.innerHTML = '<div class="result-item"><span class="result-value skipped">Open a job application tab to save documents.</span></div>';
      return;
    }
    if (!bucket) {
      $.docsList.innerHTML = '<div class="result-item"><span class="result-value skipped">No documents saved yet.</span></div>';
      return;
    }
    var edited = Array.isArray(bucket.editedResumes) ? bucket.editedResumes : [];
    var covers = Array.isArray(bucket.coverLetters)  ? bucket.coverLetters  : [];
    var html = "";
    if (bucket.activeResume) {
      html += '<div class="result-item"><span class="result-field">⭐ Active Resume</span><span class="result-value" title="' +
        escHtml(bucket.activeResume.sourceName || "") + '">' + escHtml(truncate(bucket.activeResume.sourceName || "", 24)) + '</span></div>';
    }
    if (edited.length > 0) {
      html += '<div class="result-item"><span class="result-field">\ud83d\udcc4 Resumes</span><span class="result-value">' + edited.length + '</span></div>';
      edited.forEach(function (d) { html += renderDocRow("editedResume", d); });
    }
    if (covers.length > 0) {
      html += '<div class="result-item"><span class="result-field">\u2709\ufe0f Cover Letters</span><span class="result-value">' + covers.length + '</span></div>';
      covers.forEach(function (d) { html += renderDocRow("coverLetter", d); });
    }
    if (!html) html = '<div class="result-item"><span class="result-value skipped">No documents saved yet.</span></div>';
    $.docsList.innerHTML = html;
  }

  function renderDocRow(docType, d) {
    var label     = d && d.name ? d.name : "(unnamed)";
    var createdAt = d && d.createdAt ? new Date(d.createdAt).toLocaleString() : "";
    var id        = d && d.id ? d.id : "";
    return (
      '<div class="result-item">' +
      '<span class="result-field" title="' + escHtml(label) + '">' + escHtml(truncate(label, 22)) + '</span>' +
      '<span class="result-value" style="display:flex;gap:6px;align-items:center;justify-content:flex-end;">' +
      '<span class="text-muted" style="max-width:100px;overflow:hidden;text-overflow:ellipsis;white-space:nowrap;">' + escHtml(createdAt) + '</span>' +
      '<button class="btn-text" data-action="download" data-doc-type="' + docType + '" data-id="' + escHtml(id) + '">\u2193</button>' +
      '<button class="btn-text" data-action="delete" data-doc-type="' + docType + '" data-id="' + escHtml(id) + '">\u2715</button>' +
      '</span></div>'
    );
  }

  async function saveDocFromFile(docType, file) {
    if (!currentJobKey) { setDocsStatus("No job detected for this tab yet.", false); return; }
    if (!file) return;
    if (file.type !== "application/pdf") {
      setDocsStatus(docType === "editedResume" ? "Resume must be a PDF." : "Cover letter must be a PDF.", false);
      return;
    }
    try {
      setDocsStatus("Saving\u2026", true);
      var dataBase64 = await readFileAsBase64(file);
      var doc = {
        id: genId(),
        name: file.name || (docType === "editedResume" ? "edited-resume.pdf" : "cover-letter.pdf"),
        mime: file.type || "application/pdf",
        size: file.size || 0,
        createdAt: new Date().toISOString(),
        dataBase64: dataBase64,
      };
      var resp = await sendBg({ action: "saveJobDocument", jobKey: currentJobKey, jobMeta: currentJobMeta, docType: docType, doc: doc });
      if (resp.ok) { setDocsStatus("Saved.", true); await refreshDocsList(); }
      else { setDocsStatus(resp.error || "Save failed.", false); }
    } catch (e) {
      setDocsStatus("Save failed: " + String(e), false);
    }
  }

  async function downloadJobDoc(docType, id) {
    if (!currentJobKey) return;
    var resp = await sendBg({ action: "getJobDocuments", jobKey: currentJobKey });
    if (!resp.ok || !resp.bucket) { setDocsStatus(resp.error || "Failed to load.", false); return; }
    var arr = docType === "editedResume" ? (resp.bucket.editedResumes || []) : (resp.bucket.coverLetters || []);
    var doc = arr.find(function (d) { return d && d.id === id; });
    if (!doc || !doc.dataBase64) { setDocsStatus("Document not found.", false); return; }
    var payload = preferredDownloadDoc(doc);
    downloadBase64(payload.dataBase64, buildJobFilename(currentJobMeta, docType, payload || doc), payload.mime || "application/octet-stream");
    setDocsStatus("Download started.", true);
  }

  async function refreshJobContextAndDocs() {
    var ctx = getJobContext();
    if (ctx.ok && ctx.jobKey) {
      currentJobKey  = ctx.jobKey;
      currentJobMeta = ctx.jobMeta || null;
      renderJobContextLine();
      await refreshDocsList();
    } else {
      currentJobKey  = null;
      currentJobMeta = null;
      renderJobContextLine();
      renderDocsList(null);
      await refreshActiveResumeContext();
      updateAiAvailability();
    }
  }

  // ======== Preview / Results ========

  function renderPreview(result) {
    $.previewSection.classList.remove("hidden");
    $.resultsSection.classList.add("hidden");

    var mappings = result.mappings || [];
    var willFill = mappings.filter(function (m) { return m.confidence >= 0.8 && m.value; });
    var willSkip = mappings.filter(function (m) { return m.confidence < 0.8 || !m.value; });

    $.previewStats.innerHTML =
      '<span class="stat">\ud83d\udccb ' + result.fieldCount + ' fields</span>' +
      '<span class="stat">\u2705 ' + willFill.length + ' to fill</span>' +
      '<span class="stat">\u23ed\ufe0f ' + willSkip.length + ' skipped</span>';

    var html = "";
    if (result.formLayout && result.formLayout.multiStepLikely) {
      var cues = (result.formLayout.wizardCues || []).join(", ");
      html +=
        '<div class="info-banner">Multi-step form likely' +
        (cues ? " (" + escHtml(cues) + ")" : "") +
        ". Fill visible fields on this step, then use the app\u2019s Next/Continue.</div>";
    }
    if (result.repeatSectionHints && result.repeatSectionHints.length) {
      var kinds = [];
      result.repeatSectionHints.forEach(function (h) {
        if (h && h.kind && kinds.indexOf(h.kind) === -1) kinds.push(h.kind);
      });
      html +=
        '<div class="info-banner">Add/expand controls detected (' +
        escHtml(kinds.join(", ") || "sections") +
        "). Click Add to reveal fields if needed, then Preview again.</div>";
    }
    if (result.navButton && result.navButton.type === "submit") {
      html += '<div class="warning-banner">\u26a0\ufe0f Submit button detected: "' +
        escHtml(result.navButton.text) + '". This extension will NOT auto-submit.</div>';
    }
    willFill.forEach(function (m) {
      var isLlm = m.source === "llm";
      var displayValue = (m.control_kind === "native_select" || m.control_kind === "custom_select")
        ? ("Select: " + m.value)
        : m.value;
      html += '<div class="result-item"><span class="result-field" title="' + escHtml(m.field_label) + '">' +
        escHtml(truncate(m.field_label, 28)) + (isLlm ? '<span class="badge-llm">via AI</span>' : '') +
        '</span><span class="result-value" title="' + escHtml(displayValue) + '">' + escHtml(truncate(displayValue, 32)) + '</span></div>';
    });
    willSkip.forEach(function (s) {
      html += '<div class="result-item"><span class="result-field" title="' + escHtml(s.field_label) + '">' + escHtml(truncate(s.field_label, 30)) +
        '</span><span class="result-value skipped">' + escHtml(s.reason || "skipped") + '</span></div>';
    });
    $.previewList.innerHTML = html;
  }

  function renderResults(result) {
    $.resultsSection.classList.remove("hidden");
    $.previewSection.classList.add("hidden");

    var filled  = result.filled  || [];
    var skipped = result.skipped || [];
    var mappings = result.mappings || currentMappings || [];
    var llmSelectors = {};
    mappings.forEach(function (m) { if (m && m.source === "llm") llmSelectors[m.selector] = true; });

    $.resultStats.innerHTML =
      '<span class="stat">\u2705 ' + filled.length + ' filled</span>' +
      '<span class="stat">\u23ed\ufe0f ' + skipped.length + ' skipped</span>';

    var html = "";
    filled.forEach(function (f) {
      var isLlm = f.selector && llmSelectors[f.selector];
      var displayValue = (f.control_kind === "native_select" || f.control_kind === "custom_select")
        ? ("Select: " + f.value)
        : f.value;
      html += '<div class="result-item"><span class="result-field" title="' + escHtml(f.field) + '">' +
        escHtml(truncate(f.field, 28)) + (isLlm ? '<span class="badge-llm">via AI</span>' : '') +
        '</span><span class="result-value" title="' + escHtml(displayValue) + '">' + escHtml(truncate(displayValue, 32)) + '</span></div>';
    });
    skipped.forEach(function (sk) {
      html += '<div class="result-item"><span class="result-field" title="' + escHtml(sk.field) + '">' + escHtml(truncate(sk.field, 30)) +
        '</span><span class="result-value skipped">' + escHtml(sk.reason || "skipped") + '</span></div>';
    });
    $.resultList.innerHTML = html;
  }

  // ======== AI Preview rendering ========

  function renderAiPreview(gapResult) {
    var html = "";
    var reasonMap = {};
    (gapResult.gapDetails || []).forEach(function (d) { if (d && d.requirement) reasonMap[d.requirement] = d.reason || ""; });

    var matched  = (gapResult.matchedSkills || []).concat(gapResult.matchedKeywords || []).concat(gapResult.matchedQualifications || []);
    var missing  = gapResult.missingSkills || [];
    var quals    = gapResult.missingQualifications || [];
    var keywords = gapResult.missingKeywords || [];
    var matchedUniq = matched.filter(function (v, i, a) { return a.indexOf(v) === i; });

    if (matchedUniq.length > 0) {
      html += '<div class="ai-preview-row"><span class="ai-preview-emoji">\u2705</span><span class="ai-preview-label">Resume has</span><span class="ai-preview-items skill-tags">' +
        matchedUniq.map(function (s) {
          var tip = reasonMap[s] || reasonMap["Skill: " + s] || reasonMap["Keyword/technology: " + s] || "";
          return '<span class="skill-tag skill-tag-green" title="' + escHtml(tip) + '">' + escHtml(s) + '</span>';
        }).join("") + '</span></div>';
    }
    if (missing.length > 0) {
      html += '<div class="ai-preview-row"><span class="ai-preview-emoji">\u274c</span><span class="ai-preview-label">Missing skills</span><span class="ai-preview-items skill-tags">' +
        missing.map(function (s) {
          var tip = reasonMap["Skill: " + s] || reasonMap[s] || "";
          return '<span class="skill-tag skill-tag-red" title="' + escHtml(tip) + '">' + escHtml(s) + '</span>';
        }).join("") + '</span></div>';
    }
    if (quals.length > 0) {
      html += '<div class="ai-preview-row"><span class="ai-preview-emoji">\u26a0\ufe0f</span><span class="ai-preview-label">Gaps</span><span class="ai-preview-items skill-tags">' +
        quals.map(function (q) {
          var tip = reasonMap[q] || "";
          return '<span class="skill-tag skill-tag-yellow" title="' + escHtml(tip) + '">' + escHtml(truncate(q, 60)) + '</span>';
        }).join("") + '</span></div>';
    }
    if (keywords.length > 0) {
      html += '<div class="ai-preview-row"><span class="ai-preview-emoji">\ud83d\udd11</span><span class="ai-preview-label">Keywords missing</span><span class="ai-preview-items skill-tags">' +
        keywords.map(function (k) {
          var tip = reasonMap["Keyword/technology: " + k] || reasonMap[k] || "";
          return '<span class="skill-tag skill-tag-red" title="' + escHtml(tip) + '">' + escHtml(k) + '</span>';
        }).join("") + '</span></div>';
    }
    if (!html) {
      html = '<div class="ai-preview-row"><span class="ai-preview-emoji">\u2705</span>' +
        '<span class="ai-preview-items">Your resume looks well-matched! Optimization can still refine wording.</span></div>';
    }
    $.aiPreviewContent.innerHTML = html;
  }

  function renderAiResults(result) {
    $.aiStatus.textContent = "\u2705 Resume optimized and cover letter generated.";
    $.aiStatus.className = "ai-status ai-status-success";

    var diff = result.diff || [];
    var gaps = result.requirementsGaps || [];
    var changedBullets = 0, addedBullets = 0;
    diff.forEach(function (entry) {
      (entry.bullets || []).forEach(function (b) {
        if (b.type === "changed") changedBullets++;
        else if (b.type === "added") addedBullets++;
      });
    });
    var metCount       = gaps.filter(function (g) { return g.status === "met"; }).length;
    var generatedCount = gaps.filter(function (g) { return g.status === "filled_by_generated_project"; }).length;

    var summaryParts = [];
    if (changedBullets > 0) summaryParts.push("\u270f\ufe0f " + changedBullets + " bullet" + (changedBullets > 1 ? "s" : "") + " reworded");
    if (addedBullets > 0)   summaryParts.push("\u2795 " + addedBullets + " bullet" + (addedBullets > 1 ? "s" : "") + " added");
    if (metCount > 0)        summaryParts.push("\u2705 " + metCount + " requirement" + (metCount > 1 ? "s" : "") + " met");
    if (generatedCount > 0)  summaryParts.push("\ud83d\udd2e " + generatedCount + " project generated");

    if (summaryParts.length > 0) {
      $.aiOptimizeSummary.innerHTML = summaryParts.map(function (p, i) {
        return '<span class="optimize-summary-item">' + escHtml(p) + '</span>' +
          (i < summaryParts.length - 1 ? '<span class="optimize-summary-sep">\u00b7</span>' : '');
      }).join("");
      $.aiOptimizeSummary.classList.remove("hidden");
    }

    if (gaps.length > 0) {
      $.aiGapSection.classList.remove("hidden");
      var gapHtml = "";
      gaps.forEach(function (gap) {
        var sc = "gap-met", sl = "\u2705 Met";
        if (gap.status === "partially_met")             { sc = "gap-partial";   sl = "\u26a0\ufe0f Partial"; }
        else if (gap.status === "not_met")              { sc = "gap-missing";   sl = "\u274c Missing"; }
        else if (gap.status === "filled_by_generated_project") { sc = "gap-generated"; sl = "\ud83d\udd2e Generated"; }
        gapHtml += '<div class="gap-row ' + sc + '"><span class="gap-status-badge">' + sl + '</span>' +
          '<span class="gap-text">' + escHtml(gap.requirement || "") +
          (gap.notes ? '<span class="gap-notes">' + escHtml(gap.notes) + '</span>' : '') + '</span></div>';
      });
      $.aiGapList.innerHTML = gapHtml;
    }

    if (diff.length > 0) {
      $.aiDiffSection.classList.remove("hidden");
      var diffHtml = "";
      diff.forEach(function (entry) {
        var sLabel = entry.section === "experience" ? "Experience" : "Project";
        var hClass = entry.generated ? "diff-header diff-generated-header" : "diff-header";
        diffHtml += '<div class="' + hClass + '"><span class="diff-section-label">' + sLabel + '</span> ' + escHtml(entry.header);
        if (entry.generated) diffHtml += ' <span class="diff-generated-badge">Generated</span>';
        diffHtml += '</div>';
        (entry.bullets || []).forEach(function (b) {
          if (b.type === "headline_changed") {
            diffHtml += '<div class="diff-line diff-removed">Headline: ' + escHtml(truncate(b.origText, 140)) + '</div>' +
              '<div class="diff-line diff-added">Headline: ' + escHtml(truncate(b.newText, 140)) + '</div>';
          } else if (b.type === "changed") {
            diffHtml += '<div class="diff-line diff-removed">&minus; ' + escHtml(truncate(b.origText, 140)) + '</div>' +
              '<div class="diff-line diff-added">&plus; ' + escHtml(truncate(b.newText, 140)) + '</div>';
          } else if (b.type === "added") {
            diffHtml += '<div class="diff-line diff-added">&plus; ' + escHtml(truncate(b.newText, 140)) + '</div>';
          }
        });
      });
      $.aiResumeDiff.innerHTML = diffHtml;
    }

    if (result.coverLetterText) {
      $.aiCoverLetterSection.classList.remove("hidden");
      $.aiCoverLetter.value = result.coverLetterText;
    }
  }

  // ======== AI doc save & download ========

  async function saveAndDownloadAiDocs(result) {
    var personal = (result.activeResume && result.activeResume.personal) ? result.activeResume.personal : await getCurrentPersonalInfo();
    var now = new Date().toISOString();

    if (result.resumeDoc || (result.tailoredResume && JA.buildResumeHtml && JA.renderPdfFromHtml)) {
      var resumeDoc = result.resumeDoc || null;
      if (!resumeDoc) {
        var resumeHtml = JA.buildResumeHtml(result.tailoredResume);
        resumeDoc  = await JA.renderPdfFromHtml(resumeHtml, buildAiFilename("tailored-resume", "pdf"));
      }
      resumeDoc.createdAt = now;
      var resumeDownloadDoc = preferredDownloadDoc(resumeDoc);
      JA.downloadBase64File(resumeDownloadDoc.dataBase64, resumeDownloadDoc.name, resumeDownloadDoc.mime);
      if (currentJobKey) {
        await sendBg({
          action: "saveJobDocument", jobKey: currentJobKey, jobMeta: currentJobMeta,
          docType: "editedResume",
          doc: resumeDoc,
        });
      }
    }

    if (result.coverLetterText && JA.renderCoverLetterPdfDoc) {
      var coverResult = await renderCoverLetterDocWithOnePageLimit(result.coverLetterText, personal, result.jdAnalysis);
      var clDoc = coverResult.doc;
      result.coverLetterText = coverResult.text;
      clDoc.createdAt = now;
      JA.downloadBase64File(clDoc.dataBase64, clDoc.name, clDoc.mime);
      if (currentJobKey) {
        await sendBg({
          action: "saveJobDocument", jobKey: currentJobKey, jobMeta: currentJobMeta,
          docType: "coverLetter",
          doc: clDoc,
        });
      }
    }

    await refreshDocsList();
  }

  // ======== Side tab (collapsed sidebar indicator) ========

  function showSidebarTab() {
    if (document.getElementById(TAB_ID)) return;
    var tab = document.createElement("div");
    tab.id = TAB_ID;
    tab.title = "Job Autofill \u2014 click to expand";
    tab.style.cssText =
      "position:fixed;right:0;top:40%;transform:translateY(-50%);" +
      "z-index:2147483646;" +
      "width:32px;min-height:88px;" +
      "background:linear-gradient(180deg,#6366f1 0%,#8b5cf6 100%);" +
      "border-radius:12px 0 0 12px;" +
      "box-shadow:-3px 0 18px rgba(99,102,241,0.28);" +
      "cursor:pointer;" +
      "display:flex;flex-direction:column;align-items:center;justify-content:center;gap:6px;" +
      "padding:10px 0;" +
      "transition:width 0.2s ease,box-shadow 0.2s ease;" +
      "font-family:-apple-system,BlinkMacSystemFont,'Segoe UI',Roboto,sans-serif;";

    tab.innerHTML =
      '<span style="color:#fff;font-size:14px;line-height:1;user-select:none">\u2726</span>' +
      '<span style="color:rgba(255,255,255,0.9);font-size:9px;font-weight:700;letter-spacing:0.8px;' +
      'text-transform:uppercase;writing-mode:vertical-rl;text-orientation:mixed;transform:rotate(180deg);user-select:none">Panel</span>';

    tab.addEventListener("mouseenter", function () { tab.style.width = "38px"; tab.style.boxShadow = "-5px 0 24px rgba(99,102,241,0.38)"; });
    tab.addEventListener("mouseleave", function () { tab.style.width = "32px"; tab.style.boxShadow = "-3px 0 18px rgba(99,102,241,0.28)"; });
    tab.addEventListener("click", function () { removeSidebarTab(); show(); });

    document.body.appendChild(tab);
  }

  function removeSidebarTab() {
    var tab = document.getElementById(TAB_ID);
    if (tab) tab.remove();
  }

  // ======== Message listener ========

  chrome.runtime.onMessage.addListener(function (msg) {
    if (!msg) return;
    if (msg.action === "toggleSidebar") toggle();
    else if (msg.action === "openSidebar") show();
  });

  // ======== Exports ========

  JA.openSidebar  = show;
  JA.toggleSidebar = toggle;
  JA.hideSidebar   = hide;
})();

/**
 * Options page script for the Job Autofill extension.
 * Dashboard, archive, profile editor, and AI settings.
 */

(function () {
  const JA = window.JobAutofill || {};
  const FLAT_FIELDS = [
    "first_name", "last_name", "email", "phone",
    "linkedin", "github", "portfolio",
    "university", "degree", "gpa",
    "graduation_month", "graduation_year",
    "work_authorization", "years_of_experience",
  ];
  const ADDRESS_FIELDS = ["street", "city", "state", "zip", "country"];
  const OPERATION_COLORS = {
    fieldMap: "#6366f1",
    jdAnalysis: "#0ea5e9",
    gapCheck: "#f59e0b",
    tailorResume: "#8b5cf6",
    coverLetter: "#10b981",
  };
  const state = {
    archiveItems: [],
    archiveDebounce: null,
  };

  bindEvents();
  init();

  async function init() {
    await Promise.all([
      loadSettings(),
      loadApiDashboard(),
      loadArchive(),
    ]);
  }

  function bindEvents() {
    document.getElementById("btnResetApiUsage").addEventListener("click", async () => {
      const resp = await sendBg({ action: "resetApiUsage" });
      showStatus("apiUsageStatus", resp.ok ? "Usage stats cleared." : "Could not reset usage stats.", !!resp.ok, false);
      if (resp.ok) await loadApiDashboard();
    });

    document.getElementById("btnRefreshArchive").addEventListener("click", loadArchive);
    document.getElementById("archiveSearch").addEventListener("input", () => {
      clearTimeout(state.archiveDebounce);
      state.archiveDebounce = setTimeout(loadArchive, 220);
    });
    document.getElementById("archiveDocType").addEventListener("change", loadArchive);
    document.getElementById("archiveTableBody").addEventListener("click", handleArchiveAction);

    document.getElementById("profileForm").addEventListener("submit", async (e) => {
      e.preventDefault();
      const profile = readForm();
      const resp = await sendBg({ action: "saveProfile", profile });
      showStatus("profileStatus", resp.ok ? "Profile saved." : "Save failed.", !!resp.ok);
    });

    document.getElementById("btnExport").addEventListener("click", () => {
      const profile = readForm();
      const blob = new Blob([JSON.stringify(profile, null, 2)], { type: "application/json" });
      const url = URL.createObjectURL(blob);
      const a = document.createElement("a");
      a.href = url;
      a.download = "applicant_data.json";
      a.click();
      URL.revokeObjectURL(url);
    });

    document.getElementById("btnImport").addEventListener("click", async () => {
      const text = document.getElementById("jsonImport").value.trim();
      if (!text) {
        showStatus("importStatus", "Paste JSON first.", false);
        return;
      }
      try {
        const data = JSON.parse(text);
        if (!data.first_name && !data.email && !data.last_name) {
          showStatus("importStatus", "JSON doesn't look like an applicant profile.", false);
          return;
        }
        populateForm(data);
        const resp = await sendBg({ action: "saveProfile", profile: data });
        showStatus("importStatus", resp.ok ? "Imported and saved." : "Import failed.", !!resp.ok);
        if (resp.ok) document.getElementById("jsonImport").value = "";
      } catch (err) {
        showStatus("importStatus", "Invalid JSON: " + err.message, false);
      }
    });

    document.getElementById("btnSaveAi").addEventListener("click", async () => {
      const apiKey = document.getElementById("apiKey").value.trim();
      const llmEnabled = document.getElementById("llmEnabled").checked;
      const styleProfile = document.getElementById("styleProfile").value.trim();
      const resp = await sendBg({ action: "saveSettings", apiKey, llmEnabled });
      const styleResp = await sendBg({ action: "saveStyleProfile", styleProfile });
      showStatus("aiSettingsStatus", (resp.ok && styleResp.ok) ? "AI settings saved." : "Save failed.", !!(resp.ok && styleResp.ok));
    });

    document.getElementById("btnSaveResume").addEventListener("click", async () => {
      const text = document.getElementById("resumeJson").value.trim();
      if (!text) {
        showStatus("resumeStatus", "Paste resume JSON first.", false);
        return;
      }
      try {
        const data = JSON.parse(text);
        const resp = await sendBg({ action: "saveResume", resume: data });
        showStatus("resumeStatus", resp.ok ? "Resume data saved." : "Save failed.", !!resp.ok);
      } catch (err) {
        showStatus("resumeStatus", "Invalid JSON: " + err.message, false);
      }
    });

    const baseResumePdfInput = document.getElementById("baseResumePdf");
    const btnDownloadBase = document.getElementById("btnDownloadBaseResumePdf");
    const btnClearBase = document.getElementById("btnClearBaseResumePdf");

    baseResumePdfInput.addEventListener("change", async (e) => {
      const file = e.target.files && e.target.files[0];
      if (!file) return;
      if (file.type !== "application/pdf") {
        showStatus("baseResumePdfStatus", "Please choose a PDF file.", false);
        baseResumePdfInput.value = "";
        return;
      }
      try {
        const dataBase64 = await readFileAsBase64(file);
        const pdf = {
          id: (window.crypto && window.crypto.randomUUID) ? window.crypto.randomUUID() : ("pdf_" + Date.now()),
          name: file.name || "resume.pdf",
          mime: file.type || "application/pdf",
          size: file.size || 0,
          createdAt: new Date().toISOString(),
          dataBase64: dataBase64,
        };
        const resp = await sendBg({ action: "saveBaseResumePdf", pdf });
        if (resp.ok) {
          showStatus("baseResumePdfStatus", "Base resume PDF saved.", true);
          renderBaseResumePdfMeta(pdf);
        } else {
          showStatus("baseResumePdfStatus", resp.error || "Save failed.", false);
        }
      } catch (err) {
        showStatus("baseResumePdfStatus", "Upload failed: " + err.message, false);
      } finally {
        baseResumePdfInput.value = "";
      }
    });

    btnDownloadBase.addEventListener("click", async () => {
      const resp = await sendBg({ action: "getBaseResumePdf" });
      if (!resp.ok || !resp.pdf || !resp.pdf.dataBase64) {
        showStatus("baseResumePdfStatus", "No stored base resume PDF.", false);
        return;
      }
      downloadBase64File(resp.pdf.dataBase64, resp.pdf.name || "base-resume.pdf", resp.pdf.mime || "application/pdf");
      showStatus("baseResumePdfStatus", "Download started.", true);
    });

    btnClearBase.addEventListener("click", async () => {
      const resp = await sendBg({ action: "clearBaseResumePdf" });
      showStatus("baseResumePdfStatus", resp.ok ? "Cleared stored PDF." : "Clear failed.", !!resp.ok);
      if (resp.ok) renderBaseResumePdfMeta(null);
    });
  }

  async function loadSettings() {
    const resp = await sendBg({ action: "getSettings" });
    if (!resp.ok) return;

    if (resp.profile) populateForm(resp.profile);
    if (resp.apiKey) document.getElementById("apiKey").value = resp.apiKey;
    document.getElementById("llmEnabled").checked = resp.llmEnabled === true;
    if (resp.resume) {
      document.getElementById("resumeJson").value = JSON.stringify(resp.resume, null, 2);
    }
    if (resp.styleProfile) {
      document.getElementById("styleProfile").value = resp.styleProfile;
    }
    renderBaseResumePdfMeta(resp.baseResumePdfMeta || null);
  }

  async function loadApiDashboard() {
    const resp = await sendBg({ action: "getApiUsageDashboard" });
    if (!resp.ok || !resp.dashboard) {
      renderUsageKpis(null);
      renderTimelineChart([]);
      renderBreakdownChart({});
      renderBreakdownList({});
      return;
    }

    const summary = resp.dashboard.summary || {};
    const timeline = buildRecentTimeline(resp.dashboard.timeline || [], 14);
    renderUsageKpis(summary);
    renderTimelineChart(timeline);
    renderBreakdownChart(summary.byOperation || {});
    renderBreakdownList(summary.byOperation || {});

    if (summary.legacyBackfill) {
      showStatus(
        "apiUsageStatus",
        "Historical totals from the old tracker were imported. Older daily history cannot be reconstructed.",
        true,
        false
      );
    } else {
      document.getElementById("apiUsageStatus").classList.add("hidden");
    }
  }

  async function loadArchive() {
    const filters = {
      query: document.getElementById("archiveSearch").value.trim(),
      docType: document.getElementById("archiveDocType").value,
    };
    const resp = await sendBg({ action: "listDocumentArchive", filters });
    if (!resp.ok) {
      renderArchive([]);
      showStatus("archiveStatus", resp.error || "Failed to load archive.", false, false);
      return;
    }
    state.archiveItems = resp.items || [];
    renderArchive(state.archiveItems);
    document.getElementById("archiveStatus").classList.add("hidden");
  }

  function renderUsageKpis(summary) {
    summary = summary || {};
    document.getElementById("kpiTotalRequests").textContent = formatNumber(summary.totalRequests || 0);
    document.getElementById("kpiPromptTokens").textContent = formatNumber(summary.totalPromptTokens || 0);
    document.getElementById("kpiCompletionTokens").textContent = formatNumber(summary.totalCompletionTokens || 0);
    document.getElementById("kpiApproxCost").textContent = formatCurrency(summary.approxCostUsd || 0);
  }

  function renderTimelineChart(timeline) {
    const canvas = document.getElementById("usageTimelineChart");
    const empty = document.getElementById("usageTimelineEmpty");
    const legend = document.getElementById("timelineLegend");
    const ctx = canvas.getContext("2d");
    const parentWidth = canvas.parentElement.clientWidth - 4;
    const dpr = window.devicePixelRatio || 1;
    canvas.width = Math.max(320, parentWidth * dpr);
    canvas.height = 240 * dpr;
    canvas.style.height = "240px";
    ctx.setTransform(1, 0, 0, 1, 0, 0);
    ctx.scale(dpr, dpr);
    ctx.clearRect(0, 0, parentWidth, 240);
    legend.innerHTML = "";

    const totalTokensAcrossTimeline = timeline.reduce((sum, item) => sum + (item.totalTokens || 0), 0);
    if (!timeline.length || totalTokensAcrossTimeline === 0) {
      empty.classList.remove("hidden");
      canvas.classList.add("hidden");
      return;
    }

    empty.classList.add("hidden");
    canvas.classList.remove("hidden");

    const width = parentWidth;
    const height = 240;
    const padding = { top: 18, right: 12, bottom: 34, left: 44 };
    const graphHeight = height - padding.top - padding.bottom;
    const graphWidth = width - padding.left - padding.right;
    const operations = collectTimelineOperations(timeline);
    const maxTokens = Math.max.apply(null, timeline.map((item) => item.totalTokens || 0)) || 1;
    const barGap = 10;
    const barWidth = Math.max(18, (graphWidth - (timeline.length - 1) * barGap) / timeline.length);

    drawAxis(ctx, width, height, padding);

    timeline.forEach((item, index) => {
      let cursorY = height - padding.bottom;
      const x = padding.left + index * (barWidth + barGap);
      operations.forEach((op) => {
        const opEntry = item.byOperation && item.byOperation[op];
        const tokens = opEntry ? opEntry.totalTokens : 0;
        if (!tokens) return;
        const barHeight = (tokens / maxTokens) * graphHeight;
        cursorY -= barHeight;
        ctx.fillStyle = getOperationColor(op);
        ctx.fillRect(x, cursorY, barWidth, barHeight);
      });

      ctx.fillStyle = "#64748b";
      ctx.font = "12px sans-serif";
      ctx.textAlign = "center";
      ctx.fillText(formatDayLabel(item.date), x + barWidth / 2, height - 12);
    });

    ctx.fillStyle = "#64748b";
    ctx.font = "11px sans-serif";
    ctx.textAlign = "right";
    ctx.fillText(formatCompactNumber(maxTokens), padding.left - 8, padding.top + 4);
    ctx.fillText("0", padding.left - 8, height - padding.bottom + 4);

    legend.innerHTML = operations.map((op) => (
      '<span class="legend-item"><span class="legend-swatch" style="background:' + escapeHtml(getOperationColor(op)) + ';"></span>' +
      escapeHtml(formatOperationName(op)) + "</span>"
    )).join("");
  }

  function renderBreakdownChart(byOperation) {
    const canvas = document.getElementById("usageBreakdownChart");
    const empty = document.getElementById("usageBreakdownEmpty");
    const ctx = canvas.getContext("2d");
    const items = Object.keys(byOperation || {})
      .map((op) => ({ op, value: Number(byOperation[op].approxCostUsd) || 0 }))
      .sort((a, b) => b.value - a.value);
    const parentWidth = canvas.parentElement.clientWidth - 4;
    const dpr = window.devicePixelRatio || 1;
    canvas.width = Math.max(320, parentWidth * dpr);
    canvas.height = 240 * dpr;
    canvas.style.height = "240px";
    ctx.setTransform(1, 0, 0, 1, 0, 0);
    ctx.scale(dpr, dpr);
    ctx.clearRect(0, 0, parentWidth, 240);

    if (!items.length) {
      empty.classList.remove("hidden");
      canvas.classList.add("hidden");
      return;
    }

    empty.classList.add("hidden");
    canvas.classList.remove("hidden");

    const width = parentWidth;
    const height = 240;
    const padding = { top: 20, right: 18, bottom: 16, left: 120 };
    const rowHeight = Math.min(32, (height - padding.top - padding.bottom) / items.length);
    const maxValue = Math.max.apply(null, items.map((item) => item.value)) || 1;

    items.forEach((item, index) => {
      const y = padding.top + index * rowHeight;
      const barWidth = ((width - padding.left - padding.right) * item.value) / maxValue;
      ctx.fillStyle = "#e5e7eb";
      ctx.fillRect(padding.left, y + 6, width - padding.left - padding.right, 14);
      ctx.fillStyle = getOperationColor(item.op);
      ctx.fillRect(padding.left, y + 6, barWidth, 14);
      ctx.fillStyle = "#334155";
      ctx.font = "12px sans-serif";
      ctx.textAlign = "left";
      ctx.fillText(formatOperationName(item.op), 10, y + 17);
      ctx.textAlign = "right";
      ctx.fillStyle = "#64748b";
      ctx.fillText(formatCurrency(item.value), width - 6, y + 17);
    });
  }

  function renderBreakdownList(byOperation) {
    const el = document.getElementById("usageBreakdownList");
    const rows = Object.keys(byOperation || {})
      .map((op) => ({ op, data: byOperation[op] }))
      .sort((a, b) => (Number(b.data.approxCostUsd) || 0) - (Number(a.data.approxCostUsd) || 0));

    if (!rows.length) {
      el.innerHTML = "";
      return;
    }

    el.innerHTML = rows.map(({ op, data }) => (
      '<div class="breakdown-row">' +
      '<span class="breakdown-label"><span class="legend-swatch" style="background:' + escapeHtml(getOperationColor(op)) + ';"></span>' + escapeHtml(formatOperationName(op)) + '</span>' +
      '<span class="breakdown-metric">' + formatNumber(data.count || 0) + ' req</span>' +
      '<span class="breakdown-metric">' + formatNumber((data.promptTokens || 0) + (data.completionTokens || 0)) + ' tokens</span>' +
      '<span class="breakdown-metric">' + formatCurrency(data.approxCostUsd || 0) + "</span>" +
      "</div>"
    )).join("");
  }

  function renderArchive(items) {
    const tbody = document.getElementById("archiveTableBody");
    if (!items.length) {
      tbody.innerHTML = '<tr><td colspan="6" class="empty-row">No archived documents match the current filters.</td></tr>';
      return;
    }

    tbody.innerHTML = items.map((item) => {
      const company = item.jobMeta && item.jobMeta.company ? item.jobMeta.company : "Unknown company";
      const title = item.jobMeta && item.jobMeta.title ? item.jobMeta.title : item.jobKey;
      return (
        "<tr>" +
        '<td><div class="doc-main">' + escapeHtml(item.name || "(unnamed)") + '</div><div class="doc-sub">' + escapeHtml(item.jobKey || "") + "</div></td>" +
        '<td><div class="doc-main">' + escapeHtml(company) + '</div><div class="doc-sub">' + escapeHtml(title || "") + "</div></td>" +
        '<td><span class="doc-tag">' + escapeHtml(item.docType === "editedResume" ? "Resume" : "Cover Letter") + "</span></td>" +
        "<td>" + escapeHtml(item.createdAt ? new Date(item.createdAt).toLocaleString() : "—") + "</td>" +
        "<td>" + escapeHtml(formatBytes(item.size || 0)) + "</td>" +
        '<td><div class="archive-actions">' +
        '<button class="btn btn-secondary" data-action="download" data-id="' + escapeHtml(item.id) + '">Download</button>' +
        '<button class="btn btn-ghost" data-action="delete" data-id="' + escapeHtml(item.id) + '">Delete</button>' +
        "</div></td>" +
        "</tr>"
      );
    }).join("");
  }

  async function handleArchiveAction(e) {
    const button = e.target && e.target.closest ? e.target.closest("button[data-action]") : null;
    if (!button) return;
    const action = button.getAttribute("data-action");
    const id = button.getAttribute("data-id");
    if (!action || !id) return;

    if (action === "download") {
      const resp = await sendBg({ action: "getArchivedDocument", id });
      if (!resp.ok || !resp.doc || !resp.doc.dataBase64) {
        showStatus("archiveStatus", resp.error || "Document not found.", false, false);
        return;
      }
      downloadBase64File(resp.doc.dataBase64, resp.doc.name || "document.pdf", resp.doc.mime || "application/octet-stream");
      showStatus("archiveStatus", "Download started.", true, true);
      return;
    }

    if (action === "delete") {
      const resp = await sendBg({ action: "deleteArchivedDocument", id });
      showStatus("archiveStatus", resp.ok ? "Document deleted." : (resp.error || "Delete failed."), !!resp.ok, true);
      if (resp.ok) await loadArchive();
    }
  }

  function populateForm(profile) {
    for (const key of FLAT_FIELDS) {
      const el = document.getElementById(key);
      if (el && profile[key] !== undefined) {
        if (el.tagName === "SELECT") el.value = String(profile[key]);
        else el.value = profile[key] || "";
      }
    }
    const addr = profile.address || {};
    for (const key of ADDRESS_FIELDS) {
      const el = document.getElementById(key);
      if (el) el.value = addr[key] || "";
    }
    const sponsorEl = document.getElementById("require_sponsorship");
    if (sponsorEl) sponsorEl.value = profile.require_sponsorship ? "true" : "false";
  }

  function readForm() {
    const profile = {};
    for (const key of FLAT_FIELDS) {
      const el = document.getElementById(key);
      profile[key] = el ? el.value.trim() : "";
    }
    profile.address = {};
    for (const key of ADDRESS_FIELDS) {
      const el = document.getElementById(key);
      profile.address[key] = el ? el.value.trim() : "";
    }
    profile.require_sponsorship = document.getElementById("require_sponsorship").value === "true";
    return profile;
  }

  function renderBaseResumePdfMeta(meta) {
    const el = document.getElementById("baseResumePdfMeta");
    const btnDownload = document.getElementById("btnDownloadBaseResumePdf");
    const btnClear = document.getElementById("btnClearBaseResumePdf");
    if (!meta) {
      el.textContent = "No base resume PDF stored yet.";
      btnDownload.disabled = true;
      btnClear.disabled = true;
      return;
    }
    el.textContent = "Stored: " + (meta.name || "resume.pdf") + " (" + formatBytes(meta.size || 0) + ") • " +
      (meta.createdAt ? new Date(meta.createdAt).toLocaleString() : "");
    btnDownload.disabled = false;
    btnClear.disabled = false;
  }

  function collectTimelineOperations(timeline) {
    const seen = {};
    const ordered = [];
    timeline.forEach((item) => {
      Object.keys(item.byOperation || {}).forEach((op) => {
        if (!seen[op]) {
          seen[op] = true;
          ordered.push(op);
        }
      });
    });
    return ordered;
  }

  function buildRecentTimeline(items, days) {
    const map = {};
    (items || []).forEach((item) => { map[item.date] = item; });
    const out = [];
    const now = new Date();
    for (let i = days - 1; i >= 0; i--) {
      const d = new Date(now);
      d.setDate(now.getDate() - i);
      const iso = [
        d.getFullYear(),
        String(d.getMonth() + 1).padStart(2, "0"),
        String(d.getDate()).padStart(2, "0"),
      ].join("-");
      out.push(map[iso] || {
        date: iso,
        totalTokens: 0,
        approxCostUsd: 0,
        byOperation: {},
      });
    }
    return out;
  }

  function drawAxis(ctx, width, height, padding) {
    ctx.strokeStyle = "#cbd5e1";
    ctx.lineWidth = 1;
    ctx.beginPath();
    ctx.moveTo(padding.left, padding.top);
    ctx.lineTo(padding.left, height - padding.bottom);
    ctx.lineTo(width - padding.right, height - padding.bottom);
    ctx.stroke();
  }

  function getOperationColor(op) {
    if (OPERATION_COLORS[op]) return OPERATION_COLORS[op];
    const palette = ["#6366f1", "#f97316", "#14b8a6", "#ec4899", "#64748b"];
    let hash = 0;
    String(op || "").split("").forEach((ch) => { hash += ch.charCodeAt(0); });
    return palette[hash % palette.length];
  }

  function formatOperationName(op) {
    return String(op || "unknown")
      .replace(/([a-z])([A-Z])/g, "$1 $2")
      .replace(/^./, (s) => s.toUpperCase());
  }

  function formatDayLabel(isoDate) {
    if (!isoDate) return "";
    const d = new Date(isoDate + "T00:00:00");
    return d.toLocaleDateString(undefined, { month: "short", day: "numeric" });
  }

  function sendBg(msg) {
    return new Promise((resolve) => {
      chrome.runtime.sendMessage(msg, (resp) => {
        resolve(resp || { ok: false, error: "No response from background" });
      });
    });
  }

  function showStatus(elId, message, success, autoHide = true) {
    const el = document.getElementById(elId);
    el.textContent = message;
    el.className = "status-msg " + (success ? "success" : "error");
    el.classList.remove("hidden");
    if (autoHide) {
      setTimeout(() => el.classList.add("hidden"), 4000);
    }
  }

  function escapeHtml(s) {
    return String(s)
      .replace(/&/g, "&amp;")
      .replace(/</g, "&lt;")
      .replace(/>/g, "&gt;")
      .replace(/"/g, "&quot;");
  }

  function formatNumber(value) {
    return new Intl.NumberFormat().format(Number(value) || 0);
  }

  function formatCompactNumber(value) {
    return new Intl.NumberFormat(undefined, { notation: "compact", maximumFractionDigits: 1 }).format(Number(value) || 0);
  }

  function formatCurrency(value) {
    return new Intl.NumberFormat(undefined, {
      style: "currency",
      currency: "USD",
      minimumFractionDigits: 2,
      maximumFractionDigits: 4,
    }).format(Number(value) || 0);
  }

  function formatBytes(bytes) {
    const b = Number(bytes) || 0;
    if (b < 1024) return b + " B";
    const kb = b / 1024;
    if (kb < 1024) return kb.toFixed(1) + " KB";
    const mb = kb / 1024;
    if (mb < 1024) return mb.toFixed(1) + " MB";
    return (mb / 1024).toFixed(1) + " GB";
  }

  async function readFileAsBase64(file) {
    if (JA.readFileAsBase64) return JA.readFileAsBase64(file);
    return new Promise((resolve, reject) => {
      const reader = new FileReader();
      reader.onerror = () => reject(new Error("Failed to read file"));
      reader.onload = () => resolve(arrayBufferToBase64(reader.result));
      reader.readAsArrayBuffer(file);
    });
  }

  function arrayBufferToBase64(arrayBuffer) {
    if (JA.arrayBufferToBase64) return JA.arrayBufferToBase64(arrayBuffer);
    const bytes = new Uint8Array(arrayBuffer);
    let binary = "";
    const chunkSize = 0x8000;
    for (let i = 0; i < bytes.length; i += chunkSize) {
      binary += String.fromCharCode.apply(null, bytes.subarray(i, i + chunkSize));
    }
    return btoa(binary);
  }

  function downloadBase64File(base64, filename, mime) {
    if (JA.downloadBase64File) {
      JA.downloadBase64File(base64, filename, mime);
      return;
    }
    const byteChars = atob(base64);
    const byteNumbers = new Array(byteChars.length);
    for (let i = 0; i < byteChars.length; i++) byteNumbers[i] = byteChars.charCodeAt(i);
    const blob = new Blob([new Uint8Array(byteNumbers)], { type: mime || "application/octet-stream" });
    const url = URL.createObjectURL(blob);
    const a = document.createElement("a");
    a.href = url;
    a.download = filename || "download";
    a.click();
    setTimeout(() => URL.revokeObjectURL(url), 2000);
  }
})();

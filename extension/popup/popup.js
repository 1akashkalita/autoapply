/**
 * Popup script for the Job Autofill extension.
 * Manages the popup UI: profile display, preview/fill triggers, result logs.
 */

(function () {
  // DOM elements
  const statusBadge = document.getElementById("statusBadge");
  const profileSummary = document.getElementById("profileSummary");
  const openOptions = document.getElementById("openOptions");
  const btnPreview = document.getElementById("btnPreview");
  const btnFill = document.getElementById("btnFill");
  const previewSection = document.getElementById("previewSection");
  const previewStats = document.getElementById("previewStats");
  const previewList = document.getElementById("previewList");
  const btnClearPreview = document.getElementById("btnClearPreview");
  const btnConfirmFill = document.getElementById("btnConfirmFill");
  const resultsSection = document.getElementById("resultsSection");
  const resultStats = document.getElementById("resultStats");
  const resultList = document.getElementById("resultList");
  const adapterNameEl = document.getElementById("adapterName");
  const llmStatusEl = document.getElementById("llmStatus");

  // Documents UI
  const jobContextLine = document.getElementById("jobContextLine");
  const docsStatus = document.getElementById("docsStatus");
  const docsList = document.getElementById("docsList");
  const uploadEditedResume = document.getElementById("uploadEditedResume");
  const uploadCoverLetterFile = document.getElementById("uploadCoverLetterFile");
  const coverLetterText = document.getElementById("coverLetterText");
  const btnSaveCoverLetterText = document.getElementById("btnSaveCoverLetterText");

  // AI Optimize UI
  const btnAiOptimize = document.getElementById("btnAiOptimize");
  const aiSection = document.getElementById("aiSection");
  const aiStatus = document.getElementById("aiStatus");
  const aiGapSection = document.getElementById("aiGapSection");
  const aiGapList = document.getElementById("aiGapList");
  const aiDiffSection = document.getElementById("aiDiffSection");
  const aiResumeDiff = document.getElementById("aiResumeDiff");
  const aiCoverLetterSection = document.getElementById("aiCoverLetterSection");
  const aiCoverLetter = document.getElementById("aiCoverLetter");

  let currentMappings = null;
  let currentJobKey = null;
  let currentJobMeta = null;
  let lastAiResult = null;

  // ---- Init ----

  init();

  async function init() {
    // Load profile and settings
    const settings = await sendBg({ action: "getSettings" });
    if (settings.ok && settings.profile) {
      renderProfile(settings.profile);
      btnPreview.disabled = false;
      btnFill.disabled = false;
    } else {
      profileSummary.innerHTML = '<p class="placeholder-text">No profile configured. <a href="#" id="setupLink">Set up now</a></p>';
      const setupLink = document.getElementById("setupLink");
      if (setupLink) {
        setupLink.addEventListener("click", (e) => { e.preventDefault(); openOptionsPage(); });
      }
    }

    // Show LLM status and enable AI Optimize if available
    if (settings.ok) {
      const llmReady = settings.llmEnabled && settings.apiKey;
      llmStatusEl.textContent = llmReady ? "LLM: On" : "LLM: Off";
      if (llmReady && settings.resume) {
        btnAiOptimize.disabled = false;
        btnAiOptimize.title = "Optimize resume & generate cover letter for this job";
      } else if (llmReady && !settings.resume) {
        btnAiOptimize.title = "Upload resume JSON in Options to use AI Optimize";
      }
    }

    // Check content script connectivity
    try {
      const [tab] = await chrome.tabs.query({ active: true, currentWindow: true });
      if (tab && tab.id) {
        const resp = await chrome.tabs.sendMessage(tab.id, { action: "ping" });
        if (resp && resp.ok) {
          setStatus("Ready", "neutral");
        }
      }
    } catch (e) {
      setStatus("No page access", "warning");
      btnPreview.disabled = true;
      btnFill.disabled = true;
      btnAiOptimize.disabled = true;
    }

    // Load job context + docs list (best-effort)
    await refreshJobContextAndDocs();
  }

  // ---- Event Listeners ----

  openOptions.addEventListener("click", (e) => {
    e.preventDefault();
    openOptionsPage();
  });

  btnPreview.addEventListener("click", async () => {
    setStatus("Scanning...", "active");
    btnPreview.disabled = true;
    btnFill.disabled = true;

    const result = await sendBg({ action: "startAutofill", mode: "preview" });

    if (result.ok) {
      currentMappings = result.mappings;
      renderPreview(result);
      setStatus("Preview", "active");
      if (result.adapterName) {
        adapterNameEl.textContent = "Adapter: " + result.adapterName;
      }
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

    btnPreview.disabled = false;
    btnFill.disabled = false;
  });

  btnFill.addEventListener("click", async () => {
    setStatus("Filling...", "active");
    btnFill.disabled = true;
    btnPreview.disabled = true;

    const result = await sendBg({ action: "startAutofill", mode: "fill" });

    if (result.ok) {
      renderResults(result);
      setStatus("Filled", "success");
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

    btnFill.disabled = false;
    btnPreview.disabled = false;
  });

  btnClearPreview.addEventListener("click", async () => {
    const [tab] = await chrome.tabs.query({ active: true, currentWindow: true });
    if (tab && tab.id) {
      try { await chrome.tabs.sendMessage(tab.id, { action: "clearPreview" }); } catch (e) { /* ignore */ }
    }
    previewSection.classList.add("hidden");
    currentMappings = null;
    setStatus("Ready", "neutral");
  });

  btnConfirmFill.addEventListener("click", async () => {
    if (!currentMappings) return;
    setStatus("Filling...", "active");
    btnConfirmFill.disabled = true;

    const result = await sendBg({ action: "confirmFill", mappings: currentMappings });

    if (result.ok) {
      previewSection.classList.add("hidden");
      renderResults(result);
      setStatus("Filled", "success");
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

    btnConfirmFill.disabled = false;
  });

  // Documents: uploads & save text
  if (uploadEditedResume) {
    uploadEditedResume.addEventListener("change", async (e) => {
      const file = e.target.files && e.target.files[0];
      uploadEditedResume.value = "";
      if (!file) return;
      await saveDocFromFile("editedResume", file);
    });
  }

  if (uploadCoverLetterFile) {
    uploadCoverLetterFile.addEventListener("change", async (e) => {
      const file = e.target.files && e.target.files[0];
      uploadCoverLetterFile.value = "";
      if (!file) return;
      await saveDocFromFile("coverLetter", file);
    });
  }

  if (btnSaveCoverLetterText) {
    btnSaveCoverLetterText.addEventListener("click", async () => {
      const text = (coverLetterText && coverLetterText.value) ? coverLetterText.value.trim() : "";
      if (!text) {
        setDocsStatus("Paste cover letter text first.", false);
        return;
      }
      if (!currentJobKey) {
        setDocsStatus("No job detected for this tab yet.", false);
        return;
      }
      const doc = {
        id: (window.crypto && window.crypto.randomUUID) ? window.crypto.randomUUID() : ("doc_" + Date.now()),
        name: "cover-letter.txt",
        mime: "text/plain",
        size: text.length,
        createdAt: new Date().toISOString(),
        dataBase64: base64FromUtf8(text),
      };
      const resp = await sendBg({
        action: "saveJobDocument",
        jobKey: currentJobKey,
        jobMeta: currentJobMeta,
        docType: "coverLetter",
        doc,
      });
      if (resp.ok) {
        coverLetterText.value = "";
        setDocsStatus("Cover letter saved.", true);
        await refreshDocsList();
      } else {
        setDocsStatus(resp.error || "Save failed.", false);
      }
    });
  }

  if (docsList) {
    docsList.addEventListener("click", async (e) => {
      const btn = e.target && e.target.closest ? e.target.closest("button[data-action]") : null;
      if (!btn) return;
      const action = btn.getAttribute("data-action");
      const docType = btn.getAttribute("data-doc-type");
      const id = btn.getAttribute("data-id");
      if (!action || !docType || !id) return;

      if (action === "download") {
        await downloadJobDoc(docType, id);
      } else if (action === "delete") {
        const resp = await sendBg({
          action: "deleteJobDocument",
          jobKey: currentJobKey,
          docType: docType,
          id: id,
        });
        if (resp.ok) {
          setDocsStatus("Deleted.", true);
          await refreshDocsList();
        } else {
          setDocsStatus(resp.error || "Delete failed.", false);
        }
      }
    });
  }

  // ---- AI Optimize ----

  if (btnAiOptimize) {
    btnAiOptimize.addEventListener("click", async () => {
      setStatus("Optimizing...", "active");
      btnAiOptimize.disabled = true;
      aiSection.classList.remove("hidden");
      aiGapSection.classList.add("hidden");
      aiDiffSection.classList.add("hidden");
      aiCoverLetterSection.classList.add("hidden");
      aiStatus.innerHTML = '<span class="ai-spinner"></span> Extracting job description...';
      aiStatus.className = "ai-status ai-status-loading";

      // 1. Extract JD from current page
      let jdResult;
      try {
        const [tab] = await chrome.tabs.query({ active: true, currentWindow: true });
        if (!tab || !tab.id) {
          showAiError("No active tab found.");
          return;
        }
        jdResult = await chrome.tabs.sendMessage(tab.id, { action: "extractJobDescription" });
      } catch (e) {
        showAiError("Could not reach content script. Try refreshing the page.");
        return;
      }

      if (!jdResult || !jdResult.ok || jdResult.wordCount < 50) {
        showAiError("Could not extract a job description from this page (found " + (jdResult ? jdResult.wordCount : 0) + " words). Try a page with a full job posting.");
        return;
      }

      aiStatus.innerHTML = '<span class="ai-spinner"></span> Analyzing job & tailoring resume... (this takes 15-30s)';

      // 2. Ensure we have job context
      if (!currentJobKey) {
        try {
          const [tab] = await chrome.tabs.query({ active: true, currentWindow: true });
          if (tab && tab.id) {
            const ctx = await chrome.tabs.sendMessage(tab.id, { action: "getJobContext" });
            if (ctx && ctx.ok) {
              currentJobKey = ctx.jobKey;
              currentJobMeta = ctx.jobMeta;
              renderJobContextLine();
            }
          }
        } catch (e) { /* continue anyway */ }
      }

      // 3. Call background to generate documents
      let result;
      try {
        result = await sendBg({
          action: "generateAiDocuments",
          jdText: jdResult.jdText,
          jobKey: currentJobKey,
          jobMeta: currentJobMeta,
        });
      } catch (e) {
        showAiError("AI generation failed: " + String(e));
        return;
      }

      if (!result || !result.ok) {
        showAiError(result ? result.error : "No response from background.");
        return;
      }

      lastAiResult = result;

      // 4. Render results
      renderAiResults(result);

      // 5. Auto-download + save to storage
      await saveAndDownloadAiDocs(result);

      setStatus("Optimized", "success");
      btnAiOptimize.disabled = false;
    });
  }

  function showAiError(message) {
    aiStatus.textContent = message;
    aiStatus.className = "ai-status ai-status-error";
    btnAiOptimize.disabled = false;
    setStatus("Error", "error");
  }

  function renderAiResults(result) {
    aiStatus.textContent = "Done! Resume and cover letter generated.";
    aiStatus.className = "ai-status ai-status-success";

    // Requirements gap list
    const gaps = result.requirementsGaps || [];
    if (gaps.length > 0) {
      aiGapSection.classList.remove("hidden");
      let gapHtml = "";
      for (const gap of gaps) {
        let statusClass = "gap-met";
        let statusLabel = "Met";
        if (gap.status === "partially_met") { statusClass = "gap-partial"; statusLabel = "Partial"; }
        else if (gap.status === "not_met") { statusClass = "gap-missing"; statusLabel = "Not Met"; }
        else if (gap.status === "filled_by_generated_project") { statusClass = "gap-generated"; statusLabel = "Generated"; }

        gapHtml +=
          '<div class="gap-row ' + statusClass + '">' +
          '<span class="gap-status-badge">' + escHtml(statusLabel) + "</span>" +
          '<span class="gap-text">' + escHtml(gap.requirement || "") + "</span>" +
          (gap.notes ? '<span class="gap-notes">' + escHtml(gap.notes) + "</span>" : "") +
          "</div>";
      }
      aiGapList.innerHTML = gapHtml;
    }

    // Resume diff
    const diff = result.diff || [];
    if (diff.length > 0) {
      aiDiffSection.classList.remove("hidden");
      let diffHtml = "";
      for (const entry of diff) {
        let headerClass = entry.generated ? "diff-header diff-generated-header" : "diff-header";
        diffHtml += '<div class="' + headerClass + '">' + escHtml(entry.header);
        if (entry.generated) {
          diffHtml += ' <span class="diff-generated-badge">Generated &mdash; review before submitting</span>';
        }
        diffHtml += "</div>";

        for (const b of entry.bullets) {
          if (b.type === "changed") {
            diffHtml +=
              '<div class="diff-line diff-removed">&minus; ' + escHtml(truncate(b.origText, 120)) + "</div>" +
              '<div class="diff-line diff-added">&plus; ' + escHtml(truncate(b.newText, 120)) + "</div>";
          } else if (b.type === "added") {
            diffHtml += '<div class="diff-line diff-added">&plus; ' + escHtml(truncate(b.newText, 120)) + "</div>";
          }
        }
      }
      aiResumeDiff.innerHTML = diffHtml;
    }

    // Cover letter
    if (result.coverLetterText) {
      aiCoverLetterSection.classList.remove("hidden");
      aiCoverLetter.value = result.coverLetterText;
    }
  }

  async function saveAndDownloadAiDocs(result) {
    const JA = window.JobAutofill || {};
    const settings = await sendBg({ action: "getSettings" });
    const personal = (settings.ok && settings.resume && settings.resume.personal) ? settings.resume.personal : {};
    const now = new Date().toISOString();

    // Build HTML for resume
    if (result.tailoredResume && JA.buildResumeHtml) {
      const resumeHtml = JA.buildResumeHtml(result.tailoredResume);
      const resumeB64 = base64FromUtf8(resumeHtml);

      // Download to user's computer
      downloadHtmlAsFile(resumeHtml, buildAiFilename("tailored-resume", "html"));

      // Save to job bucket
      if (currentJobKey) {
        const doc = {
          id: genId(),
          name: buildAiFilename("tailored-resume", "html"),
          mime: "text/html",
          size: resumeHtml.length,
          createdAt: now,
          dataBase64: resumeB64,
        };
        await sendBg({
          action: "saveJobDocument",
          jobKey: currentJobKey,
          jobMeta: currentJobMeta,
          docType: "editedResume",
          doc,
        });
      }
    }

    // Build HTML for cover letter
    if (result.coverLetterText && JA.buildCoverLetterHtml) {
      const clHtml = JA.buildCoverLetterHtml(result.coverLetterText, currentJobMeta, personal);
      const clB64 = base64FromUtf8(clHtml);

      // Download to user's computer
      downloadHtmlAsFile(clHtml, buildAiFilename("cover-letter", "html"));

      // Save to job bucket
      if (currentJobKey) {
        const doc = {
          id: genId(),
          name: buildAiFilename("cover-letter", "html"),
          mime: "text/html",
          size: clHtml.length,
          createdAt: now,
          dataBase64: clB64,
        };
        await sendBg({
          action: "saveJobDocument",
          jobKey: currentJobKey,
          jobMeta: currentJobMeta,
          docType: "coverLetter",
          doc,
        });
      }
    }

    await refreshDocsList();
  }

  function downloadHtmlAsFile(htmlString, filename) {
    const blob = new Blob([htmlString], { type: "text/html" });
    const url = URL.createObjectURL(blob);
    const a = document.createElement("a");
    a.href = url;
    a.download = filename;
    a.click();
    setTimeout(() => URL.revokeObjectURL(url), 2000);
  }

  function buildAiFilename(kind, ext) {
    const company = safeFilePart(currentJobMeta && currentJobMeta.company);
    const title = safeFilePart(currentJobMeta && currentJobMeta.title);
    const date = isoDatePart(new Date().toISOString());
    const parts = [company, title, date, kind].filter(Boolean);
    const base = parts.length > 1 ? parts.join("-") : (date + "-" + kind);
    return base + "." + ext;
  }

  function genId() {
    return (window.crypto && window.crypto.randomUUID) ? window.crypto.randomUUID() : ("doc_" + Date.now() + "_" + Math.random().toString(36).slice(2, 8));
  }

  // ---- Render helpers ----

  function renderProfile(profile) {
    const name = [profile.first_name, profile.last_name].filter(Boolean).join(" ") || "No name";
    const details = [profile.email, profile.phone].filter(Boolean).join(" | ");
    profileSummary.innerHTML =
      '<div class="name">' + escHtml(name) + "</div>" +
      '<div class="detail">' + escHtml(details || "No contact info") + "</div>";
  }

  function renderPreview(result) {
    previewSection.classList.remove("hidden");
    resultsSection.classList.add("hidden");

    const mappings = result.mappings || [];
    const willFill = mappings.filter((m) => m.confidence >= 0.8 && m.value);
    const willSkip = mappings.filter((m) => m.confidence < 0.8 || !m.value);

    previewStats.innerHTML =
      '<span class="stat"><span class="stat-dot stat-dot-total"></span> ' + result.fieldCount + " fields</span>" +
      '<span class="stat"><span class="stat-dot stat-dot-fill"></span> ' + willFill.length + " to fill</span>" +
      '<span class="stat"><span class="stat-dot stat-dot-skip"></span> ' + willSkip.length + " skipped</span>";

    // Nav button warning
    let html = "";
    if (result.navButton && result.navButton.type === "submit") {
      html += '<div class="warning-banner">Submit button detected: "' +
        escHtml(result.navButton.text) + '". This extension will NOT auto-submit.</div>';
    }

    for (const m of willFill) {
      html += '<div class="result-item">' +
        '<span class="result-field" title="' + escHtml(m.field_label) + '">' + escHtml(truncate(m.field_label, 30)) + "</span>" +
        '<span class="result-value" title="' + escHtml(m.value) + '">' + escHtml(truncate(m.value, 30)) + "</span>" +
        "</div>";
    }
    for (const m of willSkip) {
      html += '<div class="result-item">' +
        '<span class="result-field" title="' + escHtml(m.field_label) + '">' + escHtml(truncate(m.field_label, 30)) + "</span>" +
        '<span class="result-value skipped">' + escHtml(m.reason || "skipped") + "</span>" +
        "</div>";
    }

    previewList.innerHTML = html;
  }

  function renderResults(result) {
    resultsSection.classList.remove("hidden");
    previewSection.classList.add("hidden");

    const filled = result.filled || [];
    const skipped = result.skipped || [];

    resultStats.innerHTML =
      '<span class="stat"><span class="stat-dot stat-dot-fill"></span> ' + filled.length + " filled</span>" +
      '<span class="stat"><span class="stat-dot stat-dot-skip"></span> ' + skipped.length + " skipped</span>";

    let html = "";
    for (const f of filled) {
      html += '<div class="result-item">' +
        '<span class="result-field" title="' + escHtml(f.field) + '">' + escHtml(truncate(f.field, 30)) + "</span>" +
        '<span class="result-value" title="' + escHtml(f.value) + '">' + escHtml(truncate(f.value, 30)) + "</span>" +
        "</div>";
    }
    for (const s of skipped) {
      html += '<div class="result-item">' +
        '<span class="result-field" title="' + escHtml(s.field) + '">' + escHtml(truncate(s.field, 30)) + "</span>" +
        '<span class="result-value skipped">' + escHtml(s.reason || "skipped") + "</span>" +
        "</div>";
    }

    resultList.innerHTML = html;
  }

  function showError(message) {
    resultsSection.classList.remove("hidden");
    previewSection.classList.add("hidden");
    resultStats.innerHTML = "";
    resultList.innerHTML = '<div class="result-item"><span class="result-value skipped">' +
      escHtml(message || "Unknown error") + "</span></div>";
  }

  // ---- Utilities ----

  function setStatus(text, type) {
    statusBadge.textContent = text;
    statusBadge.className = "badge badge-" + type;
  }

  function sendBg(msg) {
    return new Promise((resolve) => {
      chrome.runtime.sendMessage(msg, (resp) => {
        resolve(resp || { ok: false, error: "No response from background" });
      });
    });
  }

  function openOptionsPage() {
    chrome.runtime.openOptionsPage();
  }

  async function refreshJobContextAndDocs() {
    try {
      const [tab] = await chrome.tabs.query({ active: true, currentWindow: true });
      if (!tab || !tab.id) return;
      const resp = await chrome.tabs.sendMessage(tab.id, { action: "getJobContext" });
      if (resp && resp.ok && resp.jobKey) {
        currentJobKey = resp.jobKey;
        currentJobMeta = resp.jobMeta || null;
        renderJobContextLine();
        await refreshDocsList();
      } else {
        currentJobKey = null;
        currentJobMeta = null;
        renderJobContextLine();
        renderDocsList(null);
      }
    } catch (e) {
      // Content script not reachable
      currentJobKey = null;
      currentJobMeta = null;
      renderJobContextLine();
      renderDocsList(null);
    }
  }

  function renderJobContextLine() {
    if (!jobContextLine) return;
    if (!currentJobKey) {
      jobContextLine.textContent = "No job detected on this tab yet.";
      if (uploadEditedResume) uploadEditedResume.disabled = true;
      if (uploadCoverLetterFile) uploadCoverLetterFile.disabled = true;
      if (btnSaveCoverLetterText) btnSaveCoverLetterText.disabled = true;
      return;
    }
    const company = (currentJobMeta && currentJobMeta.company) ? currentJobMeta.company : "";
    const title = (currentJobMeta && currentJobMeta.title) ? currentJobMeta.title : "";
    const parts = [company, title].filter(Boolean);
    jobContextLine.textContent = parts.length ? parts.join(" — ") : "Job key: " + currentJobKey;
    if (uploadEditedResume) uploadEditedResume.disabled = false;
    if (uploadCoverLetterFile) uploadCoverLetterFile.disabled = false;
    if (btnSaveCoverLetterText) btnSaveCoverLetterText.disabled = false;
  }

  function setDocsStatus(text, ok) {
    if (!docsStatus) return;
    docsStatus.textContent = text || "";
    docsStatus.style.color = ok ? "#065f46" : "#991b1b";
  }

  async function refreshDocsList() {
    if (!currentJobKey) {
      renderDocsList(null);
      return;
    }
    const resp = await sendBg({ action: "getJobDocuments", jobKey: currentJobKey });
    if (!resp.ok) {
      setDocsStatus(resp.error || "Failed to load documents.", false);
      renderDocsList(null);
      return;
    }
    setDocsStatus("", true);
    renderDocsList(resp.bucket);
  }

  function renderDocsList(bucket) {
    if (!docsList) return;
    if (!currentJobKey) {
      docsList.innerHTML = '<div class="result-item"><span class="result-value skipped">Open a job application tab to save documents.</span></div>';
      return;
    }
    if (!bucket) {
      docsList.innerHTML = '<div class="result-item"><span class="result-value skipped">No documents saved for this job yet.</span></div>';
      return;
    }

    const edited = Array.isArray(bucket.editedResumes) ? bucket.editedResumes : [];
    const covers = Array.isArray(bucket.coverLetters) ? bucket.coverLetters : [];

    let html = "";
    html += '<div class="result-item"><span class="result-field">Edited resumes</span><span class="result-value">' + edited.length + "</span></div>";
    for (const d of edited) {
      html += renderDocRow("editedResume", d);
    }
    html += '<div class="result-item"><span class="result-field">Cover letters</span><span class="result-value">' + covers.length + "</span></div>";
    for (const d2 of covers) {
      html += renderDocRow("coverLetter", d2);
    }
    docsList.innerHTML = html;
  }

  function renderDocRow(docType, d) {
    const label = d && d.name ? d.name : "(unnamed)";
    const createdAt = d && d.createdAt ? new Date(d.createdAt).toLocaleString() : "";
    const right = createdAt ? createdAt : "";
    const id = d && d.id ? d.id : "";
    return (
      '<div class="result-item">' +
      '<span class="result-field" title="' + escHtml(label) + '">' + escHtml(truncate(label, 22)) + "</span>" +
      '<span class="result-value" style="display:flex;gap:6px;align-items:center;justify-content:flex-end;">' +
      '<span class="text-muted" style="max-width:110px;overflow:hidden;text-overflow:ellipsis;white-space:nowrap;">' + escHtml(right) + "</span>" +
      '<button class="btn-text" data-action="download" data-doc-type="' + docType + '" data-id="' + escHtml(id) + '">Download</button>' +
      '<button class="btn-text" data-action="delete" data-doc-type="' + docType + '" data-id="' + escHtml(id) + '">Delete</button>' +
      "</span>" +
      "</div>"
    );
  }

  async function saveDocFromFile(docType, file) {
    if (!currentJobKey) {
      setDocsStatus("No job detected for this tab yet.", false);
      return;
    }
    if (!file) return;

    if (docType === "editedResume" && file.type !== "application/pdf") {
      setDocsStatus("Edited resume must be a PDF.", false);
      return;
    }
    if (docType === "coverLetter" && file.type !== "application/pdf") {
      setDocsStatus("Cover letter file must be a PDF.", false);
      return;
    }

    try {
      setDocsStatus("Saving...", true);
      const dataBase64 = await readFileAsBase64(file);
      const doc = {
        id: (window.crypto && window.crypto.randomUUID) ? window.crypto.randomUUID() : ("doc_" + Date.now()),
        name: file.name || (docType === "editedResume" ? "edited-resume.pdf" : "cover-letter.pdf"),
        mime: file.type || "application/pdf",
        size: file.size || 0,
        createdAt: new Date().toISOString(),
        dataBase64,
      };

      const resp = await sendBg({
        action: "saveJobDocument",
        jobKey: currentJobKey,
        jobMeta: currentJobMeta,
        docType: docType,
        doc,
      });
      if (resp.ok) {
        setDocsStatus("Saved.", true);
        await refreshDocsList();
      } else {
        setDocsStatus(resp.error || "Save failed.", false);
      }
    } catch (e) {
      setDocsStatus("Save failed: " + String(e), false);
    }
  }

  async function downloadJobDoc(docType, id) {
    if (!currentJobKey) return;
    const resp = await sendBg({ action: "getJobDocuments", jobKey: currentJobKey });
    if (!resp.ok || !resp.bucket) {
      setDocsStatus(resp.error || "Failed to load documents.", false);
      return;
    }
    const bucket = resp.bucket;
    const arr = docType === "editedResume" ? (bucket.editedResumes || []) : (bucket.coverLetters || []);
    const doc = arr.find((d) => d && d.id === id);
    if (!doc || !doc.dataBase64) {
      setDocsStatus("Document not found.", false);
      return;
    }
    const filename = buildJobFilename(currentJobMeta, docType, doc);
    downloadBase64(doc.dataBase64, filename, doc.mime || "application/octet-stream");
    setDocsStatus("Download started.", true);
  }

  function buildJobFilename(jobMeta, docType, doc) {
    const company = safeFilePart(jobMeta && jobMeta.company);
    const title = safeFilePart(jobMeta && jobMeta.title);
    const date = isoDatePart(doc && doc.createdAt);
    const kind = docType === "editedResume" ? "edited-resume" : "cover-letter";
    const ext = inferExt(doc && doc.name, doc && doc.mime);
    const parts = [company, title, date, kind].filter(Boolean);
    const base = parts.length ? parts.join("-") : ("job-" + (date || "document") + "-" + kind);
    return base + "." + ext;
  }

  function safeFilePart(s) {
    return String(s || "")
      .trim()
      .replace(/[\/\\?%*:|"<>]/g, "")
      .replace(/\s+/g, "-")
      .slice(0, 40);
  }

  function isoDatePart(iso) {
    if (!iso) return "";
    const d = new Date(iso);
    if (isNaN(d.getTime())) return "";
    const yyyy = d.getFullYear();
    const mm = String(d.getMonth() + 1).padStart(2, "0");
    const dd = String(d.getDate()).padStart(2, "0");
    return "" + yyyy + mm + dd;
  }

  function inferExt(name, mime) {
    const n = String(name || "").toLowerCase();
    if (n.endsWith(".pdf")) return "pdf";
    if (n.endsWith(".txt")) return "txt";
    if (mime === "application/pdf") return "pdf";
    if (mime === "text/plain") return "txt";
    return "bin";
  }

  function readFileAsBase64(file) {
    return new Promise((resolve, reject) => {
      const reader = new FileReader();
      reader.onerror = () => reject(new Error("Failed to read file"));
      reader.onload = () => {
        const arr = reader.result; // ArrayBuffer
        resolve(arrayBufferToBase64(arr));
      };
      reader.readAsArrayBuffer(file);
    });
  }

  function arrayBufferToBase64(arrayBuffer) {
    const bytes = new Uint8Array(arrayBuffer);
    let binary = "";
    const chunkSize = 0x8000;
    for (let i = 0; i < bytes.length; i += chunkSize) {
      binary += String.fromCharCode.apply(null, bytes.subarray(i, i + chunkSize));
    }
    return btoa(binary);
  }

  function base64FromUtf8(text) {
    // encodeURIComponent trick to get UTF-8 bytes into btoa safely
    return btoa(unescape(encodeURIComponent(String(text || ""))));
  }

  function downloadBase64(base64, filename, mime) {
    const bytes = base64ToBytes(base64);
    const blob = new Blob([bytes], { type: mime || "application/octet-stream" });
    const url = URL.createObjectURL(blob);
    const a = document.createElement("a");
    a.href = url;
    a.download = filename || "download";
    a.click();
    setTimeout(() => URL.revokeObjectURL(url), 2000);
  }

  function base64ToBytes(base64) {
    const byteChars = atob(base64);
    const byteNumbers = new Array(byteChars.length);
    for (let i = 0; i < byteChars.length; i++) byteNumbers[i] = byteChars.charCodeAt(i);
    return new Uint8Array(byteNumbers);
  }

  function escHtml(str) {
    const div = document.createElement("div");
    div.textContent = str;
    return div.innerHTML;
  }

  function truncate(str, len) {
    if (!str) return "";
    return str.length > len ? str.substring(0, len - 3) + "..." : str;
  }
})();

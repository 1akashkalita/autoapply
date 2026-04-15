/**
 * Tab-based UI script for the Job Autofill extension.
 * Opened as a new tab per job page; reads originTabId from URL params.
 */

(function () {
  // ---- DOM refs ----
  const mainContainer    = document.getElementById("mainContainer");
  const statusBadge      = document.getElementById("statusBadge");
  const btnCollapse      = document.getElementById("btnCollapse");
  const profileSummary   = document.getElementById("profileSummary");
  const openOptions      = document.getElementById("openOptions");
  const btnPreview       = document.getElementById("btnPreview");
  const btnFill          = document.getElementById("btnFill");
  const previewSection   = document.getElementById("previewSection");
  const previewStats     = document.getElementById("previewStats");
  const previewList      = document.getElementById("previewList");
  const btnClearPreview  = document.getElementById("btnClearPreview");
  const btnConfirmFill   = document.getElementById("btnConfirmFill");
  const resultsSection   = document.getElementById("resultsSection");
  const resultStats      = document.getElementById("resultStats");
  const resultList       = document.getElementById("resultList");
  const adapterNameEl    = document.getElementById("adapterName");
  const llmStatusEl      = document.getElementById("llmStatus");

  // Documents UI
  const docsToggle           = document.getElementById("docsToggle");
  const docsArrow            = document.getElementById("docsArrow");
  const docsBody             = document.getElementById("docsBody");
  const jobContextLine       = document.getElementById("jobContextLine");
  const docsStatus           = document.getElementById("docsStatus");
  const docsList             = document.getElementById("docsList");
  const uploadEditedResume   = document.getElementById("uploadEditedResume");
  const uploadCoverLetterFile= document.getElementById("uploadCoverLetterFile");
  const coverLetterText      = document.getElementById("coverLetterText");
  const btnSaveCoverLetterText = document.getElementById("btnSaveCoverLetterText");

  // AI Optimize UI
  const btnAiOptimize        = document.getElementById("btnAiOptimize");
  const aiSection            = document.getElementById("aiSection");
  const aiStatus             = document.getElementById("aiStatus");
  const aiOptimizeSummary    = document.getElementById("aiOptimizeSummary");
  const aiGapSection         = document.getElementById("aiGapSection");
  const aiGapList            = document.getElementById("aiGapList");
  const aiDiffSection        = document.getElementById("aiDiffSection");
  const aiResumeDiff         = document.getElementById("aiResumeDiff");
  const aiCoverLetterSection = document.getElementById("aiCoverLetterSection");
  const aiCoverLetter        = document.getElementById("aiCoverLetter");

  // AI Preview (Phase 1) UI
  const aiPreviewSection   = document.getElementById("aiPreviewSection");
  const aiPreviewStatus    = document.getElementById("aiPreviewStatus");
  const aiPreviewContent   = document.getElementById("aiPreviewContent");
  const btnConfirmOptimize = document.getElementById("btnConfirmOptimize");
  const btnCancelAiPreview = document.getElementById("btnCancelAiPreview");

  // Standalone Cover Letter UI
  const btnCoverLetter         = document.getElementById("btnCoverLetter");
  const coverLetterSection     = document.getElementById("coverLetterSection");
  const coverLetterStatus      = document.getElementById("coverLetterStatus");
  const coverLetterOutput      = document.getElementById("coverLetterOutput");
  const standaloneCoverLetter  = document.getElementById("standaloneCoverLetter");
  const btnDownloadCoverLetter = document.getElementById("btnDownloadCoverLetter");
  const btnCancelCoverLetter   = document.getElementById("btnCancelCoverLetter");

  let currentMappings    = null;
  let currentJobKey      = null;
  let currentJobMeta     = null;
  let lastAiResult       = null;
  let cachedJdAnalysis   = null;
  let cachedJdText       = null;
  let lastCoverLetterText= null;

  // Tab ID of the job page that spawned this extension tab
  var originTabId = (function () {
    var params = new URLSearchParams(window.location.search);
    var id = parseInt(params.get("originTabId"), 10);
    return isNaN(id) ? null : id;
  })();

  function getOriginTabId() {
    return new Promise(function (resolve) {
      if (originTabId) return resolve(originTabId);
      chrome.tabs.query({ active: true, currentWindow: true }, function (tabs) {
        resolve(tabs && tabs[0] ? tabs[0].id : null);
      });
    });
  }

  // ---- Init ----

  init();

  async function init() {
    const settings = await sendBg({ action: "getSettings" });
    if (settings.ok && settings.profile) {
      renderProfile(settings.profile);
      btnPreview.disabled = false;
      btnFill.disabled = false;
    } else {
      profileSummary.innerHTML =
        '<p class="placeholder-text">No profile configured. <a href="#" id="setupLink">Set up now</a></p>';
      const setupLink = document.getElementById("setupLink");
      if (setupLink) {
        setupLink.addEventListener("click", function (e) {
          e.preventDefault();
          openOptionsPage();
        });
      }
    }

    if (settings.ok) {
      const llmReady = settings.llmEnabled && settings.apiKey;
      llmStatusEl.textContent = llmReady ? "LLM: On" : "LLM: Off";
      if (llmReady && settings.resume) {
        btnAiOptimize.disabled = false;
        btnAiOptimize.title = "Optimize resume & generate cover letter for this job";
        btnCoverLetter.disabled = false;
        btnCoverLetter.title = "Generate a cover letter for this job";
      } else if (llmReady && !settings.resume) {
        btnAiOptimize.title = "Upload resume JSON in Options to use AI features";
        btnCoverLetter.title = "Upload resume JSON in Options to generate a cover letter";
      }
    }

    try {
      var tabId = await getOriginTabId();
      if (tabId) {
        const resp = await chrome.tabs.sendMessage(tabId, { action: "ping" });
        if (resp && resp.ok) {
          setStatus("Ready", "neutral");
        }
      }
    } catch (e) {
      setStatus("No page access", "warning");
      btnPreview.disabled = true;
      btnFill.disabled = true;
      btnAiOptimize.disabled = true;
      btnCoverLetter.disabled = true;
    }

    await refreshJobContextAndDocs();
  }

  // ---- Collapse / expand ----

  btnCollapse.addEventListener("click", function () {
    const collapsed = mainContainer.classList.toggle("collapsed");
    btnCollapse.textContent = collapsed ? "⟶ Show" : "⟵ Hide";
    btnCollapse.title = collapsed ? "Expand panel" : "Collapse panel";
  });

  // ---- Event Listeners ----

  openOptions.addEventListener("click", function (e) {
    e.preventDefault();
    openOptionsPage();
  });

  if (docsToggle) {
    docsToggle.addEventListener("click", function () {
      var isOpen = docsBody.classList.toggle("open");
      docsArrow.classList.toggle("open", isOpen);
    });
  }

  btnPreview.addEventListener("click", async function () {
    if (!await assertContentScript()) return;
    setStatus("🔵 Scanning…", "active");
    btnPreview.disabled = true;
    btnFill.disabled = true;

    var tabId = await getOriginTabId();
    const result = await sendBg({ action: "startAutofill", mode: "preview", tabId: tabId });

    if (result.ok) {
      currentMappings = result.mappings;
      renderPreview(result);
      setStatus("🟡 Preview", "active");
      if (result.adapterName) adapterNameEl.textContent = "Adapter: " + result.adapterName;
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

  btnFill.addEventListener("click", async function () {
    if (!await assertContentScript()) return;
    setStatus("🔵 Filling…", "active");
    btnFill.disabled = true;
    btnPreview.disabled = true;

    var tabId = await getOriginTabId();
    const result = await sendBg({ action: "startAutofill", mode: "fill", tabId: tabId });

    if (result.ok) {
      renderResults(result);
      setStatus("🟢 Filled", "success");
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

  btnClearPreview.addEventListener("click", async function () {
    var tabId = await getOriginTabId();
    if (tabId) {
      try { await chrome.tabs.sendMessage(tabId, { action: "clearPreview" }); } catch (e) { /* ignore */ }
    }
    previewSection.classList.add("hidden");
    currentMappings = null;
    setStatus("Ready", "neutral");
  });

  btnConfirmFill.addEventListener("click", async function () {
    if (!currentMappings) return;
    setStatus("🔵 Filling…", "active");
    btnConfirmFill.disabled = true;

    var tabId = await getOriginTabId();
    const result = await sendBg({ action: "confirmFill", mappings: currentMappings, tabId: tabId });

    if (result.ok) {
      previewSection.classList.add("hidden");
      renderResults(result);
      setStatus("🟢 Filled", "success");
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
    uploadEditedResume.addEventListener("change", async function (e) {
      const file = e.target.files && e.target.files[0];
      uploadEditedResume.value = "";
      if (!file) return;
      await saveDocFromFile("editedResume", file);
    });
  }

  if (uploadCoverLetterFile) {
    uploadCoverLetterFile.addEventListener("change", async function (e) {
      const file = e.target.files && e.target.files[0];
      uploadCoverLetterFile.value = "";
      if (!file) return;
      await saveDocFromFile("coverLetter", file);
    });
  }

  if (btnSaveCoverLetterText) {
    btnSaveCoverLetterText.addEventListener("click", async function () {
      const text = (coverLetterText && coverLetterText.value) ? coverLetterText.value.trim() : "";
      if (!text) { setDocsStatus("Paste cover letter text first.", false); return; }
      if (!currentJobKey) { setDocsStatus("No job detected for this tab yet.", false); return; }
      const JA = window.JobAutofill || {};
      const settings = await sendBg({ action: "getSettings" });
      const personal = (settings.ok && settings.resume && settings.resume.personal) ? settings.resume.personal : {};
      const clHtml = JA.buildCoverLetterHtml
        ? JA.buildCoverLetterHtml(text, currentJobMeta, personal)
        : "<pre>" + escHtml(text) + "</pre>";
      let doc;
      try {
        doc = await JA.renderPdfFromHtml(clHtml, buildAiFilename("cover-letter", "pdf"));
      } catch (err) {
        setDocsStatus("PDF export failed: " + String(err), false);
        return;
      }
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
    docsList.addEventListener("click", async function (e) {
      const btn = e.target && e.target.closest ? e.target.closest("button[data-action]") : null;
      if (!btn) return;
      const action  = btn.getAttribute("data-action");
      const docType = btn.getAttribute("data-doc-type");
      const id      = btn.getAttribute("data-id");
      if (!action || !docType || !id) return;

      if (action === "download") {
        await downloadJobDoc(docType, id);
      } else if (action === "delete") {
        const resp = await sendBg({
          action: "deleteJobDocument",
          jobKey: currentJobKey,
          docType,
          id,
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

  // ---- AI Optimize (Two-Phase) ----

  if (btnAiOptimize) {
    btnAiOptimize.addEventListener("click", async function () {
      if (!await assertContentScript()) return;
      setStatus("🔵 Analyzing…", "active");
      btnAiOptimize.disabled = true;
      aiSection.classList.add("hidden");
      coverLetterSection.classList.add("hidden");
      aiPreviewSection.classList.remove("hidden");
      aiPreviewContent.innerHTML = "";
      btnConfirmOptimize.disabled = true;
      aiPreviewStatus.innerHTML = '<span class="ai-spinner"></span> Extracting job description…';
      aiPreviewStatus.className = "ai-status ai-status-loading";

      var jdResult;
      try {
        var tabId = await getOriginTabId();
        if (!tabId) { showAiPreviewError("No origin tab found."); return; }
        jdResult = await chrome.tabs.sendMessage(tabId, { action: "extractJobDescription" });
      } catch (e) {
        showAiPreviewError("Could not reach content script. Try refreshing the page.");
        return;
      }

      if (!jdResult || !jdResult.ok || jdResult.wordCount < 50) {
        showAiPreviewError(
          "Could not extract a job description from this page (found " +
          (jdResult ? jdResult.wordCount : 0) + " words)."
        );
        return;
      }

      cachedJdText = jdResult.jdText;

      if (!currentJobKey) {
        try {
          var ctxTabId = await getOriginTabId();
          if (ctxTabId) {
            const ctx = await chrome.tabs.sendMessage(ctxTabId, { action: "getJobContext" });
            if (ctx && ctx.ok) {
              currentJobKey = ctx.jobKey;
              currentJobMeta = ctx.jobMeta;
              renderJobContextLine();
            }
          }
        } catch (e) { /* continue */ }
      }

      aiPreviewStatus.innerHTML = '<span class="ai-spinner"></span> Analyzing requirements…';

      var gapResult;
      try {
        gapResult = await sendBg({
          action: "analyzeResumeGaps",
          jdText: cachedJdText,
          jobKey: currentJobKey,
          jobMeta: currentJobMeta,
        });
      } catch (e) {
        showAiPreviewError("Analysis failed: " + String(e));
        return;
      }

      if (!gapResult || !gapResult.ok) {
        showAiPreviewError(gapResult ? gapResult.error : "No response from background.");
        return;
      }

      cachedJdAnalysis = gapResult.jdAnalysis;
      renderAiPreview(gapResult);
      aiPreviewStatus.textContent = "Analysis complete — review before optimizing.";
      aiPreviewStatus.className = "ai-status ai-status-success";
      btnConfirmOptimize.disabled = false;
      setStatus("🔍 Review", "active");
      btnAiOptimize.disabled = false;
    });
  }

  if (btnConfirmOptimize) {
    btnConfirmOptimize.addEventListener("click", async function () {
      if (!cachedJdAnalysis || !cachedJdText) return;
      setStatus("🔵 Optimizing…", "active");
      btnConfirmOptimize.disabled = true;
      aiPreviewSection.classList.add("hidden");
      aiSection.classList.remove("hidden");
      aiOptimizeSummary.classList.add("hidden");
      aiGapSection.classList.add("hidden");
      aiDiffSection.classList.add("hidden");
      aiCoverLetterSection.classList.add("hidden");
      aiStatus.innerHTML = '<span class="ai-spinner"></span> Tailoring resume &amp; cover letter… (15–30s)';
      aiStatus.className = "ai-status ai-status-loading";

      var result;
      try {
        result = await sendBg({
          action: "executeResumeOptimization",
          jdText: cachedJdText,
          jdAnalysis: cachedJdAnalysis,
          jobKey: currentJobKey,
          jobMeta: currentJobMeta,
        });
      } catch (e) {
        showAiError("Optimization failed: " + String(e));
        return;
      }

      if (!result || !result.ok) {
        showAiError(result ? result.error : "No response from background.");
        return;
      }

      lastAiResult = result;
      renderAiResults(result);
      try {
        await saveAndDownloadAiDocs(result);
      } catch (pdfErr) {
        aiStatus.textContent = "Optimization completed, but PDF export failed: " + String(pdfErr);
        aiStatus.className = "ai-status ai-status-error";
      }
      setStatus("🟢 Optimized", "success");
      btnConfirmOptimize.disabled = false;
    });
  }

  if (btnCancelAiPreview) {
    btnCancelAiPreview.addEventListener("click", function () {
      aiPreviewSection.classList.add("hidden");
      cachedJdAnalysis = null;
      cachedJdText = null;
      setStatus("Ready", "neutral");
      btnAiOptimize.disabled = false;
    });
  }

  // ---- Standalone Cover Letter ----

  if (btnCoverLetter) {
    btnCoverLetter.addEventListener("click", async function () {
      if (!await assertContentScript()) return;
      setStatus("🔵 Generating…", "active");
      btnCoverLetter.disabled = true;
      aiPreviewSection.classList.add("hidden");
      aiSection.classList.add("hidden");
      coverLetterSection.classList.remove("hidden");
      coverLetterOutput.classList.add("hidden");
      coverLetterStatus.innerHTML = '<span class="ai-spinner ai-spinner-cover"></span> Extracting job description…';
      coverLetterStatus.className = "ai-status ai-status-loading";

      var jdResult;
      try {
        var tabId = await getOriginTabId();
        if (!tabId) { showCoverLetterError("No origin tab found."); return; }
        jdResult = await chrome.tabs.sendMessage(tabId, { action: "extractJobDescription" });
      } catch (e) {
        showCoverLetterError("Could not reach content script. Try refreshing the page.");
        return;
      }

      if (!jdResult || !jdResult.ok || jdResult.wordCount < 50) {
        showCoverLetterError(
          "Could not extract a job description from this page (found " +
          (jdResult ? jdResult.wordCount : 0) + " words)."
        );
        return;
      }

      if (!currentJobKey) {
        try {
          var ctxTabId = await getOriginTabId();
          if (ctxTabId) {
            const ctx = await chrome.tabs.sendMessage(ctxTabId, { action: "getJobContext" });
            if (ctx && ctx.ok) {
              currentJobKey = ctx.jobKey;
              currentJobMeta = ctx.jobMeta;
              renderJobContextLine();
            }
          }
        } catch (e) { /* continue */ }
      }

      coverLetterStatus.innerHTML = '<span class="ai-spinner ai-spinner-cover"></span> Writing cover letter… (10–20s)';

      var result;
      try {
        result = await sendBg({
          action: "generateCoverLetter",
          jdText: jdResult.jdText,
          jobKey: currentJobKey,
          jobMeta: currentJobMeta,
        });
      } catch (e) {
        showCoverLetterError("Generation failed: " + String(e));
        return;
      }

      if (!result || !result.ok) {
        showCoverLetterError(result ? result.error : "No response from background.");
        return;
      }

      lastCoverLetterText = result.coverLetterText;
      standaloneCoverLetter.value = result.coverLetterText;
      coverLetterOutput.classList.remove("hidden");
      coverLetterStatus.textContent = "✅ Cover letter ready. Edit as needed.";
      coverLetterStatus.className = "ai-status ai-status-success";
      setStatus("🟢 Done", "success");
      btnCoverLetter.disabled = false;

      // Auto-save to vault
      if (currentJobKey && result.coverLetterText) {
        var JA = window.JobAutofill || {};
        var settings = await sendBg({ action: "getSettings" });
        var personal = (settings.ok && settings.resume && settings.resume.personal) ? settings.resume.personal : {};
        var clHtml = JA.buildCoverLetterHtml
          ? JA.buildCoverLetterHtml(result.coverLetterText, currentJobMeta, personal)
          : null;
        var now = new Date().toISOString();
        if (clHtml) {
          try {
            var pdfDoc = await JA.renderPdfFromHtml(clHtml, buildAiFilename("cover-letter", "pdf"));
            pdfDoc.createdAt = now;
            await sendBg({
              action: "saveJobDocument",
              jobKey: currentJobKey,
              jobMeta: currentJobMeta,
              docType: "coverLetter",
              doc: pdfDoc,
            });
            await refreshDocsList();
          } catch (pdfErr) {
            showCoverLetterError("Cover letter generated, but PDF archive save failed: " + String(pdfErr));
          }
        }
      }
    });
  }

  if (btnDownloadCoverLetter) {
    btnDownloadCoverLetter.addEventListener("click", async function () {
      var text = standaloneCoverLetter ? standaloneCoverLetter.value : lastCoverLetterText;
      if (!text) return;
      var JA = window.JobAutofill || {};
      var settings = await sendBg({ action: "getSettings" });
      var personal = (settings.ok && settings.resume && settings.resume.personal) ? settings.resume.personal : {};
      var clHtml = JA.buildCoverLetterHtml
        ? JA.buildCoverLetterHtml(text, currentJobMeta, personal)
        : "<pre>" + escHtml(text) + "</pre>";
      try {
        var doc = await JA.renderPdfFromHtml(clHtml, buildAiFilename("cover-letter", "pdf"));
        JA.downloadBase64File(doc.dataBase64, doc.name, doc.mime);
      } catch (pdfErr) {
        showCoverLetterError("PDF export failed: " + String(pdfErr));
      }
    });
  }

  if (btnCancelCoverLetter) {
    btnCancelCoverLetter.addEventListener("click", function () {
      coverLetterSection.classList.add("hidden");
      setStatus("Ready", "neutral");
      btnCoverLetter.disabled = false;
    });
  }

  // ---- AI Preview rendering ----

  function showAiPreviewError(message) {
    aiPreviewStatus.textContent = message;
    aiPreviewStatus.className = "ai-status ai-status-error";
    btnConfirmOptimize.disabled = true;
    btnAiOptimize.disabled = false;
    setStatus("Error", "error");
  }

  function showCoverLetterError(message) {
    coverLetterStatus.textContent = message;
    coverLetterStatus.className = "ai-status ai-status-error";
    btnCoverLetter.disabled = false;
    setStatus("Error", "error");
  }

  function renderAiPreview(gapResult) {
    var html = "";

    // Build a lookup for LLM reasons by requirement text
    var reasonMap = {};
    (gapResult.gapDetails || []).forEach(function (d) {
      if (d && d.requirement) reasonMap[d.requirement] = d.reason || "";
    });

    var matched  = (gapResult.matchedSkills || [])
      .concat(gapResult.matchedKeywords || [])
      .concat(gapResult.matchedQualifications || []);
    var missing  = gapResult.missingSkills || [];
    var quals    = gapResult.missingQualifications || [];
    var keywords = gapResult.missingKeywords || [];

    // De-duplicate matched list
    var matchedUniq = matched.filter(function (v, i, a) { return a.indexOf(v) === i; });

    if (matchedUniq.length > 0) {
      html += '<div class="ai-preview-row">' +
        '<span class="ai-preview-emoji">✅</span>' +
        '<span class="ai-preview-label">Resume has</span>' +
        '<span class="ai-preview-items skill-tags">' +
        matchedUniq.map(function (s) {
          var tip = reasonMap[s] || reasonMap["Skill: " + s] || reasonMap["Keyword/technology: " + s] || "";
          return '<span class="skill-tag skill-tag-green" title="' + escHtml(tip) + '">' + escHtml(s) + '</span>';
        }).join("") +
        '</span></div>';
    }

    if (missing.length > 0) {
      html += '<div class="ai-preview-row">' +
        '<span class="ai-preview-emoji">❌</span>' +
        '<span class="ai-preview-label">Missing skills</span>' +
        '<span class="ai-preview-items skill-tags">' +
        missing.map(function (s) {
          var tip = reasonMap["Skill: " + s] || reasonMap[s] || "";
          return '<span class="skill-tag skill-tag-red" title="' + escHtml(tip) + '">' + escHtml(s) + '</span>';
        }).join("") +
        '</span></div>';
    }

    if (quals.length > 0) {
      html += '<div class="ai-preview-row">' +
        '<span class="ai-preview-emoji">⚠️</span>' +
        '<span class="ai-preview-label">Gaps</span>' +
        '<span class="ai-preview-items skill-tags">' +
        quals.map(function (q) {
          var tip = reasonMap[q] || "";
          return '<span class="skill-tag skill-tag-yellow" title="' + escHtml(tip) + '">' + escHtml(truncate(q, 60)) + '</span>';
        }).join("") +
        '</span></div>';
    }

    if (keywords.length > 0) {
      html += '<div class="ai-preview-row">' +
        '<span class="ai-preview-emoji">🔑</span>' +
        '<span class="ai-preview-label">Keywords missing</span>' +
        '<span class="ai-preview-items skill-tags">' +
        keywords.map(function (k) {
          var tip = reasonMap["Keyword/technology: " + k] || reasonMap[k] || "";
          return '<span class="skill-tag skill-tag-red" title="' + escHtml(tip) + '">' + escHtml(k) + '</span>';
        }).join("") +
        '</span></div>';
    }

    if (!html) {
      html = '<div class="ai-preview-row">' +
        '<span class="ai-preview-emoji">✅</span>' +
        '<span class="ai-preview-items">Your resume looks well-matched! Optimization can still refine wording.</span>' +
        '</div>';
    }

    aiPreviewContent.innerHTML = html;
  }

  function showAiError(message) {
    aiStatus.textContent = message;
    aiStatus.className = "ai-status ai-status-error";
    btnAiOptimize.disabled = false;
    setStatus("Error", "error");
  }

  function renderAiResults(result) {
    aiStatus.textContent = "✅ Resume optimized and cover letter generated.";
    aiStatus.className = "ai-status ai-status-success";

    // ---- Summary stats ----
    var diff          = result.diff || [];
    var gaps          = result.requirementsGaps || [];
    var changedBullets = 0;
    var addedBullets   = 0;
    var hasGenerated   = false;
    diff.forEach(function (entry) {
      if (entry.generated) hasGenerated = true;
      (entry.bullets || []).forEach(function (b) {
        if (b.type === "changed") changedBullets++;
        else if (b.type === "added") addedBullets++;
      });
    });
    var metCount        = gaps.filter(function (g) { return g.status === "met"; }).length;
    var generatedCount  = gaps.filter(function (g) { return g.status === "filled_by_generated_project"; }).length;

    var summaryParts = [];
    if (changedBullets > 0) summaryParts.push("✏️ " + changedBullets + " bullet" + (changedBullets > 1 ? "s" : "") + " reworded");
    if (addedBullets > 0)   summaryParts.push("➕ " + addedBullets + " bullet" + (addedBullets > 1 ? "s" : "") + " added");
    if (metCount > 0)        summaryParts.push("✅ " + metCount + " requirement" + (metCount > 1 ? "s" : "") + " met");
    if (generatedCount > 0)  summaryParts.push("🔮 " + generatedCount + " project generated");

    if (summaryParts.length > 0) {
      var summaryHtml = summaryParts.map(function (p, i) {
        return '<span class="optimize-summary-item">' + escHtml(p) + '</span>' +
          (i < summaryParts.length - 1 ? '<span class="optimize-summary-sep">·</span>' : '');
      }).join("");
      aiOptimizeSummary.innerHTML = summaryHtml;
      aiOptimizeSummary.classList.remove("hidden");
    }

    // ---- Requirements gap list ----
    if (gaps.length > 0) {
      aiGapSection.classList.remove("hidden");
      var gapHtml = "";
      gaps.forEach(function (gap) {
        var statusClass = "gap-met";
        var statusLabel = "✅ Met";
        if (gap.status === "partially_met")            { statusClass = "gap-partial";   statusLabel = "⚠️ Partial"; }
        else if (gap.status === "not_met")             { statusClass = "gap-missing";   statusLabel = "❌ Missing"; }
        else if (gap.status === "filled_by_generated_project") { statusClass = "gap-generated"; statusLabel = "🔮 Generated"; }

        gapHtml +=
          '<div class="gap-row ' + statusClass + '">' +
          '<span class="gap-status-badge">' + statusLabel + '</span>' +
          '<span class="gap-text">' + escHtml(gap.requirement || "") +
          (gap.notes ? '<span class="gap-notes">' + escHtml(gap.notes) + '</span>' : '') +
          '</span>' +
          '</div>';
      });
      aiGapList.innerHTML = gapHtml;
    }

    // ---- Diff ----
    if (diff.length > 0) {
      aiDiffSection.classList.remove("hidden");
      var diffHtml = "";
      diff.forEach(function (entry) {
        var sectionLabel = entry.section === "experience" ? "Experience" : "Project";
        var headerClass  = entry.generated ? "diff-header diff-generated-header" : "diff-header";
        diffHtml += '<div class="' + headerClass + '">' +
          '<span class="diff-section-label">' + sectionLabel + '</span> ' +
          escHtml(entry.header);
        if (entry.generated) {
          diffHtml += ' <span class="diff-generated-badge">Generated</span>';
        }
        diffHtml += '</div>';

        (entry.bullets || []).forEach(function (b) {
          if (b.type === "changed") {
            diffHtml +=
              '<div class="diff-line diff-removed">&minus; ' + escHtml(truncate(b.origText, 140)) + '</div>' +
              '<div class="diff-line diff-added">&plus; ' + escHtml(truncate(b.newText, 140)) + '</div>';
          } else if (b.type === "added") {
            diffHtml += '<div class="diff-line diff-added">&plus; ' + escHtml(truncate(b.newText, 140)) + '</div>';
          }
        });
      });
      aiResumeDiff.innerHTML = diffHtml;
    }

    if (result.coverLetterText) {
      aiCoverLetterSection.classList.remove("hidden");
      aiCoverLetter.value = result.coverLetterText;
    }
  }

  // ---- Render fill results ----

  function renderResults(result) {
    resultsSection.classList.remove("hidden");
    previewSection.classList.add("hidden");

    var filled  = result.filled || [];
    var skipped = result.skipped || [];
    var mappings = result.mappings || currentMappings || [];

    // Build a lookup for LLM-sourced fields
    var llmSelectors = {};
    mappings.forEach(function (m) {
      if (m && m.source === "llm") llmSelectors[m.selector] = true;
    });

    resultStats.innerHTML =
      '<span class="stat">✅ ' + filled.length + ' filled</span>' +
      '<span class="stat">⏭️ ' + skipped.length + ' skipped</span>';

    var html = "";
    filled.forEach(function (f) {
      var isLlm = f.selector && llmSelectors[f.selector];
      html += '<div class="result-item">' +
        '<span class="result-field" title="' + escHtml(f.field) + '">' +
        escHtml(truncate(f.field, 28)) +
        (isLlm ? '<span class="badge-llm">via AI</span>' : '') +
        '</span>' +
        '<span class="result-value" title="' + escHtml(f.value) + '">' + escHtml(truncate(f.value, 32)) + '</span>' +
        '</div>';
    });
    skipped.forEach(function (sk) {
      html += '<div class="result-item">' +
        '<span class="result-field" title="' + escHtml(sk.field) + '">' + escHtml(truncate(sk.field, 30)) + '</span>' +
        '<span class="result-value skipped">' + escHtml(sk.reason || "skipped") + '</span>' +
        '</div>';
    });

    resultList.innerHTML = html;
  }

  function renderPreview(result) {
    previewSection.classList.remove("hidden");
    resultsSection.classList.add("hidden");

    var mappings  = result.mappings || [];
    var willFill  = mappings.filter(function (m) { return m.confidence >= 0.8 && m.value; });
    var willSkip  = mappings.filter(function (m) { return m.confidence < 0.8 || !m.value; });

    previewStats.innerHTML =
      '<span class="stat">📋 ' + result.fieldCount + ' fields</span>' +
      '<span class="stat">✅ ' + willFill.length + ' to fill</span>' +
      '<span class="stat">⏭️ ' + willSkip.length + ' skipped</span>';

    var html = "";
    if (result.formLayout && result.formLayout.multiStepLikely) {
      var cues = (result.formLayout.wizardCues || []).join(", ");
      html +=
        '<div class="info-banner">Multi-step form likely' +
        (cues ? " (" + escHtml(cues) + ")" : "") +
        ". Fill visible fields on this step, then use the app’s Next/Continue.</div>";
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
      html += '<div class="warning-banner">⚠️ Submit button detected: "' +
        escHtml(result.navButton.text) + '". This extension will NOT auto-submit.</div>';
    }

    willFill.forEach(function (m) {
      var isLlm = m.source === "llm";
      html += '<div class="result-item">' +
        '<span class="result-field" title="' + escHtml(m.field_label) + '">' +
        escHtml(truncate(m.field_label, 28)) +
        (isLlm ? '<span class="badge-llm">via AI</span>' : '') +
        '</span>' +
        '<span class="result-value" title="' + escHtml(m.value) + '">' + escHtml(truncate(m.value, 32)) + '</span>' +
        '</div>';
    });
    willSkip.forEach(function (s) {
      html += '<div class="result-item">' +
        '<span class="result-field" title="' + escHtml(s.field_label) + '">' + escHtml(truncate(s.field_label, 30)) + '</span>' +
        '<span class="result-value skipped">' + escHtml(s.reason || "skipped") + '</span>' +
        '</div>';
    });

    previewList.innerHTML = html;
  }

  function showError(message) {
    resultsSection.classList.remove("hidden");
    previewSection.classList.add("hidden");
    resultStats.innerHTML = "";
    resultList.innerHTML = '<div class="result-item"><span class="result-value skipped">' +
      escHtml(message || "Unknown error") + '</span></div>';
  }

  // ---- AI doc save & download ----

  async function saveAndDownloadAiDocs(result) {
    var JA       = window.JobAutofill || {};
    var settings = await sendBg({ action: "getSettings" });
    var personal = (settings.ok && settings.resume && settings.resume.personal) ? settings.resume.personal : {};
    var now      = new Date().toISOString();

    if (result.tailoredResume && JA.buildResumeHtml && JA.renderPdfFromHtml) {
      var resumeHtml = JA.buildResumeHtml(result.tailoredResume);
      var resumeDoc  = await JA.renderPdfFromHtml(resumeHtml, buildAiFilename("tailored-resume", "pdf"));
      resumeDoc.createdAt = now;
      JA.downloadBase64File(resumeDoc.dataBase64, resumeDoc.name, resumeDoc.mime);

      if (currentJobKey) {
        await sendBg({
          action: "saveJobDocument",
          jobKey: currentJobKey,
          jobMeta: currentJobMeta,
          docType: "editedResume",
          doc: resumeDoc,
        });
      }
    }

    if (result.coverLetterText && JA.buildCoverLetterHtml && JA.renderPdfFromHtml) {
      var clHtml = JA.buildCoverLetterHtml(result.coverLetterText, currentJobMeta, personal);
      var clDoc  = await JA.renderPdfFromHtml(clHtml, buildAiFilename("cover-letter", "pdf"));
      clDoc.createdAt = now;
      JA.downloadBase64File(clDoc.dataBase64, clDoc.name, clDoc.mime);

      if (currentJobKey) {
        await sendBg({
          action: "saveJobDocument",
          jobKey: currentJobKey,
          jobMeta: currentJobMeta,
          docType: "coverLetter",
          doc: clDoc,
        });
      }
    }

    await refreshDocsList();
  }

  function downloadHtmlAsFile(htmlString, filename) {
    var blob = new Blob([htmlString], { type: "text/html" });
    var url  = URL.createObjectURL(blob);
    var a    = document.createElement("a");
    a.href     = url;
    a.download = filename;
    a.click();
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

  // ---- Utilities ----

  function setStatus(text, type) {
    statusBadge.textContent = text;
    statusBadge.className   = "badge badge-" + type;
  }

  function sendBg(msg) {
    return new Promise(function (resolve) {
      chrome.runtime.sendMessage(msg, function (resp) {
        resolve(resp || { ok: false, error: "No response from background" });
      });
    });
  }

  function openOptionsPage() {
    chrome.runtime.openOptionsPage();
  }

  async function assertContentScript() {
    try {
      var tabId = await getOriginTabId();
      if (!tabId) {
        showError("No origin tab found.");
        setStatus("Error", "error");
        return false;
      }
      const resp = await chrome.tabs.sendMessage(tabId, { action: "ping" });
      if (!resp || !resp.ok) throw new Error("No response");
      return true;
    } catch (e) {
      showError("Cannot reach this page. Refresh the tab and try again.");
      setStatus("No page access", "warning");
      return false;
    }
  }

  async function refreshJobContextAndDocs() {
    try {
      var tabId = await getOriginTabId();
      if (!tabId) return;
      const resp = await chrome.tabs.sendMessage(tabId, { action: "getJobContext" });
      if (resp && resp.ok && resp.jobKey) {
        currentJobKey  = resp.jobKey;
        currentJobMeta = resp.jobMeta || null;
        renderJobContextLine();
        await refreshDocsList();
      } else {
        currentJobKey  = null;
        currentJobMeta = null;
        renderJobContextLine();
        renderDocsList(null);
      }
    } catch (e) {
      currentJobKey  = null;
      currentJobMeta = null;
      renderJobContextLine();
      renderDocsList(null);
    }
  }

  function renderProfile(profile) {
    var first   = profile.first_name || "";
    var last    = profile.last_name  || "";
    var name    = [first, last].filter(Boolean).join(" ") || "No name";
    var initial = (first.charAt(0) || last.charAt(0) || "?").toUpperCase();
    var details = [profile.email, profile.phone].filter(Boolean).join(" · ");

    profileSummary.innerHTML =
      '<div class="profile-avatar">' + escHtml(initial) + '</div>' +
      '<div class="profile-info">' +
        '<div class="name">' + escHtml(name) + '</div>' +
        '<div class="detail">' + escHtml(details || "No contact info") + '</div>' +
      '</div>';
  }

  function renderJobContextLine() {
    if (!jobContextLine) return;
    if (!currentJobKey) {
      jobContextLine.textContent = "No job detected on this tab.";
      if (uploadEditedResume)    uploadEditedResume.disabled    = true;
      if (uploadCoverLetterFile) uploadCoverLetterFile.disabled = true;
      if (btnSaveCoverLetterText) btnSaveCoverLetterText.disabled = true;
      return;
    }
    var company = (currentJobMeta && currentJobMeta.company) ? currentJobMeta.company : "";
    var jobTitle = (currentJobMeta && currentJobMeta.title)  ? currentJobMeta.title   : "";
    var parts   = [company, jobTitle].filter(Boolean);
    jobContextLine.textContent = parts.length ? parts.join(" — ") : "Job key: " + currentJobKey;
    if (uploadEditedResume)    uploadEditedResume.disabled    = false;
    if (uploadCoverLetterFile) uploadCoverLetterFile.disabled = false;
    if (btnSaveCoverLetterText) btnSaveCoverLetterText.disabled = false;
  }

  function setDocsStatus(text, ok) {
    if (!docsStatus) return;
    docsStatus.textContent  = text || "";
    docsStatus.style.color  = ok ? "#059669" : "#ef4444";
  }

  async function refreshDocsList() {
    if (!currentJobKey) { renderDocsList(null); return; }
    var resp = await sendBg({ action: "getJobDocuments", jobKey: currentJobKey });
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
      docsList.innerHTML = '<div class="result-item"><span class="result-value skipped">No documents saved yet.</span></div>';
      return;
    }

    var edited = Array.isArray(bucket.editedResumes) ? bucket.editedResumes : [];
    var covers = Array.isArray(bucket.coverLetters)  ? bucket.coverLetters  : [];
    var html   = "";

    if (edited.length > 0) {
      html += '<div class="result-item"><span class="result-field">📄 Resumes</span><span class="result-value">' + edited.length + '</span></div>';
      edited.forEach(function (d) { html += renderDocRow("editedResume", d); });
    }
    if (covers.length > 0) {
      html += '<div class="result-item"><span class="result-field">✉️ Cover Letters</span><span class="result-value">' + covers.length + '</span></div>';
      covers.forEach(function (d) { html += renderDocRow("coverLetter", d); });
    }
    if (!html) {
      html = '<div class="result-item"><span class="result-value skipped">No documents saved yet.</span></div>';
    }
    docsList.innerHTML = html;
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
      '<button class="btn-text" data-action="download" data-doc-type="' + docType + '" data-id="' + escHtml(id) + '">↓</button>' +
      '<button class="btn-text" data-action="delete" data-doc-type="' + docType + '" data-id="' + escHtml(id) + '">✕</button>' +
      '</span></div>'
    );
  }

  async function saveDocFromFile(docType, file) {
    if (!currentJobKey) { setDocsStatus("No job detected for this tab yet.", false); return; }
    if (!file) return;
    if (docType === "editedResume" && file.type !== "application/pdf") { setDocsStatus("Resume must be a PDF.", false); return; }
    if (docType === "coverLetter"  && file.type !== "application/pdf") { setDocsStatus("Cover letter must be a PDF.", false); return; }

    try {
      setDocsStatus("Saving…", true);
      var dataBase64 = await readFileAsBase64(file);
      var doc = {
        id:         genId(),
        name:       file.name || (docType === "editedResume" ? "edited-resume.pdf" : "cover-letter.pdf"),
        mime:       file.type || "application/pdf",
        size:       file.size || 0,
        createdAt:  new Date().toISOString(),
        dataBase64: dataBase64,
      };
      var resp = await sendBg({
        action: "saveJobDocument",
        jobKey: currentJobKey,
        jobMeta: currentJobMeta,
        docType,
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
    var resp = await sendBg({ action: "getJobDocuments", jobKey: currentJobKey });
    if (!resp.ok || !resp.bucket) { setDocsStatus(resp.error || "Failed to load.", false); return; }
    var arr = docType === "editedResume" ? (resp.bucket.editedResumes || []) : (resp.bucket.coverLetters || []);
    var doc = arr.find(function (d) { return d && d.id === id; });
    if (!doc || !doc.dataBase64) { setDocsStatus("Document not found.", false); return; }
    var filename = buildJobFilename(currentJobMeta, docType, doc);
    downloadBase64(doc.dataBase64, filename, doc.mime || "application/octet-stream");
    setDocsStatus("Download started.", true);
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

  // ---- Small helpers ----

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

  function arrayBufferToBase64(arrayBuffer) {
    var bytes     = new Uint8Array(arrayBuffer);
    var binary    = "";
    var chunkSize = 0x8000;
    for (var i = 0; i < bytes.length; i += chunkSize) {
      binary += String.fromCharCode.apply(null, bytes.subarray(i, i + chunkSize));
    }
    return btoa(binary);
  }

  function base64FromUtf8(text) {
    return btoa(unescape(encodeURIComponent(String(text || ""))));
  }

  function downloadBase64(base64, filename, mime) {
    var byteChars   = atob(base64);
    var byteNumbers = new Array(byteChars.length);
    for (var i = 0; i < byteChars.length; i++) byteNumbers[i] = byteChars.charCodeAt(i);
    var bytes = new Uint8Array(byteNumbers);
    var blob  = new Blob([bytes], { type: mime || "application/octet-stream" });
    var url   = URL.createObjectURL(blob);
    var a     = document.createElement("a");
    a.href     = url;
    a.download = filename || "download";
    a.click();
    setTimeout(function () { URL.revokeObjectURL(url); }, 2000);
  }

  function escHtml(str) {
    var div = document.createElement("div");
    div.textContent = str;
    return div.innerHTML;
  }

  function truncate(str, len) {
    if (!str) return "";
    return str.length > len ? str.substring(0, len - 3) + "…" : str;
  }
})();

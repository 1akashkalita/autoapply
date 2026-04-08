/**
 * Options page script for the Job Autofill extension.
 * Profile editor, JSON import/export, AI settings.
 */

(function () {
  // Map of form field IDs to profile keys (flat fields)
  const FLAT_FIELDS = [
    "first_name", "last_name", "email", "phone",
    "linkedin", "github", "portfolio",
    "university", "degree", "gpa",
    "graduation_month", "graduation_year",
    "work_authorization", "years_of_experience",
  ];
  const ADDRESS_FIELDS = ["street", "city", "state", "zip", "country"];

  // ---- Init ----

  loadSettings();

  async function loadSettings() {
    const resp = await sendBg({ action: "getSettings" });
    if (!resp.ok) return;

    if (resp.profile) populateForm(resp.profile);
    if (resp.apiKey) document.getElementById("apiKey").value = resp.apiKey;
    if (resp.llmEnabled) document.getElementById("llmEnabled").checked = true;
    if (resp.resume) {
      document.getElementById("resumeJson").value = JSON.stringify(resp.resume, null, 2);
    }
    if (resp.styleProfile) {
      document.getElementById("styleProfile").value = resp.styleProfile;
    }

    renderBaseResumePdfMeta(resp.baseResumePdfMeta || null);
  }

  function populateForm(profile) {
    for (const key of FLAT_FIELDS) {
      const el = document.getElementById(key);
      if (el && profile[key] !== undefined) {
        if (el.tagName === "SELECT") {
          el.value = String(profile[key]);
        } else {
          el.value = profile[key] || "";
        }
      }
    }
    const addr = profile.address || {};
    for (const key of ADDRESS_FIELDS) {
      const el = document.getElementById(key);
      if (el) el.value = addr[key] || "";
    }
    // Special case: require_sponsorship is boolean
    const sponsorEl = document.getElementById("require_sponsorship");
    if (sponsorEl) {
      sponsorEl.value = profile.require_sponsorship ? "true" : "false";
    }
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

  // ---- Event Listeners ----

  // Save profile
  document.getElementById("profileForm").addEventListener("submit", async (e) => {
    e.preventDefault();
    const profile = readForm();
    const resp = await sendBg({ action: "saveProfile", profile });
    showStatus("profileStatus", resp.ok ? "Profile saved." : "Save failed.", resp.ok);
  });

  // Export JSON
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

  // Import JSON
  document.getElementById("btnImport").addEventListener("click", async () => {
    const text = document.getElementById("jsonImport").value.trim();
    if (!text) {
      showStatus("importStatus", "Paste JSON first.", false);
      return;
    }
    try {
      const data = JSON.parse(text);
      // Validate it has at least one expected key
      if (!data.first_name && !data.email && !data.last_name) {
        showStatus("importStatus", "JSON doesn't look like an applicant profile.", false);
        return;
      }
      populateForm(data);
      const resp = await sendBg({ action: "saveProfile", profile: data });
      showStatus("importStatus", resp.ok ? "Imported and saved." : "Import failed.", resp.ok);
      document.getElementById("jsonImport").value = "";
    } catch (err) {
      showStatus("importStatus", "Invalid JSON: " + err.message, false);
    }
  });

  // Save AI settings (API key, LLM toggle, style profile)
  document.getElementById("btnSaveAi").addEventListener("click", async () => {
    const apiKey = document.getElementById("apiKey").value.trim();
    const llmEnabled = document.getElementById("llmEnabled").checked;
    const styleProfile = document.getElementById("styleProfile").value.trim();

    const resp = await sendBg({ action: "saveSettings", apiKey, llmEnabled });
    if (styleProfile) {
      await sendBg({ action: "saveStyleProfile", styleProfile });
    }
    showStatus("aiSettingsStatus", resp.ok ? "AI settings saved." : "Save failed.", resp.ok);
  });

  // Save resume JSON
  document.getElementById("btnSaveResume").addEventListener("click", async () => {
    const text = document.getElementById("resumeJson").value.trim();
    if (!text) {
      showStatus("resumeStatus", "Paste resume JSON first.", false);
      return;
    }
    try {
      const data = JSON.parse(text);
      const resp = await sendBg({ action: "saveResume", resume: data });
      showStatus("resumeStatus", resp.ok ? "Resume data saved." : "Save failed.", resp.ok);
    } catch (err) {
      showStatus("resumeStatus", "Invalid JSON: " + err.message, false);
    }
  });

  // ---- Base Resume PDF ----

  const baseResumePdfInput = document.getElementById("baseResumePdf");
  const btnDownloadBase = document.getElementById("btnDownloadBaseResumePdf");
  const btnClearBase = document.getElementById("btnClearBaseResumePdf");

  if (baseResumePdfInput) {
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
          renderBaseResumePdfMeta({
            id: pdf.id,
            name: pdf.name,
            mime: pdf.mime,
            size: pdf.size,
            createdAt: pdf.createdAt,
          });
        } else {
          showStatus("baseResumePdfStatus", resp.error || "Save failed.", false);
        }
      } catch (err) {
        showStatus("baseResumePdfStatus", "Upload failed: " + err.message, false);
      } finally {
        baseResumePdfInput.value = "";
      }
    });
  }

  if (btnDownloadBase) {
    btnDownloadBase.addEventListener("click", async () => {
      const resp = await sendBg({ action: "getBaseResumePdf" });
      if (!resp.ok || !resp.pdf || !resp.pdf.dataBase64) {
        showStatus("baseResumePdfStatus", "No stored base resume PDF.", false);
        return;
      }
      downloadBase64File(resp.pdf.dataBase64, resp.pdf.name || "base-resume.pdf", resp.pdf.mime || "application/pdf");
      showStatus("baseResumePdfStatus", "Download started.", true);
    });
  }

  if (btnClearBase) {
    btnClearBase.addEventListener("click", async () => {
      const resp = await sendBg({ action: "clearBaseResumePdf" });
      showStatus("baseResumePdfStatus", resp.ok ? "Cleared stored PDF." : "Clear failed.", !!resp.ok);
      renderBaseResumePdfMeta(null);
    });
  }

  // ---- Helpers ----

  function sendBg(msg) {
    return new Promise((resolve) => {
      chrome.runtime.sendMessage(msg, (resp) => {
        resolve(resp || { ok: false });
      });
    });
  }

  function showStatus(elId, message, success) {
    const el = document.getElementById(elId);
    el.textContent = message;
    el.className = "status-msg " + (success ? "success" : "error");
    el.classList.remove("hidden");
    setTimeout(() => el.classList.add("hidden"), 4000);
  }

  function renderBaseResumePdfMeta(meta) {
    const el = document.getElementById("baseResumePdfMeta");
    const btnDownload = document.getElementById("btnDownloadBaseResumePdf");
    const btnClear = document.getElementById("btnClearBaseResumePdf");
    if (!el) return;

    if (!meta) {
      el.textContent = "No base resume PDF stored yet.";
      if (btnDownload) btnDownload.disabled = true;
      if (btnClear) btnClear.disabled = true;
      return;
    }

    el.textContent =
      "Stored: " +
      (meta.name || "resume.pdf") +
      " (" +
      formatBytes(meta.size || 0) +
      ") • " +
      (meta.createdAt ? new Date(meta.createdAt).toLocaleString() : "");
    if (btnDownload) btnDownload.disabled = false;
    if (btnClear) btnClear.disabled = false;
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

  function downloadBase64File(base64, filename, mime) {
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

  function formatBytes(bytes) {
    const b = Number(bytes) || 0;
    if (b < 1024) return b + " B";
    const kb = b / 1024;
    if (kb < 1024) return kb.toFixed(1) + " KB";
    const mb = kb / 1024;
    return mb.toFixed(1) + " MB";
  }
})();

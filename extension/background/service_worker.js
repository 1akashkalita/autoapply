/**
 * Background service worker.
 * Handles message routing between popup and content scripts,
 * profile storage management, and optional OpenAI API integration.
 */

importScripts("../vendor/pdf.min.js", "../shared/match_rules.js", "../shared/archive_db.js");

if (self.pdfjsLib && self.pdfjsLib.GlobalWorkerOptions) {
  self.pdfjsLib.GlobalWorkerOptions.workerSrc = null;
}

// ---- Storage helpers -------------------------------------------------------

const STORAGE_KEYS = {
  PROFILE: "jaf_profile",
  RESUME: "jaf_resume",
  BASE_RESUME_PDF: "jaf_base_resume_pdf",
  JOB_DOCUMENTS: "jaf_job_documents",
  API_KEY: "jaf_openai_key",
  LLM_ENABLED: "jaf_llm_enabled",
  LAST_FILL_LOG: "jaf_last_fill_log",
  STYLE_PROFILE: "jaf_style_profile",
  API_USAGE: "jaf_api_usage",
};

const DEFAULT_OPENAI_MODEL = "gpt-4o-mini";
const MODEL_PRICING = {
  "gpt-4o-mini": { inputPer1M: 0.15, outputPer1M: 0.6 },
};
const ARCHIVE_META_KEYS = {
  MIGRATION_V1: "migration_v1",
};
const DEFAULT_PROFILE = {
  first_name: "",
  last_name: "",
  email: "",
  phone: "",
  address: {
    street: "",
    city: "",
    state: "",
    zip: "",
    country: "United States",
  },
  linkedin: "",
  github: "",
  portfolio: "",
  leetcode: "",
  huggingface: "",
  other_link_1_label: "",
  other_link_1_url: "",
  other_link_2_label: "",
  other_link_2_url: "",
  university: "",
  degree: "",
  gpa: "",
  graduation_month: "",
  graduation_year: "",
  work_authorization: "",
  require_sponsorship: false,
  years_of_experience: "",
  gender: "",
  veteran_status: "",
  military_status: "",
  disability_status: "",
};
const DEFAULT_RESUME_SHAPE = {
  personal: {},
  education: [],
  experience: [],
  projects: [],
  leadership: [],
  skills: {
    languages: [],
    technologies: [],
    concepts: [],
  },
  certifications: [],
};

// ---- API usage (OpenAI responses) ------------------------------------------

function cloneJson(value) {
  return value ? JSON.parse(JSON.stringify(value)) : value;
}

function mergeObjects(base, extra) {
  var out = cloneJson(base) || {};
  var src = extra || {};
  Object.keys(src).forEach(function (key) {
    var value = src[key];
    if (value && typeof value === "object" && !Array.isArray(value) && out[key] && typeof out[key] === "object" && !Array.isArray(out[key])) {
      out[key] = mergeObjects(out[key], value);
    } else {
      out[key] = value;
    }
  });
  return out;
}

function normalizeProfile(profile) {
  var normalized = mergeObjects(DEFAULT_PROFILE, profile || {});
  normalized.require_sponsorship = normalized.require_sponsorship === true || normalized.require_sponsorship === "true";
  if (!normalized.address || typeof normalized.address !== "object") {
    normalized.address = cloneJson(DEFAULT_PROFILE.address);
  } else {
    normalized.address = mergeObjects(DEFAULT_PROFILE.address, normalized.address);
  }
  return normalized;
}

function profileFullName(profile) {
  return [profile.first_name, profile.last_name].filter(Boolean).join(" ").trim();
}

function genId(prefix) {
  if (self.crypto && typeof self.crypto.randomUUID === "function") {
    return prefix + "_" + self.crypto.randomUUID();
  }
  return prefix + "_" + Date.now() + "_" + Math.random().toString(36).slice(2, 10);
}

function normalizeModelName(model) {
  return MODEL_PRICING[model] ? model : DEFAULT_OPENAI_MODEL;
}

function computeApproxCostUsd(promptTokens, completionTokens, model) {
  var pricing = MODEL_PRICING[normalizeModelName(model)] || MODEL_PRICING[DEFAULT_OPENAI_MODEL];
  var inputCost = ((Number(promptTokens) || 0) / 1000000) * pricing.inputPer1M;
  var outputCost = ((Number(completionTokens) || 0) / 1000000) * pricing.outputPer1M;
  return Number((inputCost + outputCost).toFixed(6));
}

function createEmptyUsageSummary() {
  return {
    key: ArchiveDB.SUMMARY_KEY,
    totalPromptTokens: 0,
    totalCompletionTokens: 0,
    totalRequests: 0,
    approxCostUsd: 0,
    lastRequestAt: null,
    byOperation: {},
    legacyBackfill: false,
  };
}

function applyUsageEventToSummary(summary, eventRecord) {
  var next = cloneJson(summary) || createEmptyUsageSummary();
  var op = eventRecord.operation || "unknown";
  if (!next.byOperation[op]) {
    next.byOperation[op] = {
      count: 0,
      promptTokens: 0,
      completionTokens: 0,
      approxCostUsd: 0,
      lastRequestAt: null,
      model: eventRecord.model || DEFAULT_OPENAI_MODEL,
    };
  }

  next.totalPromptTokens += Number(eventRecord.promptTokens) || 0;
  next.totalCompletionTokens += Number(eventRecord.completionTokens) || 0;
  next.totalRequests += 1;
  next.approxCostUsd = Number((next.approxCostUsd + (Number(eventRecord.approxCostUsd) || 0)).toFixed(6));
  next.lastRequestAt = eventRecord.timestamp || next.lastRequestAt;

  next.byOperation[op].count += 1;
  next.byOperation[op].promptTokens += Number(eventRecord.promptTokens) || 0;
  next.byOperation[op].completionTokens += Number(eventRecord.completionTokens) || 0;
  next.byOperation[op].approxCostUsd = Number((next.byOperation[op].approxCostUsd + (Number(eventRecord.approxCostUsd) || 0)).toFixed(6));
  next.byOperation[op].lastRequestAt = eventRecord.timestamp || next.byOperation[op].lastRequestAt;
  next.byOperation[op].model = eventRecord.model || next.byOperation[op].model || DEFAULT_OPENAI_MODEL;
  return next;
}

async function persistUsageSummary(summary) {
  await ArchiveDB.setUsageSummary(summary);
  await chrome.storage.local.set({ [STORAGE_KEYS.API_USAGE]: summary });
}

async function ensureArchiveReady() {
  await ArchiveDB.openDb();
  await migrateLegacyArchiveIfNeeded();
}

async function migrateLegacyArchiveIfNeeded() {
  var migrationState = await ArchiveDB.getMeta(ARCHIVE_META_KEYS.MIGRATION_V1);
  if (migrationState && migrationState.completedAt) return;

  var legacy = await chrome.storage.local.get([STORAGE_KEYS.JOB_DOCUMENTS, STORAGE_KEYS.API_USAGE]);
  var legacyDocs = legacy[STORAGE_KEYS.JOB_DOCUMENTS] || {};
  var legacyUsage = legacy[STORAGE_KEYS.API_USAGE] || null;

  for (const jobKey of Object.keys(legacyDocs)) {
    const bucket = legacyDocs[jobKey] || {};
    const jobMeta = bucket.jobMeta || null;
    const edited = Array.isArray(bucket.editedResumes) ? bucket.editedResumes : [];
    const covers = Array.isArray(bucket.coverLetters) ? bucket.coverLetters : [];

    for (const doc of edited) {
      if (!doc || !doc.id || !doc.dataBase64) continue;
      await ArchiveDB.saveJobDocument(jobKey, jobMeta, "editedResume", doc);
    }
    for (const doc2 of covers) {
      if (!doc2 || !doc2.id || !doc2.dataBase64) continue;
      await ArchiveDB.saveJobDocument(jobKey, jobMeta, "coverLetter", doc2);
    }
  }

  var summary = await ArchiveDB.getUsageSummary();
  if (!summary) summary = createEmptyUsageSummary();
  if (legacyUsage && legacyUsage.totalRequests && summary.totalRequests === 0) {
    summary.totalPromptTokens = Number(legacyUsage.totalPromptTokens) || 0;
    summary.totalCompletionTokens = Number(legacyUsage.totalCompletionTokens) || 0;
    summary.totalRequests = Number(legacyUsage.totalRequests) || 0;
    summary.lastRequestAt = legacyUsage.lastRequestAt || null;
    summary.approxCostUsd = computeApproxCostUsd(summary.totalPromptTokens, summary.totalCompletionTokens, DEFAULT_OPENAI_MODEL);
    summary.byOperation = {};

    const byOperation = legacyUsage.byOperation || {};
    for (const op of Object.keys(byOperation)) {
      const entry = byOperation[op] || {};
      summary.byOperation[op] = {
        count: Number(entry.count) || 0,
        promptTokens: Number(entry.promptTokens) || 0,
        completionTokens: Number(entry.completionTokens) || 0,
        approxCostUsd: computeApproxCostUsd(entry.promptTokens, entry.completionTokens, DEFAULT_OPENAI_MODEL),
        lastRequestAt: legacyUsage.lastRequestAt || null,
        model: DEFAULT_OPENAI_MODEL,
      };
    }
    summary.legacyBackfill = true;
    await persistUsageSummary(summary);
  }

  await ArchiveDB.setMeta(ARCHIVE_META_KEYS.MIGRATION_V1, {
    completedAt: new Date().toISOString(),
    migratedJobCount: Object.keys(legacyDocs).length,
    hadLegacyUsage: !!legacyUsage,
  });
}

async function recordApiUsage(usage, operation, context) {
  if (!usage || typeof usage !== "object") return;
  await ensureArchiveReady();

  const pt = Number(usage.prompt_tokens) || 0;
  const ct = Number(usage.completion_tokens) || 0;
  const timestamp = new Date().toISOString();
  const model = normalizeModelName((context && context.model) || DEFAULT_OPENAI_MODEL);
  const eventRecord = {
    id: genId("usage"),
    timestamp: timestamp,
    operation: operation || "unknown",
    model: model,
    promptTokens: pt,
    completionTokens: ct,
    approxCostUsd: computeApproxCostUsd(pt, ct, model),
    jobKey: context && context.jobKey ? context.jobKey : "",
  };

  await ArchiveDB.addUsageEvent(eventRecord);
  const current = (await ArchiveDB.getUsageSummary()) || createEmptyUsageSummary();
  const next = applyUsageEventToSummary(current, eventRecord);
  await persistUsageSummary(next);
}

// ---- Job attachment resolution (resume PDF + cover letter file) ------------

function base64ToUtf8(b64) {
  const binary = atob(b64);
  const bytes = new Uint8Array(binary.length);
  for (let i = 0; i < binary.length; i++) bytes[i] = binary.charCodeAt(i);
  return new TextDecoder("utf-8").decode(bytes);
}

function base64ToBytes(b64) {
  const binary = atob(b64 || "");
  const bytes = new Uint8Array(binary.length);
  for (let i = 0; i < binary.length; i++) bytes[i] = binary.charCodeAt(i);
  return bytes;
}

function bytesToLatin1(bytes) {
  var chunkSize = 0x8000;
  var out = "";
  for (var i = 0; i < bytes.length; i += chunkSize) {
    out += String.fromCharCode.apply(null, bytes.subarray(i, i + chunkSize));
  }
  return out;
}

function utf8StringToBase64(str) {
  return btoa(unescape(encodeURIComponent(str)));
}

function stripHtmlToPlain(html) {
  return String(html)
    .replace(/<script[\s\S]*?<\/script>/gi, "")
    .replace(/<style[\s\S]*?<\/style>/gi, "")
    .replace(/<[^>]+>/g, " ")
    .replace(/\s+/g, " ")
    .trim();
}

function escapeHtml(text) {
  return String(text || "")
    .replace(/&/g, "&amp;")
    .replace(/</g, "&lt;")
    .replace(/>/g, "&gt;")
    .replace(/"/g, "&quot;")
    .replace(/'/g, "&#39;");
}

function safeFileStem(name, fallback) {
  var stem = String(name || "").replace(/\.[a-z0-9]+$/i, "").trim();
  stem = stem.replace(/[\/\\?%*:|"<>]/g, "").replace(/\s+/g, "-");
  return stem || fallback || "resume";
}

function canonicalResumeHtmlName(name) {
  return safeFileStem(name, "resume") + ".html";
}

function canonicalResumePdfName(name) {
  return safeFileStem(name, "resume") + ".pdf";
}

function normalizeComparableText(text) {
  return String(text || "")
    .toLowerCase()
    .replace(/\u2022/g, " ")
    .replace(/[^a-z0-9\s]/g, " ")
    .replace(/\s+/g, " ")
    .trim();
}

function tokenizeComparableText(text) {
  return normalizeComparableText(text).split(" ").filter(Boolean);
}

function comparableOverlapScore(a, b) {
  var left = tokenizeComparableText(a);
  var right = tokenizeComparableText(b);
  if (!left.length || !right.length) return 0;
  var rightSet = {};
  right.forEach(function (token) { rightSet[token] = true; });
  var matches = 0;
  left.forEach(function (token) {
    if (rightSet[token]) matches += 1;
  });
  return matches / Math.max(left.length, right.length);
}

function buildPdfResumeLines(textItems, styles, viewport) {
  var lines = [];
  var tolerance = 3;

  function finalizeLine(rawLine) {
    if (!rawLine || !rawLine.items || !rawLine.items.length) return null;
    rawLine.items.sort(function (a, b) { return a.left - b.left; });
    var parts = [];
    var previousRight = null;
    rawLine.items.forEach(function (item) {
      var text = String(item.text || "");
      if (!text) return;
      if (previousRight !== null && item.left - previousRight > Math.max(4, item.fontSize * 0.35)) {
        parts.push(" ");
      }
      parts.push(text);
      previousRight = item.left + item.width;
    });

    var text = parts.join("").replace(/\s+/g, " ").trim();
    if (!text) return null;

    var first = rawLine.items[0];
    var last = rawLine.items[rawLine.items.length - 1];
    var top = rawLine.items.reduce(function (acc, item) { return Math.min(acc, item.top); }, rawLine.items[0].top);
    var bottom = rawLine.items.reduce(function (acc, item) { return Math.max(acc, item.top + item.height); }, rawLine.items[0].top + rawLine.items[0].height);
    var left = first.left;
    var right = rawLine.items.reduce(function (acc, item) { return Math.max(acc, item.left + item.width); }, last.left + last.width);
    var width = Math.max(120, viewport.width - left - 12, right - left + 12);
    var fontSize = rawLine.items.reduce(function (acc, item) { return Math.max(acc, item.fontSize); }, first.fontSize || 11);
    var lineHeight = Math.max(fontSize * 1.15, bottom - top + 2);

    return {
      id: "line_" + (lines.length + 1),
      text: text,
      left: Number(left.toFixed(2)),
      top: Number(top.toFixed(2)),
      width: Number(width.toFixed(2)),
      height: Number(lineHeight.toFixed(2)),
      fontSize: Number(fontSize.toFixed(2)),
      fontFamily: first.fontFamily || "Helvetica, Arial, sans-serif",
      fontWeight: first.fontWeight || "400",
      fontStyle: first.fontStyle || "normal",
    };
  }

  (textItems || []).forEach(function (item) {
    var tx = self.pdfjsLib && self.pdfjsLib.Util
      ? self.pdfjsLib.Util.transform(viewport.transform, item.transform)
      : item.transform;
    var fontSize = Math.max(8, Math.sqrt((tx[0] * tx[0]) + (tx[1] * tx[1])) || Math.abs(item.height || 11));
    var left = tx[4];
    var top = tx[5] - fontSize;
    var width = Math.max(8, Number(item.width || 0));
    var style = styles && item.fontName ? (styles[item.fontName] || {}) : {};
    var fontFamily = style.fontFamily || "Helvetica, Arial, sans-serif";
    var fontWeight = /bold/i.test(fontFamily) ? "700" : "400";
    var fontStyle = /italic|oblique/i.test(fontFamily) ? "italic" : "normal";

    if (!String(item.str || "").trim()) return;

    var target = null;
    for (var i = 0; i < lines.length; i++) {
      if (Math.abs(lines[i].top - top) <= tolerance) {
        target = lines[i];
        break;
      }
    }
    if (!target) {
      target = { top: top, items: [] };
      lines.push(target);
    }
    target.items.push({
      text: item.str,
      left: left,
      top: top,
      width: width,
      height: Math.max(fontSize, Math.abs(item.height || fontSize)),
      fontSize: fontSize,
      fontFamily: fontFamily,
      fontWeight: fontWeight,
      fontStyle: fontStyle,
    });
  });

  return lines
    .sort(function (a, b) { return a.top - b.top; })
    .map(finalizeLine)
    .filter(Boolean);
}

function buildCanonicalResumeHtml(meta) {
  var page = meta.page || { width: 612, height: 792 };
  var linesHtml = (meta.lines || []).map(function (line) {
    var width = Math.max(80, Number(line.width || 160));
    var style =
      "left:" + Number(line.left || 0).toFixed(2) + "px;" +
      "top:" + Number(line.top || 0).toFixed(2) + "px;" +
      "width:" + width.toFixed(2) + "px;" +
      "min-height:" + Number(line.height || line.fontSize || 12).toFixed(2) + "px;" +
      "font-size:" + Number(line.fontSize || 11).toFixed(2) + "px;" +
      "font-family:" + escapeHtml(line.fontFamily || "Helvetica, Arial, sans-serif") + ";" +
      "font-weight:" + escapeHtml(line.fontWeight || "400") + ";" +
      "font-style:" + escapeHtml(line.fontStyle || "normal") + ";";
    return '<div class="jaf-resume-line jaf-editable-line" data-line-id="' + escapeHtml(line.id) + '" style="' + style + '">' +
      escapeHtml(line.text || "") +
      "</div>";
  }).join("\n");

  return "<!DOCTYPE html>\n" +
    '<html lang="en">\n<head>\n<meta charset="UTF-8">\n<title>Resume</title>\n<style>\n' +
    "@page{size:letter;margin:0;}\n" +
    "html,body{margin:0;padding:0;background:#fff;}\n" +
    "body{font-family:Helvetica,Arial,sans-serif;}\n" +
    '.resume-page{position:relative;width:' + Number(page.width || 612).toFixed(2) + "px;height:" + Number(page.height || 792).toFixed(2) + 'px;overflow:hidden;background:#fff;color:#111;}\n' +
    ".jaf-resume-line{position:absolute;white-space:pre-wrap;overflow-wrap:anywhere;line-height:1.18;transform-origin:left top;}\n" +
    "</style>\n</head>\n<body>\n" +
    '<div class="resume-page" data-jaf-page-height="' + escapeHtml(String(page.height || 792)) + '">' + linesHtml + "</div>\n" +
    '<script type="application/json" id="jaf-resume-meta">' + escapeHtml(JSON.stringify(meta)) + "</script>\n" +
    "</body>\n</html>";
}

function extractCanonicalResumeMeta(html) {
  var match = String(html || "").match(/<script[^>]+id=["']jaf-resume-meta["'][^>]*>([\s\S]*?)<\/script>/i);
  if (!match) return null;
  var payload = match[1]
    .replace(/&quot;/g, '"')
    .replace(/&#39;/g, "'")
    .replace(/&lt;/g, "<")
    .replace(/&gt;/g, ">")
    .replace(/&amp;/g, "&");
  try {
    return JSON.parse(payload);
  } catch (err) {
    return null;
  }
}

function resumeTextFromCanonicalHtml(html) {
  var meta = extractCanonicalResumeMeta(html);
  if (meta && Array.isArray(meta.lines) && meta.lines.length) {
    return meta.lines.map(function (line) { return String(line.text || "").trim(); }).filter(Boolean).join("\n");
  }
  return stripHtmlToPlain(html);
}

function canonicalHtmlSourceForDoc(doc) {
  if (!doc) return null;
  if (doc.canonicalHtmlBase64) {
    return {
      name: doc.canonicalHtmlName || canonicalResumeHtmlName(doc.name),
      dataBase64: doc.canonicalHtmlBase64,
      mime: "text/html",
    };
  }
  if (String(doc.mime || "").toLowerCase() === "text/html" && doc.dataBase64) {
    return {
      name: doc.name || canonicalResumeHtmlName("resume"),
      dataBase64: doc.dataBase64,
      mime: "text/html",
    };
  }
  return null;
}

async function convertResumePdfToCanonicalAssets(pdfDoc) {
  if (!pdfDoc || !pdfDoc.dataBase64) {
    throw new Error("Missing resume PDF data");
  }
  if (!self.pdfjsLib || typeof self.pdfjsLib.getDocument !== "function") {
    throw new Error("PDF parser unavailable");
  }

  var loadingTask = self.pdfjsLib.getDocument({
    data: base64ToBytes(pdfDoc.dataBase64),
    disableWorker: true,
    useSystemFonts: true,
  });
  var pdf = await loadingTask.promise;
  if ((pdf.numPages || 0) !== 1) {
    throw new Error("Only one-page resumes are supported. Upload a one-page PDF.");
  }

  var page = await pdf.getPage(1);
  var viewport = page.getViewport({ scale: 1 });
  var textContent = await page.getTextContent({
    normalizeWhitespace: false,
    disableCombineTextItems: false,
  });
  var lines = buildPdfResumeLines(textContent.items || [], textContent.styles || {}, viewport);
  if (!lines.length) {
    throw new Error("Could not extract editable text from the resume PDF.");
  }

  var meta = {
    version: 1,
    source: "pdf-import",
    page: {
      width: Number(viewport.width.toFixed(2)),
      height: Number(viewport.height.toFixed(2)),
    },
    lines: lines,
  };
  var html = buildCanonicalResumeHtml(meta);
  return {
    canonicalHtmlName: canonicalResumeHtmlName(pdfDoc.name),
    canonicalHtmlBase64: utf8StringToBase64(html),
    canonicalHtmlPageCount: 1,
    sourcePdfName: pdfDoc.name || canonicalResumePdfName("resume"),
    sourcePdfMime: pdfDoc.mime || "application/pdf",
    sourcePdfDataBase64: pdfDoc.dataBase64,
    sourcePdfSize: pdfDoc.size || base64ByteLength(pdfDoc.dataBase64),
  };
}

function extractResumeDownloadPayload(doc) {
  if (!doc) return null;
  if (doc.derivedPdf && doc.derivedPdf.dataBase64) {
    return {
      dataBase64: doc.derivedPdf.dataBase64,
      name: doc.derivedPdf.name || canonicalResumePdfName(doc.name),
      mime: doc.derivedPdf.mime || "application/pdf",
    };
  }
  if (doc.sourcePdfDataBase64) {
    return {
      dataBase64: doc.sourcePdfDataBase64,
      name: doc.sourcePdfName || canonicalResumePdfName(doc.name),
      mime: doc.sourcePdfMime || "application/pdf",
    };
  }
  if (String(doc.mime || "").toLowerCase() === "application/pdf" && doc.dataBase64) {
    return {
      dataBase64: doc.dataBase64,
      name: doc.name || canonicalResumePdfName("resume"),
      mime: doc.mime || "application/pdf",
    };
  }
  return null;
}

async function resolveResumePdfForJob(jobKey) {
  if (jobKey) {
    const bucket = await getJobDocumentBucket(jobKey);
    const edited = bucket && Array.isArray(bucket.editedResumes) ? bucket.editedResumes : [];
    for (const d of edited) {
      const payload = extractResumeDownloadPayload(d);
      if (payload) return payload;
    }
  }
  var basePdf = await getBaseResumePdf();
  if (!basePdf) return null;
  return extractResumeDownloadPayload(basePdf) || basePdf;
}

async function newestCoverLetterDocForJob(jobKey) {
  if (!jobKey) return null;
  const bucket = await getJobDocumentBucket(jobKey);
  const list = bucket && Array.isArray(bucket.coverLetters) ? bucket.coverLetters : [];
  return list.length ? list[0] : null;
}

function coverLetterDocToFileData(doc) {
  if (!doc || !doc.dataBase64) return null;
  const mime = String(doc.mime || "").toLowerCase();
  const name = String(doc.name || "cover-letter");

  if (mime === "application/pdf" || name.toLowerCase().endsWith(".pdf")) {
    return {
      dataBase64: doc.dataBase64,
      name: name.toLowerCase().endsWith(".pdf") ? name : name + ".pdf",
      mime: "application/pdf",
    };
  }
  if (mime === "text/html" || name.toLowerCase().endsWith(".html")) {
    const html = base64ToUtf8(doc.dataBase64);
    const plain = stripHtmlToPlain(html);
    const base = name.replace(/\.html$/i, "") || "cover-letter";
    return {
      dataBase64: utf8StringToBase64(plain),
      name: base + ".txt",
      mime: "text/plain",
    };
  }
  if (mime === "text/plain" || name.toLowerCase().endsWith(".txt")) {
    return {
      dataBase64: doc.dataBase64,
      name: name.toLowerCase().endsWith(".txt") ? name : name + ".txt",
      mime: "text/plain",
    };
  }
  try {
    const plain = stripHtmlToPlain(base64ToUtf8(doc.dataBase64));
    return {
      dataBase64: utf8StringToBase64(plain),
      name: "cover-letter.txt",
      mime: "text/plain",
    };
  } catch (e) {
    return null;
  }
}

async function getProfile() {
  const result = await chrome.storage.local.get(STORAGE_KEYS.PROFILE);
  return result[STORAGE_KEYS.PROFILE] ? normalizeProfile(result[STORAGE_KEYS.PROFILE]) : null;
}

async function getResume() {
  const result = await chrome.storage.local.get(STORAGE_KEYS.RESUME);
  return result[STORAGE_KEYS.RESUME] || null;
}

async function getBaseResumePdf() {
  const result = await chrome.storage.local.get(STORAGE_KEYS.BASE_RESUME_PDF);
  return result[STORAGE_KEYS.BASE_RESUME_PDF] || null;
}

async function saveBaseResumePdf(pdf) {
  var prepared = cloneJson(pdf) || {};
  var mime = String(prepared.mime || "").toLowerCase();
  if (mime === "application/pdf" && prepared.dataBase64) {
    var assets = await convertResumePdfToCanonicalAssets(prepared);
    prepared = mergeObjects(prepared, assets);
  }
  await chrome.storage.local.set({ [STORAGE_KEYS.BASE_RESUME_PDF]: prepared });
  return prepared;
}

async function sha256HexForBase64(dataBase64) {
  var digest = await self.crypto.subtle.digest("SHA-256", base64ToBytes(dataBase64));
  var bytes = new Uint8Array(digest);
  return Array.from(bytes).map(function (b) { return b.toString(16).padStart(2, "0"); }).join("");
}

function normalizeResumeShape(resume) {
  var out = mergeObjects(DEFAULT_RESUME_SHAPE, resume || {});
  ["education", "experience", "projects", "leadership", "certifications"].forEach(function (key) {
    if (!Array.isArray(out[key])) out[key] = [];
  });
  if (!out.skills || typeof out.skills !== "object") out.skills = cloneJson(DEFAULT_RESUME_SHAPE.skills);
  ["languages", "technologies", "concepts"].forEach(function (key) {
    if (!Array.isArray(out.skills[key])) out.skills[key] = [];
  });
  if (!out.personal || typeof out.personal !== "object") out.personal = {};
  return out;
}

function mergeProfileIntoResume(resume, profile) {
  var normalizedProfile = normalizeProfile(profile);
  var next = normalizeResumeShape(resume || {});
  var personal = mergeObjects({}, next.personal || {});
  var fullName = profileFullName(normalizedProfile);
  if (!personal.name && fullName) personal.name = fullName;
  if (!personal.email && normalizedProfile.email) personal.email = normalizedProfile.email;
  if (!personal.phone && normalizedProfile.phone) personal.phone = normalizedProfile.phone;
  if (!personal.linkedin && normalizedProfile.linkedin) personal.linkedin = normalizedProfile.linkedin;
  if (!personal.github && normalizedProfile.github) personal.github = normalizedProfile.github;
  if (!personal.location) {
    personal.location = [normalizedProfile.address.city, normalizedProfile.address.state].filter(Boolean).join(", ");
  }
  next.personal = personal;
  return next;
}

function sanitizeIdPart(text, fallback) {
  return String(text || fallback || "item").toLowerCase().replace(/[^a-z0-9]+/g, "_").replace(/^_+|_+$/g, "") || String(fallback || "item");
}

function ensureResumeIds(resume) {
  var next = normalizeResumeShape(resume || {});
  ["education", "experience", "projects", "leadership", "certifications"].forEach(function (sectionKey) {
    next[sectionKey] = (next[sectionKey] || []).map(function (item, index) {
      var cloned = cloneJson(item) || {};
      if (!cloned.id) {
        var basis = cloned.name || cloned.title || cloned.role || cloned.institution || (sectionKey + "_" + (index + 1));
        cloned.id = sectionKey + "_" + sanitizeIdPart(basis, String(index + 1));
      }
      if (Array.isArray(cloned.bullets)) {
        cloned.bullets = cloned.bullets.map(function (bullet, bulletIndex) {
          var nextBullet = typeof bullet === "string" ? { text: bullet } : (cloneJson(bullet) || {});
          if (!nextBullet.id) nextBullet.id = cloned.id + "_bullet_" + (bulletIndex + 1);
          nextBullet.text = String(nextBullet.text || "").trim();
          return nextBullet;
        }).filter(function (bullet) { return bullet.text; });
      }
      return cloned;
    });
  });
  return next;
}

function sortNewestFirst(a, b) {
  return String(b.createdAt || "").localeCompare(String(a.createdAt || ""));
}

async function getJobDocumentBucket(jobKey) {
  await ensureArchiveReady();
  const job = await ArchiveDB.getJob(jobKey);
  const docs = await ArchiveDB.listDocumentsByJob(jobKey);
  const basePdf = await getBaseResumePdf();
  const storedResume = await getResume();
  const bucket = {
    jobKey: jobKey,
    jobMeta: job && job.jobMeta ? job.jobMeta : null,
    editedResumes: [],
    coverLetters: [],
    updatedAt: (job && job.updatedAt) || null,
    activeResume: null,
  };

  for (const doc of docs) {
    if (doc.docType === "editedResume") bucket.editedResumes.push(doc);
    else if (doc.docType === "coverLetter") bucket.coverLetters.push(doc);
  }
  bucket.editedResumes.sort(sortNewestFirst);
  bucket.coverLetters.sort(sortNewestFirst);
  if (bucket.editedResumes.length > 0) {
    bucket.activeResume = {
      sourceType: "jobResumePdf",
      sourceName: bucket.editedResumes[0].name || "Active job resume",
      sourceFormat: bucket.editedResumes[0].mime === "text/html" ? "html" : "pdf",
      hasCanonicalHtml: !!(bucket.editedResumes[0].canonicalHtmlBase64 || bucket.editedResumes[0].mime === "text/html"),
    };
  } else if (basePdf && basePdf.dataBase64) {
    bucket.activeResume = {
      sourceType: "baseResumePdf",
      sourceName: basePdf.name || "Base resume PDF",
      sourceFormat: basePdf.canonicalHtmlBase64 ? "html" : "pdf",
      hasCanonicalHtml: !!basePdf.canonicalHtmlBase64,
    };
  } else if (storedResume) {
    bucket.activeResume = {
      sourceType: "optionsResumeJson",
      sourceName: "Resume JSON from Options",
      sourceFormat: "json",
      hasCanonicalHtml: false,
    };
  }
  return (bucket.editedResumes.length || bucket.coverLetters.length || bucket.jobMeta || bucket.activeResume) ? bucket : null;
}

async function listAllArchivedJobs() {
  await ensureArchiveReady();
  const jobs = await ArchiveDB.getAllJobs();
  const docs = await ArchiveDB.listAllDocuments();
  const countsByJob = {};

  for (const doc of docs) {
    if (!countsByJob[doc.jobKey]) {
      countsByJob[doc.jobKey] = { editedResumeCount: 0, coverLetterCount: 0 };
    }
    if (doc.docType === "editedResume") countsByJob[doc.jobKey].editedResumeCount += 1;
    if (doc.docType === "coverLetter") countsByJob[doc.jobKey].coverLetterCount += 1;
  }

  return jobs.map(function (job) {
    var counts = countsByJob[job.jobKey] || { editedResumeCount: 0, coverLetterCount: 0 };
    return {
      jobKey: job.jobKey,
      jobMeta: job.jobMeta || null,
      updatedAt: job.updatedAt || null,
      editedResumeCount: counts.editedResumeCount,
      coverLetterCount: counts.coverLetterCount,
    };
  });
}

async function listDocumentArchive(filters) {
  await ensureArchiveReady();
  const docs = await ArchiveDB.listAllDocuments();
  const jobs = await ArchiveDB.getAllJobs();
  const jobMap = {};
  jobs.forEach(function (job) { jobMap[job.jobKey] = job; });

  const normalized = {
    query: String(filters && filters.query || "").trim().toLowerCase(),
    docType: String(filters && filters.docType || "").trim(),
  };

  return docs
    .map(function (doc) {
      const job = jobMap[doc.jobKey] || {};
      return {
        id: doc.id,
        jobKey: doc.jobKey,
        docType: doc.docType,
        name: doc.name,
        mime: doc.mime,
        size: (doc.derivedPdf && doc.derivedPdf.size) || doc.sourcePdfSize || doc.size || 0,
        createdAt: doc.createdAt || null,
        jobMeta: job.jobMeta || null,
        updatedAt: job.updatedAt || doc.createdAt || null,
      };
    })
    .filter(function (item) {
      if (normalized.docType && item.docType !== normalized.docType) return false;
      if (!normalized.query) return true;
      const haystack = [
        item.name,
        item.jobKey,
        item.jobMeta && item.jobMeta.company,
        item.jobMeta && item.jobMeta.title,
        item.jobMeta && item.jobMeta.location,
      ].join(" ").toLowerCase();
      return haystack.indexOf(normalized.query) !== -1;
    });
}

async function inflatePdfBytes(bytes) {
  if (typeof DecompressionStream !== "function") return null;
  try {
    var ds = new DecompressionStream("deflate");
    var stream = new Blob([bytes]).stream().pipeThrough(ds);
    var buffer = await new Response(stream).arrayBuffer();
    return new Uint8Array(buffer);
  } catch (err) {
    return null;
  }
}

function decodePdfEscapes(text) {
  return String(text || "")
    .replace(/\\([()\\])/g, "$1")
    .replace(/\\n/g, "\n")
    .replace(/\\r/g, "\r")
    .replace(/\\t/g, "\t")
    .replace(/\\b/g, "\b")
    .replace(/\\f/g, "\f")
    .replace(/\\([0-7]{1,3})/g, function (_, octal) {
      return String.fromCharCode(parseInt(octal, 8));
    });
}

function extractPdfStrings(content) {
  var results = [];
  var text = String(content || "");
  var re = /\((?:\\.|[^\\()])*\)\s*(?:Tj|TJ|'|")/g;
  var match;
  while ((match = re.exec(text))) {
    var token = match[0];
    var start = token.indexOf("(");
    var end = token.lastIndexOf(")");
    if (start < 0 || end <= start) continue;
    results.push(decodePdfEscapes(token.slice(start + 1, end)));
  }

  var arrayRe = /\[(.*?)\]\s*TJ/gs;
  while ((match = arrayRe.exec(text))) {
    var inner = match[1] || "";
    var stringRe = /\((?:\\.|[^\\()])*\)/g;
    var strMatch;
    while ((strMatch = stringRe.exec(inner))) {
      results.push(decodePdfEscapes(strMatch[0].slice(1, -1)));
    }
  }

  return results;
}

async function extractPdfTextFromBase64(dataBase64) {
  var bytes = base64ToBytes(dataBase64);
  var binary = bytesToLatin1(bytes);
  var pieces = extractPdfStrings(binary);
  var streamRe = /<<(.*?)>>\s*stream\r?\n/gs;
  var match;

  while ((match = streamRe.exec(binary))) {
    var dictText = match[1] || "";
    var streamStart = match.index + match[0].length;
    var endIndex = binary.indexOf("endstream", streamStart);
    if (endIndex < 0) continue;
    var streamBytes = bytes.slice(streamStart, endIndex);
    if (streamBytes[0] === 0x0d && streamBytes[1] === 0x0a) streamBytes = streamBytes.slice(2);
    else if (streamBytes[0] === 0x0a) streamBytes = streamBytes.slice(1);
    if (streamBytes.length > 1 && streamBytes[streamBytes.length - 2] === 0x0d && streamBytes[streamBytes.length - 1] === 0x0a) {
      streamBytes = streamBytes.slice(0, -2);
    } else if (streamBytes.length > 0 && streamBytes[streamBytes.length - 1] === 0x0a) {
      streamBytes = streamBytes.slice(0, -1);
    }

    var decodedBytes = streamBytes;
    if (/FlateDecode/.test(dictText)) {
      var inflated = await inflatePdfBytes(streamBytes);
      if (inflated && inflated.length) decodedBytes = inflated;
    }
    pieces = pieces.concat(extractPdfStrings(bytesToLatin1(decodedBytes)));
  }

  return pieces
    .join(" ")
    .replace(/\s+/g, " ")
    .replace(/[^\x09\x0a\x0d\x20-\x7e]/g, " ")
    .trim();
}

function buildResumeSkeletonFromProfile(profile) {
  var normalizedProfile = normalizeProfile(profile);
  var fullName = profileFullName(normalizedProfile);
  return normalizeResumeShape({
    personal: {
      name: fullName,
      email: normalizedProfile.email || "",
      phone: normalizedProfile.phone || "",
      linkedin: normalizedProfile.linkedin || "",
      github: normalizedProfile.github || "",
      location: [normalizedProfile.address.city, normalizedProfile.address.state].filter(Boolean).join(", "),
    },
    education: normalizedProfile.university || normalizedProfile.degree ? [{
      institution: normalizedProfile.university || "",
      degree: normalizedProfile.degree || "",
      expected: [normalizedProfile.graduation_month, normalizedProfile.graduation_year].filter(Boolean).join(" "),
      gpa: normalizedProfile.gpa || "",
      coursework: [],
      awards: [],
    }] : [],
  });
}

async function getCachedParsedResume(fingerprint) {
  await ensureArchiveReady();
  var cached = await ArchiveDB.getResumeParseCache(fingerprint);
  return cached && cached.resume ? cached : null;
}

async function saveParsedResumeCache(entry) {
  await ensureArchiveReady();
  await ArchiveDB.setResumeParseCache(entry);
}

async function getApiUsageDashboard() {
  await ensureArchiveReady();
  const summary = (await ArchiveDB.getUsageSummary()) || createEmptyUsageSummary();
  const events = await ArchiveDB.getAllUsageEvents();
  const recent = {};
  const sinceDate = new Date();
  sinceDate.setDate(sinceDate.getDate() - 13);

  events.forEach(function (eventRecord) {
    if (!eventRecord.timestamp) return;
    const eventDate = new Date(eventRecord.timestamp);
    if (eventDate < sinceDate) return;
    const day = eventRecord.timestamp.slice(0, 10);
    if (!recent[day]) recent[day] = { date: day, totalTokens: 0, approxCostUsd: 0, byOperation: {} };
    if (!recent[day].byOperation[eventRecord.operation]) {
      recent[day].byOperation[eventRecord.operation] = {
        requests: 0,
        totalTokens: 0,
        approxCostUsd: 0,
      };
    }
    const totalTokens = (Number(eventRecord.promptTokens) || 0) + (Number(eventRecord.completionTokens) || 0);
    recent[day].totalTokens += totalTokens;
    recent[day].approxCostUsd = Number((recent[day].approxCostUsd + (Number(eventRecord.approxCostUsd) || 0)).toFixed(6));
    recent[day].byOperation[eventRecord.operation].requests += 1;
    recent[day].byOperation[eventRecord.operation].totalTokens += totalTokens;
    recent[day].byOperation[eventRecord.operation].approxCostUsd = Number((recent[day].byOperation[eventRecord.operation].approxCostUsd + (Number(eventRecord.approxCostUsd) || 0)).toFixed(6));
  });

  const timeline = Object.values(recent).sort(function (a, b) {
    return String(a.date).localeCompare(String(b.date));
  });

  return {
    summary: summary,
    timeline: timeline,
    pricing: cloneJson(MODEL_PRICING),
  };
}

async function getApiKey() {
  const result = await chrome.storage.local.get(STORAGE_KEYS.API_KEY);
  return result[STORAGE_KEYS.API_KEY] || "";
}

async function isLlmEnabled() {
  const result = await chrome.storage.local.get(STORAGE_KEYS.LLM_ENABLED);
  return result[STORAGE_KEYS.LLM_ENABLED] === true;
}

async function saveLog(log) {
  await chrome.storage.local.set({ [STORAGE_KEYS.LAST_FILL_LOG]: log });
}

const DEFAULT_STYLE_PROFILE =
  "Tone: direct, technical, not overly formal. No buzzwords like \"passionate\" or \"leverage\".\n" +
  "Length: 3 short paragraphs max.\n" +
  "Always mention: my competitive programming background when relevant to problem-solving roles.\n" +
  "Never mention: salary expectations, references to being a fast learner.\n" +
  'Opening style: lead with a specific thing about the company or role, not "I am writing to apply for".\n' +
  'Closing style: one confident sentence, no "thank you for your consideration" filler.';

async function getStyleProfile() {
  const result = await chrome.storage.local.get(STORAGE_KEYS.STYLE_PROFILE);
  return result[STORAGE_KEYS.STYLE_PROFILE] || DEFAULT_STYLE_PROFILE;
}

async function saveStyleProfile(text) {
  await chrome.storage.local.set({ [STORAGE_KEYS.STYLE_PROFILE]: text });
}

// ---- LLM field mapping (optional) -----------------------------------------

const FIELD_MAP_PROMPT =
  "You are an expert at filling out online job-application forms.\n\n" +
  "You will receive two things:\n" +
  "1. A list of form fields found on the current page (label, selector, type, options, etc.).\n" +
  "2. The applicant's full profile (contact info, education, work experience, skills, etc.).\n\n" +
  "Map these form fields to the applicant profile below.\n" +
  "For each field return:\n" +
  '{ "field_label": "...", "selector": "...", "value": "...", "confidence": 0.0-1.0 }\n\n' +
  "Rules:\n" +
  "- Use EXACT selector strings from the field list — never invent selectors.\n" +
  "- For native_select fields the value MUST be one of the provided option values.\n" +
  "- For custom_select fields choose ONLY a provided option text/value when options are available. Never return free text for a dropdown.\n" +
  '- For file-upload fields set value to "__FILE_UPLOAD__" with confidence 1.0.\n' +
  '- Set confidence < 0.8 and value "__PAUSE__" for anything ambiguous or not in the profile.\n' +
  "- Return ONLY a JSON array, no markdown fences, no commentary.";

function stripMarkdownFences(text) {
  const match = text.match(/```(?:json)?\s*([\s\S]*?)```/);
  if (match) return match[1].trim();
  return text.trim();
}

function normalizeDropdownMappingValue(field, rawValue) {
  var value = String(rawValue || "").trim();
  if (!value || value === "__PAUSE__") return "";
  var options = Array.isArray(field && field.options) ? field.options : [];
  var normalizedValue = normalizeComparableText(value);

  if (!options.length) {
    return field && field.control_kind === "custom_select" ? value : "";
  }

  for (var i = 0; i < options.length; i++) {
    var option = options[i] || {};
    if (normalizeComparableText(option.value) === normalizedValue || normalizeComparableText(option.text) === normalizedValue) {
      return field.control_kind === "native_select" ? String(option.value || "") : String(option.text || option.value || "");
    }
  }

  return "";
}

function attachFieldMetadataToMappings(fields, mappings) {
  var bySelector = {};
  (fields || []).forEach(function (field) {
    if (field && field.selector) bySelector[field.selector] = field;
  });

  return (mappings || []).map(function (mapping) {
    var field = mapping && mapping.selector ? bySelector[mapping.selector] : null;
    if (!field) return mapping;

    var next = mergeObjects(mapping || {}, {
      control_kind: field.control_kind || "",
      tag: field.tag || "",
      options: cloneJson(field.options || []),
      interaction: cloneJson(field.interaction || null),
    });

    if (field.control_kind === "native_select" || field.control_kind === "custom_select") {
      var normalized = normalizeDropdownMappingValue(field, mapping.value);
      if (normalized) {
        next.value = normalized;
      } else if (String(mapping.value || "").trim()) {
        next.reason = field.control_kind === "native_select"
          ? "option not found"
          : "unsupported or unmatched dropdown option";
        next.confidence = Math.min(Number(mapping.confidence) || 0, 0.3);
        next.value = "";
      }
    }

    return next;
  });
}

/**
 * Call OpenAI to map unmatched fields to the profile.
 * Ported from autofill_agent.py map_fields_to_profile (lines 155-183).
 */
async function llmMapFields(unmatchedFields, profile, resume, apiKey, formLayoutHint, usageContext) {
  const fullProfile = { applicant_info: profile, resume: resume || {} };

  var pageCtx = "";
  if (formLayoutHint && typeof formLayoutHint === "object") {
    pageCtx =
      "\n\nPAGE CONTEXT (map only fields visible on this page/step; user may need to use Next/Add for other steps):\n" +
      JSON.stringify(formLayoutHint, null, 2);
  }

  const body = {
    model: DEFAULT_OPENAI_MODEL,
    messages: [
      { role: "system", content: FIELD_MAP_PROMPT },
      {
        role: "user",
        content:
          "FORM FIELDS:\n" +
          JSON.stringify(unmatchedFields, null, 2) +
          "\n\nAPPLICANT PROFILE:\n" +
          JSON.stringify(fullProfile, null, 2) +
          pageCtx,
      },
    ],
    temperature: 0.1,
  };

  const resp = await fetch("https://api.openai.com/v1/chat/completions", {
    method: "POST",
    headers: {
      "Content-Type": "application/json",
      Authorization: "Bearer " + apiKey,
    },
    body: JSON.stringify(body),
  });

  if (!resp.ok) {
    const errText = await resp.text();
    throw new Error("OpenAI API error " + resp.status + ": " + errText.substring(0, 200));
  }

  const data = await resp.json();
  await recordApiUsage(data.usage, "fieldMap", {
    model: body.model,
    jobKey: usageContext && usageContext.jobKey,
  });
  const raw = stripMarkdownFences(data.choices[0].message.content.trim());

  try {
    const mappings = JSON.parse(raw);
    if (!Array.isArray(mappings)) return [];
    return attachFieldMetadataToMappings(unmatchedFields, mappings);
  } catch (e) {
    console.warn("[JobAutofill] LLM returned invalid JSON:", raw.substring(0, 300));
    return [];
  }
}

// ---- AI Resume Optimizer prompts & helpers ---------------------------------

const JD_ANALYSIS_PROMPT =
  "ROLE: You are a precise job description parser.\n\n" +
  "TASK: Extract structured data from the job description the user provides.\n\n" +
  "INPUT FORMAT:\n" +
  "The user message contains the full text of a job description.\n\n" +
  "OUTPUT FORMAT:\n" +
  "Return ONLY valid JSON with this exact schema (every key is required):\n" +
  "{\n" +
  '  "role": string — job title exactly as written,\n' +
  '  "company": string — company name, or "Unknown",\n' +
  '  "location": string — city/state, "Remote", "Hybrid", or "Unknown",\n' +
  '  "hard_skills": array — technical skills EXPLICITLY named (never inferred); [] if none,\n' +
  '  "soft_skills": array — soft skills or traits EXPLICITLY named; [] if none,\n' +
  '  "key_responsibilities": array — top 4-6 responsibilities as concise action phrases,\n' +
  '  "required_qualifications": array — must-have qualifications; [] if none listed,\n' +
  '  "preferred_qualifications": array — nice-to-have qualifications; [] if none listed,\n' +
  '  "keywords": array — technical terms, tools, frameworks, or domain concepts that appear multiple times or carry obvious weight; EXCLUDE the job title, company name, and location (already captured above); [] if none,\n' +
  '  "tone": string — exactly one of: technical | startup | corporate | research | creative,\n' +
  '  "domain": string — exactly one of: backend | frontend | fullstack | ML/AI | data | infra | research | general SWE | other,\n' +
  '  "notes": string — visa sponsorship, clearance, team details, etc.; "" if nothing notable\n' +
  "}\n\n" +
  "RULES:\n" +
  "- Every key listed above must be present in the output.\n" +
  "- Array fields must always be arrays, never null or a string.\n" +
  '- "tone" and "domain" must be one of the allowed values exactly; choose the closest match.\n' +
  "- Do not infer or fabricate information not present in the JD.\n\n" +
  "IMPORTANT: Return ONLY valid JSON matching the schema above — no markdown fences, no commentary, no extra keys.";

const JD_ANALYSIS_REQUIRED_KEYS = [
  "role", "company", "location", "hard_skills", "soft_skills",
  "key_responsibilities", "required_qualifications", "preferred_qualifications",
  "keywords", "tone", "domain", "notes",
];

const RESUME_PARSE_PROMPT =
  "ROLE: You are a precise resume parser.\n\n" +
  "TASK: Convert resume text extracted from a PDF into the extension's normalized resume JSON.\n\n" +
  "OUTPUT FORMAT:\n" +
  "Return ONLY valid JSON with these exact top-level keys:\n" +
  '{ "personal": object, "education": array, "experience": array, "projects": array, "leadership": array, "skills": { "languages": array, "technologies": array, "concepts": array }, "certifications": array }\n\n' +
  "RULES:\n" +
  "- Use ONLY information present in the provided resume text or profile context.\n" +
  "- Never invent employers, dates, metrics, links, projects, or credentials.\n" +
  "- Keep unknown values as empty strings or empty arrays.\n" +
  "- For bullet-based sections, output arrays of objects with a text field for each bullet.\n" +
  "- Keep section arrays empty when the section does not exist.\n" +
  "- For personal, include name/email/phone/linkedin/github/location only when present.\n" +
  "- For education entries, include institution, degree, expected, gpa, coursework, awards.\n" +
  "- For experience entries, include company, title, location, start, end, headline, bullets.\n" +
  "- For project entries, include name, tech, bullets.\n" +
  "- For leadership entries, include organization, role, location, start, end, bullets.\n" +
  "- For certifications, include name when present.\n\n" +
  "IMPORTANT: Return ONLY valid JSON with the required top-level keys and no markdown fences.";

const RESUME_PARSE_REQUIRED_KEYS = [
  "personal",
  "education",
  "experience",
  "projects",
  "leadership",
  "skills",
  "certifications",
];

const RESUME_TAILOR_PROMPT =
  "ROLE: You are an expert resume writer and ATS optimization specialist.\n\n" +
  "TASK: Produce candidate edits for ONLY the existing work experience and project experience sections so the final resume better matches the job description analysis.\n\n" +
  "INPUT FORMAT:\n" +
  "The user message contains:\n" +
  "1. MASTER RESUME: the applicant's full resume in JSON format\n" +
  "2. JOB DESCRIPTION ANALYSIS: structured JD data with keywords, requirements, skills\n\n" +
  "OUTPUT FORMAT:\n" +
  'Return ONLY valid JSON with two top-level keys: "candidate_edits" and "requirements_gaps".\n' +
  '"candidate_edits" must have exactly this shape:\n' +
  '{\n' +
  '  "experience": [\n' +
  '    {\n' +
  '      "id": string,\n' +
  '      "headline": string (optional, only when that same entry already has a headline),\n' +
  '      "bullets": [ { "id": string, "text": string } ]\n' +
  '    }\n' +
  '  ],\n' +
  '  "projects": [\n' +
  '    {\n' +
  '      "id": string,\n' +
  '      "bullets": [ { "id": string, "text": string } ]\n' +
  '    }\n' +
  '  ]\n' +
  '}\n' +
  'Each array must reference ONLY existing resume entry ids and existing bullet ids from the master resume.\n' +
  '"requirements_gaps" is an array where each item is:\n' +
  '{ "requirement": string, "status": "met"|"partially_met"|"not_met", "notes": string }\n\n' +
  "RULES:\n" +
  "- Never invent work experience, employers, job titles, or dates.\n" +
  "- Rewrite bullet point text to mirror the JD's keywords and language where honest.\n" +
  "- You MAY reorder bullets within an existing job/project entry by returning the same bullet ids in a different order.\n" +
  "- You MAY update an experience headline ONLY if that exact resume entry already has a headline.\n" +
  "- Do NOT change personal, education, skills, leadership, certifications, titles, companies, dates, locations, section order, entry order, or bullet ids.\n" +
  "- Do NOT add or remove experience entries, projects, or bullets.\n" +
  "- Do NOT create synthetic/generated projects.\n" +
  "- If a requirement cannot be honestly addressed by rewriting existing experience/project bullets, leave it as not_met.\n\n" +
  "IMPORTANT: Return ONLY valid JSON matching the schema above — no markdown fences, no commentary, no extra keys.";

const COVER_LETTER_PROMPT =
  "ROLE: You are a cover letter writer. You write in the voice of the applicant based on their style profile. You produce cover letters that feel human, specific, and direct.\n\n" +
  "TASK: Write a cover letter for the given job based on the applicant's resume and style preferences.\n\n" +
  "INPUT FORMAT:\n" +
  "The user message contains:\n" +
  "1. STYLE PROFILE: the applicant's writing preferences and constraints\n" +
  "2. RESUME SUMMARY: the applicant's resume in JSON format\n" +
  "3. JOB DESCRIPTION ANALYSIS: structured JD data\n\n" +
  "OUTPUT FORMAT:\n" +
  "Return ONLY the cover letter text — no subject line, no date, no address block, no markdown formatting.\n\n" +
  "RULES:\n" +
  "- Follow the style profile strictly.\n" +
  "- 2-3 paragraphs maximum. Never exceed 3 paragraphs.\n" +
  "- Reference specific things from the job description (company name, role, 1-2 responsibilities).\n" +
  "- Pull 2 relevant experience callouts from the resume — be specific, use numbers if available.\n" +
  '- Do not use hollow phrases: "passionate", "excited to", "leverage", "synergy", "team player".\n' +
  "- Do not restate the resume — the letter adds context the resume cannot.\n" +
  "- Opening: lead with something specific about the company or role.\n" +
  '- Closing: one confident sentence. No "thank you for your consideration" filler.\n\n' +
  "IMPORTANT: Return ONLY the cover letter text, nothing else.";

const COVER_LETTER_SHORTEN_PROMPT =
  "ROLE: You are editing a cover letter to fit on exactly one printed page.\n\n" +
  "TASK: Rewrite the letter more compactly while preserving the same truthful claims, tone, company/role specificity, and concrete evidence.\n\n" +
  "RULES:\n" +
  "- Keep the same overall meaning.\n" +
  "- Remove filler, repeated setup, and unnecessary transitions.\n" +
  "- Use 2-3 short paragraphs max.\n" +
  "- Keep it human and specific.\n" +
  "- Return ONLY the revised cover letter text.";

const RESUME_EDITS_SHORTEN_PROMPT =
  "ROLE: You are tightening resume bullet edits to preserve a fixed one-page layout.\n\n" +
  "TASK: Rewrite only the edited headlines and bullet texts more compactly while keeping them truthful, specific, and aligned to the job description.\n\n" +
  "OUTPUT: Return ONLY valid JSON with the exact same shape and ids as the provided candidate_edits object.\n\n" +
  "RULES:\n" +
  "- Keep all ids unchanged.\n" +
  "- Do not add or remove bullets, items, or sections.\n" +
  "- Keep the same meaning and evidence.\n" +
  "- Prefer shorter phrasing, fewer filler words, and tighter verbs.\n" +
  "- Return ONLY valid JSON.";

/**
 * Shared OpenAI API wrapper — single source of truth for model config,
 * format enforcement, parsing, validation, and retry logic.
 */
async function callOpenAi({ systemPrompt, userContent, apiKey, expectJson, requiredKeys, temperature, operation, model, jobKey }) {
  const messages = [
    { role: "system", content: systemPrompt },
    { role: "user", content: userContent },
  ];

  async function doFetch(msgs, temp) {
    const body = {
      model: model || DEFAULT_OPENAI_MODEL,
      temperature: temp,
      messages: msgs,
    };
    if (expectJson) {
      body.response_format = { type: "json_object" };
    }

    const resp = await fetch("https://api.openai.com/v1/chat/completions", {
      method: "POST",
      headers: {
        "Content-Type": "application/json",
        Authorization: "Bearer " + apiKey,
      },
      body: JSON.stringify(body),
    });

    if (!resp.ok) {
      const errText = await resp.text();
      throw new Error("OpenAI API error " + resp.status + ": " + errText.substring(0, 300));
    }

    const data = await resp.json();
    await recordApiUsage(data.usage, operation, {
      model: body.model,
      jobKey: jobKey || "",
    });
    return data.choices[0].message.content.trim();
  }

  const raw = await doFetch(messages, temperature);
  const cleaned = stripMarkdownFences(raw);

  if (!expectJson) {
    return cleaned;
  }

  // Parse JSON and validate
  let parsed;
  try {
    parsed = JSON.parse(cleaned);
  } catch (parseErr) {
    console.warn("[JobAutofill] callOpenAi: JSON parse failed, retrying. Raw:", cleaned.substring(0, 300));
    // Retry once with correction message at temperature 0
    const retryMessages = [
      ...messages,
      { role: "assistant", content: raw },
      { role: "user", content: "Your previous response was invalid JSON. Error: " + parseErr.message + ". Please output ONLY valid JSON matching the schema." },
    ];
    const retryRaw = await doFetch(retryMessages, 0.0);
    const retryCleaned = stripMarkdownFences(retryRaw);
    parsed = JSON.parse(retryCleaned);
  }

  // Validate required keys
  if (requiredKeys && requiredKeys.length > 0) {
    const missing = requiredKeys.filter((k) => !(k in parsed));
    if (missing.length > 0) {
      console.warn("[JobAutofill] callOpenAi: missing keys:", missing, "— retrying");
      const retryMessages = [
        ...messages,
        { role: "assistant", content: raw },
        { role: "user", content: "Your response is missing required keys: " + missing.join(", ") + ". Please output the complete JSON with ALL required keys." },
      ];
      const retryRaw = await doFetch(retryMessages, 0.0);
      const retryCleaned = stripMarkdownFences(retryRaw);
      const retryParsed = JSON.parse(retryCleaned);
      const stillMissing = requiredKeys.filter((k) => !(k in retryParsed));
      if (stillMissing.length > 0) {
        throw new Error("LLM response still missing keys after retry: " + stillMissing.join(", "));
      }
      return retryParsed;
    }
  }

  return parsed;
}

async function analyzeJd(jdText, apiKey, jobKey) {
  return await callOpenAi({
    systemPrompt: JD_ANALYSIS_PROMPT,
    userContent: jdText,
    apiKey,
    expectJson: true,
    requiredKeys: JD_ANALYSIS_REQUIRED_KEYS,
    temperature: 0.1,
    operation: "jdAnalysis",
    model: DEFAULT_OPENAI_MODEL,
    jobKey: jobKey || "",
  });
}

async function parseResumeTextWithOpenAi(resumeText, profile, apiKey, jobKey) {
  var normalizedProfile = normalizeProfile(profile);
  var userContent =
    "PROFILE CONTEXT:\n" + JSON.stringify({
      full_name: profileFullName(normalizedProfile),
      email: normalizedProfile.email,
      phone: normalizedProfile.phone,
      linkedin: normalizedProfile.linkedin,
      github: normalizedProfile.github,
      location: [normalizedProfile.address.city, normalizedProfile.address.state].filter(Boolean).join(", "),
    }, null, 2) + "\n\n" +
    "RESUME TEXT:\n" + resumeText;

  var parsed = await callOpenAi({
    systemPrompt: RESUME_PARSE_PROMPT,
    userContent: userContent,
    apiKey: apiKey,
    expectJson: true,
    requiredKeys: RESUME_PARSE_REQUIRED_KEYS,
    temperature: 0.1,
    operation: "resumeParse",
    model: DEFAULT_OPENAI_MODEL,
    jobKey: jobKey || "",
  });

  return ensureResumeIds(mergeProfileIntoResume(parsed, normalizedProfile));
}

// ---- LLM-powered qualification gap check ------------------------------------

const REQUIREMENTS_GAP_PROMPT =
  "ROLE: You are an expert resume screener.\n\n" +
  "TASK: For each job requirement provided, determine whether the candidate's resume demonstrates that they meet it.\n\n" +
  "INPUT: You receive a candidate resume (JSON) and a list of job requirements (strings).\n\n" +
  "OUTPUT: Return ONLY valid JSON with this schema:\n" +
  '{ "results": [ { "requirement": string, "status": "met"|"partially_met"|"not_met", "reason": string } ] }\n\n' +
  "RULES:\n" +
  "- Base your judgment ONLY on evidence present in the resume. Do not assume or infer facts not stated.\n" +
  "- A completed degree satisfies enrollment/coursework requirements for that degree level.\n" +
  "- Work experience with a technology counts as skill evidence even if not listed under skills.\n" +
  "- 'met' = resume clearly demonstrates the requirement is satisfied.\n" +
  "- 'partially_met' = resume shows related but not exact evidence.\n" +
  "- 'not_met' = no evidence in the resume for this requirement.\n" +
  "- 'reason' should be 1 concise sentence citing the relevant resume evidence (or lack thereof).\n" +
  "- Return one result per requirement, in the same order as the input list.\n\n" +
  "IMPORTANT: Return ONLY valid JSON — no markdown fences, no commentary.";

async function llmCheckQualifications(resume, qualifications, skills, keywords, apiKey, jobKey) {
  var allRequirements = []
    .concat(qualifications || [])
    .concat((skills || []).map(function (s) { return "Skill: " + s; }))
    .concat((keywords || []).map(function (k) { return "Keyword/technology: " + k; }));

  if (allRequirements.length === 0) {
    return { qualifications: [], skills: [], keywords: [] };
  }

  var userContent =
    "CANDIDATE RESUME:\n" + JSON.stringify(resume, null, 2) + "\n\n" +
    "JOB REQUIREMENTS:\n" + JSON.stringify(allRequirements, null, 2);

  var parsed = await callOpenAi({
    systemPrompt: REQUIREMENTS_GAP_PROMPT,
    userContent: userContent,
    apiKey: apiKey,
    expectJson: true,
    requiredKeys: ["results"],
    temperature: 0.1,
    operation: "gapCheck",
    model: DEFAULT_OPENAI_MODEL,
    jobKey: jobKey || "",
  });

  var results = parsed.results || [];

  var qualCount = (qualifications || []).length;
  var skillCount = (skills || []).length;

  return {
    qualifications: results.slice(0, qualCount),
    skills: results.slice(qualCount, qualCount + skillCount),
    keywords: results.slice(qualCount + skillCount),
  };
}

async function tailorResume(masterResume, jdAnalysis, apiKey, jobKey) {
  const userContent =
    "MASTER RESUME:\n" + JSON.stringify(masterResume, null, 2) + "\n\n" +
    "JOB DESCRIPTION ANALYSIS:\n" + JSON.stringify(jdAnalysis, null, 2) + "\n\n" +
    "Produce the candidate experience/project edits now.";

  return await callOpenAi({
    systemPrompt: RESUME_TAILOR_PROMPT,
    userContent,
    apiKey,
    expectJson: true,
    requiredKeys: ["candidate_edits", "requirements_gaps"],
    temperature: 0.2,
    operation: "tailorResume",
    model: DEFAULT_OPENAI_MODEL,
    jobKey: jobKey || "",
  });
}

async function generateCoverLetterText(masterResume, jdAnalysis, styleProfile, apiKey, jobKey) {
  const userContent =
    "STYLE PROFILE:\n" + styleProfile + "\n\n" +
    "RESUME SUMMARY:\n" + JSON.stringify(masterResume, null, 2) + "\n\n" +
    "JOB DESCRIPTION ANALYSIS:\n" + JSON.stringify(jdAnalysis, null, 2) + "\n\n" +
    "Write the cover letter now.";

  const text = await callOpenAi({
    systemPrompt: COVER_LETTER_PROMPT,
    userContent,
    apiKey,
    expectJson: false,
    temperature: 0.5,
    operation: "coverLetter",
    model: DEFAULT_OPENAI_MODEL,
    jobKey: jobKey || "",
  });

  // Validate paragraph count — if > 3 paragraphs, trim to 3
  const paragraphs = text.split(/\n\s*\n/).filter((p) => p.trim().length > 0);
  if (paragraphs.length > 3) {
    return paragraphs.slice(0, 3).join("\n\n");
  }
  return text;
}

async function shortenCoverLetterText(coverLetterText, jdAnalysis, styleProfile, apiKey, jobKey) {
  const userContent =
    "STYLE PROFILE:\n" + styleProfile + "\n\n" +
    "JOB DESCRIPTION ANALYSIS:\n" + JSON.stringify(jdAnalysis || {}, null, 2) + "\n\n" +
    "CURRENT COVER LETTER:\n" + String(coverLetterText || "").trim();

  return await callOpenAi({
    systemPrompt: COVER_LETTER_SHORTEN_PROMPT,
    userContent,
    apiKey,
    expectJson: false,
    temperature: 0.2,
    operation: "coverLetter",
    model: DEFAULT_OPENAI_MODEL,
    jobKey: jobKey || "",
  });
}

async function shortenResumeCandidateEdits(originalResume, candidateEdits, jdAnalysis, apiKey, jobKey) {
  const userContent =
    "MASTER RESUME:\n" + JSON.stringify(originalResume || {}, null, 2) + "\n\n" +
    "JOB DESCRIPTION ANALYSIS:\n" + JSON.stringify(jdAnalysis || {}, null, 2) + "\n\n" +
    "CURRENT CANDIDATE_EDITS:\n" + JSON.stringify(candidateEdits || {}, null, 2);

  return await callOpenAi({
    systemPrompt: RESUME_EDITS_SHORTEN_PROMPT,
    userContent,
    apiKey,
    expectJson: true,
    requiredKeys: ["experience", "projects"],
    temperature: 0.2,
    operation: "tailorResume",
    model: DEFAULT_OPENAI_MODEL,
    jobKey: jobKey || "",
  });
}

function computeResumeDiff(original, tailored) {
  const diff = [];
  for (const sectionKey of ["experience", "projects"]) {
    const origItems = original[sectionKey] || [];
    const tailItems = tailored[sectionKey] || [];
    const origById = {};
    for (const item of origItems) {
      if (item.id) origById[item.id] = item;
    }

    for (const tailItem of tailItems) {
      const origItem = tailItem.id ? origById[tailItem.id] : null;
      const header = sectionKey === "experience"
        ? (tailItem.title || "") + " @ " + (tailItem.company || "")
        : (tailItem.name || tailItem.id || "Unknown");

      const entry = { section: sectionKey, header, bullets: [] };

      if (
        sectionKey === "experience" &&
        origItem &&
        String(origItem.headline || "") !== String(tailItem.headline || "")
      ) {
        entry.bullets.push({
          type: "headline_changed",
          origText: String(origItem.headline || ""),
          newText: String(tailItem.headline || ""),
        });
      }

      const origBulletsById = {};
      if (origItem) {
        for (const b of (origItem.bullets || [])) {
          if (b.id) origBulletsById[b.id] = b.text;
        }
      }

      for (const bullet of (tailItem.bullets || [])) {
        const origText = bullet.id ? origBulletsById[bullet.id] : undefined;
        const newText = bullet.text || "";

        if (origText === undefined) {
          entry.bullets.push({ type: "added", newText });
        } else if (origText === newText) {
          entry.bullets.push({ type: "unchanged", newText });
        } else {
          entry.bullets.push({ type: "changed", origText, newText });
        }
      }

      if (entry.bullets.some((b) => b.type !== "unchanged")) {
        diff.push(entry);
      }
    }
  }
  return diff;
}

function normalizeEditableBullets(bullets) {
  if (!Array.isArray(bullets)) return [];
  return bullets.map(function (bullet) {
    if (typeof bullet === "string") return { text: bullet };
    return cloneJson(bullet) || {};
  });
}

function mergeEditableSectionItems(originalItems, candidateItems, allowHeadline) {
  var candidateById = {};
  (candidateItems || []).forEach(function (item) {
    if (item && item.id) candidateById[item.id] = item;
  });

  return (originalItems || []).map(function (originalItem) {
    var nextItem = cloneJson(originalItem) || {};
    var candidate = originalItem && originalItem.id ? candidateById[originalItem.id] : null;
    if (!candidate) return nextItem;

    if (
      allowHeadline &&
      typeof nextItem.headline === "string" &&
      typeof candidate.headline === "string" &&
      candidate.headline.trim()
    ) {
      nextItem.headline = candidate.headline.trim();
    }

    var originalBullets = normalizeEditableBullets(originalItem.bullets || []);
    if (!originalBullets.length) return nextItem;

    var originalBulletsById = {};
    originalBullets.forEach(function (bullet) {
      if (bullet && bullet.id) originalBulletsById[bullet.id] = cloneJson(bullet);
    });

    var mergedBullets = [];
    var seenBulletIds = {};

    normalizeEditableBullets(candidate.bullets || []).forEach(function (candidateBullet) {
      var bulletId = candidateBullet && candidateBullet.id;
      if (!bulletId || !originalBulletsById[bulletId] || seenBulletIds[bulletId]) return;
      var nextBullet = cloneJson(originalBulletsById[bulletId]);
      var nextText = String(candidateBullet.text || "").trim();
      if (nextText) nextBullet.text = nextText;
      mergedBullets.push(nextBullet);
      seenBulletIds[bulletId] = true;
    });

    originalBullets.forEach(function (originalBullet) {
      var bulletId = originalBullet && originalBullet.id;
      if (bulletId && seenBulletIds[bulletId]) return;
      mergedBullets.push(cloneJson(originalBullet));
    });

    nextItem.bullets = mergedBullets;
    return nextItem;
  });
}

function applyTailorGuardrails(originalResume, candidateEdits) {
  var frozenResume = cloneJson(originalResume) || {};
  var edits = candidateEdits || {};

  frozenResume.experience = mergeEditableSectionItems(
    originalResume && originalResume.experience,
    edits.experience,
    true
  );
  frozenResume.projects = mergeEditableSectionItems(
    originalResume && originalResume.projects,
    edits.projects,
    false
  );

  return frozenResume;
}

function buildResumeLineBindings(lines, resume) {
  var available = (lines || []).map(function (line) {
    return {
      id: line.id,
      text: line.text || "",
      normalized: normalizeComparableText(line.text || ""),
    };
  });
  var used = {};

  function bindText(text) {
    var normalized = normalizeComparableText(text);
    if (!normalized) return "";

    var exact = available.find(function (line) {
      return !used[line.id] && line.normalized === normalized;
    });
    if (exact) {
      used[exact.id] = true;
      return exact.id;
    }

    var contains = available.find(function (line) {
      return !used[line.id] && (line.normalized.indexOf(normalized) !== -1 || normalized.indexOf(line.normalized) !== -1);
    });
    if (contains) {
      used[contains.id] = true;
      return contains.id;
    }

    var bestId = "";
    var bestScore = 0;
    available.forEach(function (line) {
      if (used[line.id]) return;
      var score = comparableOverlapScore(normalized, line.normalized);
      if (score > bestScore) {
        bestScore = score;
        bestId = line.id;
      }
    });
    if (bestId && bestScore >= 0.45) {
      used[bestId] = true;
      return bestId;
    }
    return "";
  }

  function sectionBindings(items, sectionKey) {
    return (items || []).map(function (item) {
      return {
        id: item.id,
        section: sectionKey,
        headlineLineId: item.headline ? bindText(item.headline) : "",
        bulletLineIds: (item.bullets || []).map(function (bullet) {
          return {
            id: bullet.id,
            lineId: bindText(bullet.text || ""),
          };
        }),
      };
    });
  }

  return {
    experience: sectionBindings(resume && resume.experience, "experience"),
    projects: sectionBindings(resume && resume.projects, "projects"),
  };
}

function applyCandidateEditsToCanonicalResumeHtml(html, originalResume, candidateEdits) {
  var meta = extractCanonicalResumeMeta(html);
  if (!meta || !Array.isArray(meta.lines) || !meta.lines.length) return null;

  var linesById = {};
  meta.lines.forEach(function (line) {
    linesById[line.id] = cloneJson(line);
  });
  var bindings = buildResumeLineBindings(meta.lines, originalResume);

  function applySection(sectionKey) {
    var editsById = {};
    (candidateEdits && candidateEdits[sectionKey] || []).forEach(function (item) {
      if (item && item.id) editsById[item.id] = item;
    });
    (bindings[sectionKey] || []).forEach(function (binding) {
      var edit = editsById[binding.id];
      if (!edit) return;
      if (binding.headlineLineId && typeof edit.headline === "string" && linesById[binding.headlineLineId]) {
        linesById[binding.headlineLineId].text = edit.headline.trim();
      }
      var bulletEditById = {};
      (edit.bullets || []).forEach(function (bullet) {
        if (bullet && bullet.id) bulletEditById[bullet.id] = bullet;
      });
      (binding.bulletLineIds || []).forEach(function (bulletBinding) {
        var bulletEdit = bulletEditById[bulletBinding.id];
        if (!bulletEdit || !bulletBinding.lineId || !linesById[bulletBinding.lineId]) return;
        if (bulletEdit.text && String(bulletEdit.text).trim()) {
          linesById[bulletBinding.lineId].text = String(bulletEdit.text).trim();
        }
      });
    });
  }

  applySection("experience");
  applySection("projects");

  var nextMeta = cloneJson(meta);
  nextMeta.lines = meta.lines.map(function (line) {
    return linesById[line.id] || line;
  });

  return {
    html: buildCanonicalResumeHtml(nextMeta),
    meta: nextMeta,
    bindings: bindings,
  };
}

async function resolveActiveResumeContext(jobKey, options) {
  var opts = options || {};
  var profile = normalizeProfile(opts.profile || await getProfile());
  var storedResume = opts.storedResume || await getResume();
  var sourceType = storedResume ? "optionsResumeJson" : "profileOnly";
  var sourceName = storedResume ? "Resume JSON from Options" : "Profile fallback";
  var sourceDoc = null;

  if (jobKey) {
    var bucket = await getJobDocumentBucket(jobKey);
    var edited = bucket && Array.isArray(bucket.editedResumes) ? bucket.editedResumes : [];
    if (edited.length > 0) {
      sourceDoc = edited[0];
      sourceType = "jobResumePdf";
      sourceName = sourceDoc.name || "Active job resume";
    }
  }

  if (!sourceDoc) {
    var basePdf = await getBaseResumePdf();
    if (basePdf && basePdf.dataBase64) {
      sourceDoc = basePdf;
      sourceType = "baseResumePdf";
      sourceName = basePdf.name || "Base resume PDF";
    }
  }

  var uploadPayload = sourceDoc ? extractResumeDownloadPayload(sourceDoc) : null;
  var uploadFile = uploadPayload ? {
    dataBase64: uploadPayload.dataBase64,
    name: uploadPayload.name || "resume.pdf",
    mime: uploadPayload.mime || "application/pdf",
    id: sourceDoc.id || "",
    createdAt: sourceDoc.createdAt || null,
  } : null;

  var structuredResume = storedResume ? ensureResumeIds(mergeProfileIntoResume(storedResume, profile)) : null;
  var fallbackResume = structuredResume;
  var htmlSource = sourceDoc ? canonicalHtmlSourceForDoc(sourceDoc) : null;
  var parseMeta = {
    attempted: false,
    ok: false,
    cached: false,
    fallbackUsed: !structuredResume,
    fingerprint: "",
    sourceType: sourceType,
    sourceName: sourceName,
    sourceFormat: htmlSource ? "html" : (sourceDoc ? "pdf" : (storedResume ? "json" : "profile")),
    hasCanonicalHtml: !!htmlSource,
    canonicalPageCount: sourceDoc && sourceDoc.canonicalHtmlPageCount ? sourceDoc.canonicalHtmlPageCount : 0,
  };

  if (htmlSource && htmlSource.dataBase64 && opts.allowParse !== false && opts.apiKey) {
    parseMeta.attempted = true;
    try {
      var fingerprint = await sha256HexForBase64(htmlSource.dataBase64);
      parseMeta.fingerprint = fingerprint;
      var cached = await getCachedParsedResume(fingerprint);
      if (cached && cached.resume) {
        structuredResume = ensureResumeIds(mergeProfileIntoResume(cached.resume, profile));
        parseMeta.ok = true;
        parseMeta.cached = true;
        parseMeta.fallbackUsed = false;
      } else {
        var resumeText = resumeTextFromCanonicalHtml(base64ToUtf8(htmlSource.dataBase64));
        if (resumeText && resumeText.length >= 80) {
          var parsedResume = await parseResumeTextWithOpenAi(resumeText, profile, opts.apiKey, jobKey);
          structuredResume = parsedResume;
          parseMeta.ok = true;
          parseMeta.fallbackUsed = false;
          await saveParsedResumeCache({
            fingerprint: fingerprint,
            sourceType: sourceType,
            sourceName: sourceName,
            updatedAt: new Date().toISOString(),
            resume: parsedResume,
          });
        }
      }
    } catch (err) {
      parseMeta.error = err && err.message ? err.message : String(err);
    }
  } else if (sourceDoc && sourceDoc.dataBase64 && opts.allowParse !== false && opts.apiKey) {
    parseMeta.attempted = true;
    try {
      var pdfFingerprint = await sha256HexForBase64(sourceDoc.dataBase64);
      parseMeta.fingerprint = pdfFingerprint;
      var cachedPdf = await getCachedParsedResume(pdfFingerprint);
      if (cachedPdf && cachedPdf.resume) {
        structuredResume = ensureResumeIds(mergeProfileIntoResume(cachedPdf.resume, profile));
        parseMeta.ok = true;
        parseMeta.cached = true;
        parseMeta.fallbackUsed = false;
      } else {
        var pdfText = await extractPdfTextFromBase64(sourceDoc.dataBase64);
        if (pdfText && pdfText.length >= 80) {
          var parsedFromPdf = await parseResumeTextWithOpenAi(pdfText, profile, opts.apiKey, jobKey);
          structuredResume = parsedFromPdf;
          parseMeta.ok = true;
          parseMeta.fallbackUsed = false;
          await saveParsedResumeCache({
            fingerprint: pdfFingerprint,
            sourceType: sourceType,
            sourceName: sourceName,
            updatedAt: new Date().toISOString(),
            resume: parsedFromPdf,
          });
        }
      }
    } catch (pdfErr) {
      parseMeta.error = pdfErr && pdfErr.message ? pdfErr.message : String(pdfErr);
    }
  }

  if (sourceDoc && !parseMeta.ok && fallbackResume) {
    structuredResume = fallbackResume;
    parseMeta.fallbackUsed = true;
  }

  if (!structuredResume) {
    structuredResume = ensureResumeIds(buildResumeSkeletonFromProfile(profile));
    parseMeta.fallbackUsed = true;
  }

  return {
    sourceType: sourceType,
    sourceName: sourceName,
    hasUploadFile: !!uploadFile,
    uploadFile: uploadFile,
    htmlSource: htmlSource,
    sourceDoc: sourceDoc,
    structuredResume: structuredResume,
    personal: (structuredResume && structuredResume.personal) ? structuredResume.personal : {},
    parseMeta: parseMeta,
  };
}

async function handleGenerateAiDocuments(msg) {
  const apiKey = await getApiKey();
  if (!apiKey) {
    return { ok: false, error: "No OpenAI API key configured. Set it in Options." };
  }
  const llmOn = await isLlmEnabled();
  if (!llmOn) {
    return { ok: false, error: "LLM is disabled. Enable it in Options." };
  }

  const profile = await getProfile();
  const activeResume = await resolveActiveResumeContext(msg.jobKey, {
    profile: profile,
    storedResume: await getResume(),
    apiKey: apiKey,
    allowParse: true,
  });
  const resume = activeResume.structuredResume;
  if (!resume) {
    return { ok: false, error: "No resume data available. Upload a resume in Options or Documents." };
  }

  const jdText = msg.jdText;
  if (!jdText || jdText.trim().length < 30) {
    return { ok: false, error: "Could not extract job description text from this page." };
  }

  const styleProfile = await getStyleProfile();

  // Step 1: Analyze JD
  const jdAnalysis = await analyzeJd(jdText, apiKey, msg.jobKey);

  // Step 2 & 3: Tailor resume and generate cover letter in parallel
  const [tailorResult, coverLetterText] = await Promise.all([
    tailorResume(resume, jdAnalysis, apiKey, msg.jobKey),
    generateCoverLetterText(resume, jdAnalysis, styleProfile, apiKey, msg.jobKey),
  ]);

  const tailoredResume = applyTailorGuardrails(resume, tailorResult.candidate_edits || {});
  const requirementsGaps = tailorResult.requirements_gaps || [];
  const diff = computeResumeDiff(resume, tailoredResume);

  return {
    ok: true,
    tailoredResume,
    coverLetterText,
    jdAnalysis,
    requirementsGaps,
    diff,
    activeResume: {
      sourceType: activeResume.sourceType,
      sourceName: activeResume.sourceName,
      parseMeta: activeResume.parseMeta,
      personal: activeResume.personal,
    },
  };
}

function delay(ms) {
  return new Promise(function (resolve) { setTimeout(resolve, ms); });
}

function ensurePdfFilename(filename) {
  var name = String(filename || "document.pdf").trim() || "document.pdf";
  if (/\.pdf$/i.test(name)) return name;
  return name.replace(/\.[a-z0-9]+$/i, "") + ".pdf";
}

function base64ByteLength(base64) {
  var cleaned = String(base64 || "").replace(/=+$/, "");
  return Math.floor((cleaned.length * 3) / 4);
}

function waitForTabComplete(tabId) {
  return new Promise(function (resolve, reject) {
    var done = false;

    function finish(err) {
      if (done) return;
      done = true;
      chrome.tabs.onUpdated.removeListener(onUpdated);
      clearTimeout(timeoutId);
      if (err) reject(err);
      else resolve();
    }

    function onUpdated(updatedTabId, info) {
      if (updatedTabId !== tabId) return;
      if (info.status === "complete") finish();
    }

    var timeoutId = setTimeout(function () {
      finish(new Error("Timed out while waiting for PDF render tab"));
    }, 10000);

    chrome.tabs.onUpdated.addListener(onUpdated);
    chrome.tabs.get(tabId, function (tab) {
      if (chrome.runtime.lastError) {
        finish(chrome.runtime.lastError);
        return;
      }
      if (tab && tab.status === "complete") finish();
    });
  });
}

function debuggerSend(target, method, params) {
  return new Promise(function (resolve, reject) {
    chrome.debugger.sendCommand(target, method, params || {}, function (result) {
      if (chrome.runtime.lastError) {
        reject(new Error(chrome.runtime.lastError.message));
        return;
      }
      resolve(result);
    });
  });
}

async function waitForPdfReady(target) {
  for (var i = 0; i < 40; i++) {
    var result = await debuggerSend(target, "Runtime.evaluate", {
      expression:
        "(async function () {" +
        "if (document.fonts && document.fonts.ready) { try { await document.fonts.ready; } catch (e) {} }" +
        "var body = document.body || { innerText: '', innerHTML: '' };" +
        "return {" +
        "readyState: document.readyState || ''," +
        "textLength: String(body.innerText || '').trim().length," +
        "htmlLength: String(body.innerHTML || '').trim().length" +
        "};" +
        "})()",
      awaitPromise: true,
      returnByValue: true,
    });
    var value = result && result.result ? result.result.value : null;
    if (value && value.readyState === "complete" && value.htmlLength > 100 && value.textLength > 20) {
      return value;
    }
    await delay(100);
  }
  throw new Error("PDF render content did not become ready");
}

async function estimateRenderedPageMetrics(target) {
  var result = await debuggerSend(target, "Runtime.evaluate", {
    expression:
      "(function () {" +
      "var body = document.body || document.documentElement;" +
      "var page = document.querySelector('.resume-page, .page, [data-jaf-page-height]');" +
      "var pageHeight = 0;" +
      "if (page) {" +
      "  var attrHeight = parseFloat(page.getAttribute('data-jaf-page-height') || '0');" +
      "  pageHeight = attrHeight || page.clientHeight || page.getBoundingClientRect().height || 0;" +
      "}" +
      "var maxBottom = 0;" +
      "var pageTop = page ? page.getBoundingClientRect().top : 0;" +
      "var tracked = document.querySelectorAll('.jaf-editable-line, .jaf-resume-line, .body, .closing');" +
      "for (var i = 0; i < tracked.length; i++) {" +
      "  var rect = tracked[i].getBoundingClientRect();" +
      "  if (rect.bottom > maxBottom) maxBottom = rect.bottom;" +
      "}" +
      "var scrollHeight = page ? Math.max(page.scrollHeight, page.clientHeight) : Math.max(body.scrollHeight || 0, document.documentElement.scrollHeight || 0);" +
      "var effectiveHeight = maxBottom && page ? Math.max(maxBottom - pageTop, scrollHeight) : scrollHeight;" +
      "var fallbackPageHeight = pageHeight || 1056;" +
      "return {" +
      "  pageHeight: fallbackPageHeight," +
      "  contentHeight: effectiveHeight," +
      "  pageCount: Math.max(1, Math.ceil(effectiveHeight / fallbackPageHeight))" +
      "};" +
      "})()",
    returnByValue: true,
  });
  return result && result.result ? (result.result.value || { pageCount: 1, pageHeight: 1056, contentHeight: 0 }) : { pageCount: 1, pageHeight: 1056, contentHeight: 0 };
}

async function renderHtmlToPdf(msg) {
  if (!msg.html) return { ok: false, error: "Missing HTML payload" };

  var target = null;
  var tab = null;

  try {
    tab = await chrome.tabs.create({
      url: "about:blank",
      active: false,
    });
    target = { tabId: tab.id };

    await waitForTabComplete(tab.id);

    await chrome.debugger.attach(target, "1.3");
    try {
      await debuggerSend(target, "Page.enable");
      await debuggerSend(target, "Runtime.enable");
      await debuggerSend(target, "Emulation.setEmulatedMedia", { media: "print" });
      var frameTree = await debuggerSend(target, "Page.getFrameTree");
      var frameId = frameTree && frameTree.frameTree && frameTree.frameTree.frame ? frameTree.frameTree.frame.id : null;
      if (!frameId) throw new Error("Could not determine render frame");
      await debuggerSend(target, "Page.setDocumentContent", {
        frameId: frameId,
        html: String(msg.html),
      });
      await waitForPdfReady(target);
      var pageMetrics = await estimateRenderedPageMetrics(target);
      var pdfResult = await debuggerSend(target, "Page.printToPDF", {
        printBackground: true,
        preferCSSPageSize: true,
      });
      var filename = ensurePdfFilename(msg.filename);
      return {
        ok: true,
        doc: {
          id: genId("doc"),
          name: filename,
          mime: "application/pdf",
          size: base64ByteLength(pdfResult.data),
          createdAt: new Date().toISOString(),
          dataBase64: pdfResult.data,
          pageCount: pageMetrics.pageCount || 1,
          pageMetrics: pageMetrics,
        },
      };
    } finally {
      try { await chrome.debugger.detach(target); } catch (detachErr) {}
    }
  } catch (err) {
    return { ok: false, error: err && err.message ? err.message : String(err) };
  } finally {
    if (tab && tab.id) {
      try { await chrome.tabs.remove(tab.id); } catch (closeErr) {}
    }
  }
}

async function buildOptimizedResumeDocFromCanonicalHtml(activeResume, originalResume, candidateEdits, jdAnalysis, apiKey, jobKey, filenameBase) {
  if (!activeResume || !activeResume.htmlSource || !activeResume.htmlSource.dataBase64) return null;

  var sourceHtml = base64ToUtf8(activeResume.htmlSource.dataBase64);
  var workingEdits = cloneJson(candidateEdits) || { experience: [], projects: [] };
  var lastError = null;

  for (var attempt = 0; attempt < 3; attempt++) {
    var applied = applyCandidateEditsToCanonicalResumeHtml(sourceHtml, originalResume, workingEdits);
    if (!applied || !applied.html) {
      throw new Error("Could not map resume edits onto the uploaded resume layout.");
    }

    var renderResult = await renderHtmlToPdf({
      html: applied.html,
      filename: ensurePdfFilename(filenameBase || "tailored-resume.pdf"),
    });
    if (!renderResult.ok || !renderResult.doc) {
      throw new Error(renderResult.error || "Resume PDF render failed");
    }
    if ((renderResult.doc.pageCount || 1) <= 1) {
      return {
        doc: {
          id: genId("doc"),
          name: canonicalResumePdfName(filenameBase || "tailored-resume"),
          mime: "text/html",
          size: base64ByteLength(utf8StringToBase64(applied.html)),
          createdAt: new Date().toISOString(),
          dataBase64: utf8StringToBase64(applied.html),
          sourceFormat: "canonicalHtmlResume",
          canonicalHtmlName: canonicalResumeHtmlName(filenameBase || "tailored-resume"),
          canonicalHtmlPageCount: 1,
          derivedPdf: renderResult.doc,
        },
        candidateEdits: workingEdits,
      };
    }

    lastError = new Error("Resume exceeded one page after optimization.");
    workingEdits = await shortenResumeCandidateEdits(originalResume, workingEdits, jdAnalysis, apiKey, jobKey);
  }

  throw lastError || new Error("Resume could not be shortened to one page.");
}

// ---- Message handler -------------------------------------------------------

chrome.runtime.onMessage.addListener((msg, sender, sendResponse) => {
  if (!msg || !msg.action) return false;
  handleMessage(msg, sender).then(sendResponse).catch((err) => {
    console.error("[JobAutofill BG] Error:", err);
    sendResponse({ ok: false, error: String(err) });
  });
  return true; // keep channel open for async response
});

async function handleMessage(msg, sender) {
  switch (msg.action) {
    case "getProfile":
      return { ok: true, profile: await getProfile() };

    case "saveProfile":
      await chrome.storage.local.set({ [STORAGE_KEYS.PROFILE]: normalizeProfile(msg.profile) });
      return { ok: true };

    case "saveResume":
      await chrome.storage.local.set({ [STORAGE_KEYS.RESUME]: ensureResumeIds(msg.resume) });
      return { ok: true };

    case "getSettings": {
      const basePdf = await getBaseResumePdf();
      const storedResume = await getResume();
      return {
        ok: true,
        profile: await getProfile(),
        resume: storedResume,
        baseResumePdfMeta: basePdf
          ? {
              id: basePdf.id,
              name: basePdf.name,
              mime: basePdf.mime,
              size: basePdf.size,
              createdAt: basePdf.createdAt,
              hasCanonicalHtml: !!basePdf.canonicalHtmlBase64,
              canonicalPageCount: basePdf.canonicalHtmlPageCount || 0,
            }
          : null,
        resumeAvailableForAi: !!(storedResume || basePdf),
        apiKey: await getApiKey(),
        llmEnabled: await isLlmEnabled(),
        styleProfile: await getStyleProfile(),
      };
    }

    case "getApiUsage": {
      await ensureArchiveReady();
      return { ok: true, usage: (await ArchiveDB.getUsageSummary()) || createEmptyUsageSummary() };
    }

    case "resetApiUsage":
      await ensureArchiveReady();
      await ArchiveDB.clearStore("apiUsageEvents");
      await persistUsageSummary(createEmptyUsageSummary());
      return { ok: true };

    case "getApiUsageDashboard":
      return { ok: true, dashboard: await getApiUsageDashboard() };

    case "saveSettings":
      if (msg.apiKey !== undefined)
        await chrome.storage.local.set({ [STORAGE_KEYS.API_KEY]: msg.apiKey });
      if (msg.llmEnabled !== undefined)
        await chrome.storage.local.set({ [STORAGE_KEYS.LLM_ENABLED]: msg.llmEnabled });
      return { ok: true };

    case "saveBaseResumePdf":
      if (!msg.pdf || !msg.pdf.dataBase64) return { ok: false, error: "Missing PDF data" };
      return { ok: true, pdf: await saveBaseResumePdf(msg.pdf) };

    case "getBaseResumePdf":
      return { ok: true, pdf: await getBaseResumePdf() };

    case "clearBaseResumePdf":
      await chrome.storage.local.remove(STORAGE_KEYS.BASE_RESUME_PDF);
      return { ok: true };

    case "getJobDocuments":
      if (!msg.jobKey) return { ok: false, error: "Missing jobKey" };
      return { ok: true, bucket: await getJobDocumentBucket(msg.jobKey) };

    case "getActiveResumeContext": {
      const apiKey = await getApiKey();
      const llmEnabled = await isLlmEnabled();
      const activeResume = await resolveActiveResumeContext(msg.jobKey || "", {
        profile: await getProfile(),
        storedResume: await getResume(),
        apiKey: llmEnabled && apiKey ? apiKey : "",
        allowParse: llmEnabled && !!apiKey,
      });
      return {
        ok: true,
        activeResume: {
          sourceType: activeResume.sourceType,
          sourceName: activeResume.sourceName,
          hasUploadFile: activeResume.hasUploadFile,
          hasCanonicalHtml: !!(activeResume.htmlSource && activeResume.htmlSource.dataBase64),
          personal: activeResume.personal,
          parseMeta: activeResume.parseMeta,
        },
      };
    }

    case "listAllJobs":
      return { ok: true, jobs: await listAllArchivedJobs() };

    case "saveJobDocument":
      if (!msg.jobKey) return { ok: false, error: "Missing jobKey" };
      if (!msg.docType || (msg.docType !== "editedResume" && msg.docType !== "coverLetter")) {
        return { ok: false, error: "Invalid docType" };
      }
      if (!msg.doc || !msg.doc.dataBase64) return { ok: false, error: "Missing document data" };
      var safeDoc = cloneJson(msg.doc) || {};
      if (msg.docType === "editedResume" && String(safeDoc.mime || "").toLowerCase() === "application/pdf") {
        safeDoc = mergeObjects(safeDoc, await convertResumePdfToCanonicalAssets(safeDoc));
        safeDoc.mime = "text/html";
        safeDoc.name = safeDoc.sourcePdfName || canonicalResumePdfName(msg.doc.name || "resume");
        safeDoc.dataBase64 = safeDoc.canonicalHtmlBase64;
        safeDoc.size = base64ByteLength(safeDoc.dataBase64);
        safeDoc.sourceFormat = "canonicalHtmlResume";
      }
      await ensureArchiveReady();
      await ArchiveDB.saveJobDocument(msg.jobKey, msg.jobMeta, msg.docType, safeDoc);
      return { ok: true, doc: safeDoc };

    case "deleteJobDocument":
      if (!msg.jobKey) return { ok: false, error: "Missing jobKey" };
      if (!msg.docType || (msg.docType !== "editedResume" && msg.docType !== "coverLetter")) {
        return { ok: false, error: "Invalid docType" };
      }
      if (!msg.id) return { ok: false, error: "Missing id" };
      await ensureArchiveReady();
      await ArchiveDB.deleteDocument(msg.id);
      return { ok: true };

    case "listDocumentArchive":
      return { ok: true, items: await listDocumentArchive(msg.filters || null) };

    case "getArchivedDocument":
      if (!msg.id) return { ok: false, error: "Missing id" };
      await ensureArchiveReady();
      return { ok: true, doc: await ArchiveDB.getDocument(msg.id) };

    case "deleteArchivedDocument":
      if (!msg.id) return { ok: false, error: "Missing id" };
      await ensureArchiveReady();
      await ArchiveDB.deleteDocument(msg.id);
      return { ok: true };

    case "renderHtmlToPdf":
      return await renderHtmlToPdf(msg);

    case "getLastLog":
      const logResult = await chrome.storage.local.get(STORAGE_KEYS.LAST_FILL_LOG);
      return { ok: true, log: logResult[STORAGE_KEYS.LAST_FILL_LOG] || [] };

    case "openOptionsPage":
      chrome.runtime.openOptionsPage();
      return { ok: true };

    case "startAutofill":
      return await handleAutofill(msg, sender);

    case "confirmFill":
      return await handleConfirmFill(msg, sender);

    case "generateAiDocuments":
      return await handleGenerateAiDocuments(msg);

    case "analyzeResumeGaps":
      return await handleAnalyzeResumeGaps(msg);

    case "executeResumeOptimization":
      return await handleExecuteResumeOptimization(msg);

    case "generateCoverLetter":
      return await handleGenerateCoverLetter(msg);

    case "shortenCoverLetter":
      return await handleShortenCoverLetter(msg);

    case "opportunityDetected":
      return handleOpportunityDetected(msg, sender);

    case "requestOptimize":
      return handleRequestOptimize(sender);

    case "getStyleProfile":
      return { ok: true, styleProfile: await getStyleProfile() };

    case "saveStyleProfile":
      await saveStyleProfile(msg.styleProfile || "");
      return { ok: true };

    default:
      return { ok: false, error: "unknown action: " + msg.action };
  }
}

/**
 * Main autofill flow:
 * 1. Tell content script to scan fields
 * 2. Run rule-based matching
 * 3. Optionally run LLM for unmatched fields
 * 4. Send preview or fill command to content script
 */
async function handleAutofill(msg, sender) {
  const profile = await getProfile();
  if (!profile) {
    return { ok: false, error: "No profile configured. Open the Options page to set up your profile." };
  }

  const mode = msg.mode || "preview"; // "preview" or "fill"

  // 1. Get the target tab (from message, sender, or fallback to active tab)
  var tabId = msg.tabId;
  if (!tabId && sender && sender.tab) tabId = sender.tab.id;
  if (!tabId) {
    const [tab] = await chrome.tabs.query({ active: true, currentWindow: true });
    tabId = tab && tab.id;
  }
  if (!tabId) {
    return { ok: false, error: "No active tab found." };
  }

  // 2. Ask content script to scan fields
  let scanResult;
  try {
    scanResult = await chrome.tabs.sendMessage(tabId, { action: "scanFields" });
  } catch (err) {
    return { ok: false, error: "Could not reach content script. Try refreshing the page." };
  }

  if (!scanResult || !scanResult.ok) {
    return { ok: false, error: scanResult ? scanResult.error : "Scan returned no data." };
  }

  const fields = scanResult.fields || [];
  if (fields.length === 0) {
    return { ok: false, error: "No form fields found on this page." };
  }

  const jobKey = scanResult.jobKey || "";
  const jobMeta = scanResult.jobMeta || null;
  const formLayout = scanResult.formLayout || null;
  const repeatSectionHints = scanResult.repeatSectionHints || [];
  const llmPageHint = {
    formLayout,
    repeatSectionHints,
    navButton: scanResult.navButton || null,
  };
  const llmEnabled = await isLlmEnabled();
  const apiKey = await getApiKey();
  const activeResume = await resolveActiveResumeContext(jobKey, {
    profile: profile,
    storedResume: await getResume(),
    apiKey: llmEnabled && apiKey ? apiKey : "",
    allowParse: llmEnabled && !!apiKey,
  });
  const resume = activeResume.structuredResume;

  // 3. Rule-based matching (shared module loaded via importScripts)
  let mappings = MatchRules.ruleBasedMatch(fields, profile);
  mappings = attachFieldMetadataToMappings(fields, mappings);

  // 4. Optional LLM fallback for unmatched fields
  if (llmEnabled && apiKey) {
    const unmatched = fields.filter((f) => {
      const m = mappings.find((mm) => mm.selector === f.selector);
      return !m || m.confidence < 0.5;
    });

    if (unmatched.length > 0) {
      try {
        const llmMappings = await llmMapFields(unmatched, profile, resume, apiKey, llmPageHint, {
          jobKey: jobKey,
        });
        // Merge LLM results: replace low-confidence rule-based matches
        for (const lm of llmMappings) {
          const idx = mappings.findIndex((m) => m.selector === lm.selector);
          if (idx >= 0 && (lm.confidence || 0) > mappings[idx].confidence) {
            mappings[idx] = { ...lm, source: "llm" };
          } else if (idx < 0) {
            mappings.push({ ...lm, source: "llm" });
          }
        }
      } catch (err) {
        console.warn("[JobAutofill BG] LLM fallback failed:", err);
        // Continue with rule-based results only
      }
    }
  }

  // 5. Attach resume + cover letter file data to file-upload mappings
  const RESUME_FILE_RE = /resume|cv|curriculum/i;
  const COVER_LETTER_FILE_RE = /cover\s*letter|letter\s*of|motivation|supporting\s*document/i;

  const resumePdf = activeResume.uploadFile || await resolveResumePdfForJob(jobKey);
  const coverDoc = await newestCoverLetterDocForJob(jobKey);
  const coverFileData = coverDoc ? coverLetterDocToFileData(coverDoc) : null;

  for (let i = 0; i < mappings.length; i++) {
    const m = mappings[i];
    const field = fields.find((f) => f.selector === m.selector);
    if (!field) continue;
    const isFileField = field.type === "file";
    const isFileUploadValue = m.value === "__FILE_UPLOAD__";
    if (!isFileField && !isFileUploadValue) continue;

    const context = [field.label, field.name, field.id, field.aria_label, field.nearby_text].join(" ");

    if (coverFileData && COVER_LETTER_FILE_RE.test(context)) {
      mappings[i] = {
        ...m,
        value: "__FILE_UPLOAD__",
        confidence: 1.0,
        __fileData: {
          dataBase64: coverFileData.dataBase64,
          name: coverFileData.name || "cover-letter.txt",
          mime: coverFileData.mime || "text/plain",
        },
      };
      continue;
    }

    if (COVER_LETTER_FILE_RE.test(context)) continue;

    if (resumePdf && resumePdf.dataBase64 && (RESUME_FILE_RE.test(context) || isFileUploadValue)) {
      mappings[i] = {
        ...m,
        value: "__FILE_UPLOAD__",
        confidence: 1.0,
        __fileData: {
          dataBase64: resumePdf.dataBase64,
          name: resumePdf.name || "resume.pdf",
          mime: resumePdf.mime || "application/pdf",
        },
      };
    }
  }

  // 6. Send to content script
  if (mode === "preview") {
    try {
      await chrome.tabs.sendMessage(tabId, { action: "previewFill", mappings });
    } catch (err) {
      return { ok: false, error: "Preview failed: " + String(err) };
    }
    return {
      ok: true,
      mode: "preview",
      mappings: mappings,
      navButton: scanResult.navButton,
      formLayout,
      repeatSectionHints,
      adapterName: scanResult.adapterName,
      fieldCount: fields.length,
      jobKey,
      jobMeta,
      activeResume: {
        sourceType: activeResume.sourceType,
        sourceName: activeResume.sourceName,
        hasCanonicalHtml: !!(activeResume.htmlSource && activeResume.htmlSource.dataBase64),
        parseMeta: activeResume.parseMeta,
      },
    };
  }

  // Direct fill (skip preview)
  const filled = await executeFillOnTab(tabId, mappings);
  return {
    ...filled,
    jobKey,
    jobMeta,
    navButton: scanResult.navButton,
    formLayout,
    repeatSectionHints,
    fieldCount: fields.length,
    activeResume: {
      sourceType: activeResume.sourceType,
      sourceName: activeResume.sourceName,
      hasCanonicalHtml: !!(activeResume.htmlSource && activeResume.htmlSource.dataBase64),
      parseMeta: activeResume.parseMeta,
    },
  };
}

async function handleConfirmFill(msg, sender) {
  var targetTabId = msg.tabId;
  if (!targetTabId && sender && sender.tab) targetTabId = sender.tab.id;
  if (!targetTabId) {
    const [tab] = await chrome.tabs.query({ active: true, currentWindow: true });
    targetTabId = tab && tab.id;
  }
  if (!targetTabId) {
    return { ok: false, error: "No active tab found." };
  }
  return await executeFillOnTab(targetTabId, msg.mappings);
}

async function executeFillOnTab(tabId, mappings) {
  let result;
  try {
    result = await chrome.tabs.sendMessage(tabId, { action: "executeFill", mappings });
  } catch (err) {
    return { ok: false, error: "Fill failed: " + String(err) };
  }

  if (result && result.ok) {
    await saveLog(result.log || []);
  }

  return {
    ok: result ? result.ok : false,
    mode: "fill",
    filled: result ? result.filled : [],
    skipped: result ? result.skipped : [],
    error: result ? result.error : "No response from content script",
  };
}

// ---- Opportunity detection & badge -----------------------------------------

function handleOpportunityDetected(msg, sender) {
  const tabId = sender && sender.tab ? sender.tab.id : null;
  if (!tabId) return { ok: true };

  try {
    chrome.action.setBadgeText({ text: "!", tabId });
    chrome.action.setBadgeBackgroundColor({ color: "#6366f1", tabId });
  } catch (e) {
    // Badge API may not be available in all contexts
  }

  return { ok: true };
}

function handleRequestOptimize(sender) {
  // Widget requested optimize — highlight badge so user opens popup
  const tabId = sender && sender.tab ? sender.tab.id : null;
  if (tabId) {
    try {
      chrome.action.setBadgeText({ text: "✨", tabId });
      chrome.action.setBadgeBackgroundColor({ color: "#8b5cf6", tabId });
    } catch (e) { /* ignore */ }
  }
  return { ok: true };
}

// ---- Two-phase resume optimization ----------------------------------------

function flattenResumeText(resume) {
  if (!resume) return "";
  var parts = [];
  if (resume.personal) {
    parts.push(JSON.stringify(resume.personal));
  }
  var sections = ["experience", "projects", "education", "skills", "certifications"];
  for (var i = 0; i < sections.length; i++) {
    var sec = resume[sections[i]];
    if (Array.isArray(sec)) {
      parts.push(JSON.stringify(sec));
    } else if (sec) {
      parts.push(JSON.stringify(sec));
    }
  }
  return parts.join(" ").toLowerCase();
}

async function handleAnalyzeResumeGaps(msg) {
  const apiKey = await getApiKey();
  if (!apiKey) return { ok: false, error: "No OpenAI API key configured. Set it in Options." };
  const llmOn = await isLlmEnabled();
  if (!llmOn) return { ok: false, error: "LLM is disabled. Enable it in Options." };
  const profile = await getProfile();
  const activeResume = await resolveActiveResumeContext(msg.jobKey, {
    profile: profile,
    storedResume: await getResume(),
    apiKey: apiKey,
    allowParse: true,
  });
  const resume = activeResume.structuredResume;
  if (!resume) return { ok: false, error: "No resume data available. Add a resume in Options or Documents." };

  const jdText = msg.jdText;
  if (!jdText || jdText.trim().length < 30) {
    return { ok: false, error: "Could not extract job description text from this page." };
  }

  let jdAnalysis;
  try {
    jdAnalysis = await analyzeJd(jdText, apiKey, msg.jobKey);
  } catch (err) {
    console.error("[JobAutofill BG] JD analysis failed:", err);
    return { ok: false, error: "JD analysis failed: " + (err.message || String(err)) };
  }

  // Filter out keywords that duplicate the role or company name
  var filteredKeywords = (jdAnalysis.keywords || []).filter(function (kw) {
    var lower = kw.toLowerCase();
    var role = (jdAnalysis.role || "").toLowerCase();
    var company = (jdAnalysis.company || "").toLowerCase();
    return lower !== role && lower !== company
        && role.indexOf(lower) === -1 && company.indexOf(lower) === -1;
  });

  // LLM-powered gap check — sends resume + all extracted requirements to GPT
  let gapCheck;
  try {
    gapCheck = await llmCheckQualifications(
      resume,
      jdAnalysis.required_qualifications || [],
      jdAnalysis.hard_skills || [],
      filteredKeywords,
      apiKey,
      msg.jobKey
    );
  } catch (err) {
    console.error("[JobAutofill BG] LLM gap check failed:", err);
    return { ok: false, error: "Gap analysis failed: " + (err.message || String(err)) };
  }

  var qualResults  = gapCheck.qualifications || [];
  var skillResults = gapCheck.skills || [];
  var kwResults    = gapCheck.keywords || [];

  var missingSkills = [];
  var matchedSkills = [];
  for (var i = 0; i < skillResults.length; i++) {
    var sr = skillResults[i];
    var skillName = (jdAnalysis.hard_skills || [])[i] || sr.requirement;
    if (sr.status === "not_met") {
      missingSkills.push(skillName);
    } else {
      matchedSkills.push(skillName);
    }
  }

  var missingQualifications = [];
  var matchedQualifications = [];
  for (var j = 0; j < qualResults.length; j++) {
    var qr = qualResults[j];
    var qualName = (jdAnalysis.required_qualifications || [])[j] || qr.requirement;
    if (qr.status === "not_met") {
      missingQualifications.push(qualName);
    } else {
      matchedQualifications.push(qualName);
    }
  }

  var missingKeywords = [];
  var matchedKeywords = [];
  for (var k = 0; k < kwResults.length; k++) {
    var kr = kwResults[k];
    var kwName = (jdAnalysis.keywords || [])[k] || kr.requirement;
    if (kr.status === "not_met") {
      missingKeywords.push(kwName);
    } else {
      matchedKeywords.push(kwName);
    }
  }

  return {
    ok: true,
    jdAnalysis: jdAnalysis,
    missingSkills: missingSkills,
    matchedSkills: matchedSkills,
    missingQualifications: missingQualifications,
    matchedQualifications: matchedQualifications,
    missingKeywords: missingKeywords,
    matchedKeywords: matchedKeywords,
    gapDetails: qualResults.concat(skillResults).concat(kwResults),
    activeResume: {
      sourceType: activeResume.sourceType,
      sourceName: activeResume.sourceName,
      hasCanonicalHtml: !!(activeResume.htmlSource && activeResume.htmlSource.dataBase64),
      parseMeta: activeResume.parseMeta,
    },
  };
}

async function handleExecuteResumeOptimization(msg) {
  const apiKey = await getApiKey();
  if (!apiKey) return { ok: false, error: "No OpenAI API key configured." };
  const profile = await getProfile();
  const activeResume = await resolveActiveResumeContext(msg.jobKey, {
    profile: profile,
    storedResume: await getResume(),
    apiKey: apiKey,
    allowParse: true,
  });
  const resume = activeResume.structuredResume;
  if (!resume) return { ok: false, error: "No resume data available." };

  const jdAnalysis = msg.jdAnalysis;
  if (!jdAnalysis) return { ok: false, error: "Missing JD analysis from Phase 1." };

  const styleProfile = await getStyleProfile();

  let tailorResult, coverLetterText;
  try {
    [tailorResult, coverLetterText] = await Promise.all([
      tailorResume(resume, jdAnalysis, apiKey, msg.jobKey),
      generateCoverLetterText(resume, jdAnalysis, styleProfile, apiKey, msg.jobKey),
    ]);
  } catch (err) {
    console.error("[JobAutofill BG] Resume optimization failed:", err);
    return { ok: false, error: "Optimization failed: " + (err.message || String(err)) };
  }

  let candidateEdits = cloneJson(tailorResult.candidate_edits || { experience: [], projects: [] });
  let resumeDoc = null;
  try {
    const optimizedDocResult = await buildOptimizedResumeDocFromCanonicalHtml(
      activeResume,
      resume,
      candidateEdits,
      jdAnalysis,
      apiKey,
      msg.jobKey,
      "tailored-resume.pdf"
    );
    if (optimizedDocResult && optimizedDocResult.doc) {
      resumeDoc = optimizedDocResult.doc;
      candidateEdits = optimizedDocResult.candidateEdits || candidateEdits;
    }
  } catch (resumeDocErr) {
    console.warn("[JobAutofill BG] Canonical resume render failed:", resumeDocErr);
  }

  const tailoredResume = applyTailorGuardrails(resume, candidateEdits);
  const requirementsGaps = tailorResult.requirements_gaps || [];
  const diff = computeResumeDiff(resume, tailoredResume);

  return {
    ok: true,
    tailoredResume: tailoredResume,
    coverLetterText: coverLetterText,
    jdAnalysis: jdAnalysis,
    requirementsGaps: requirementsGaps,
    diff: diff,
    resumeDoc: resumeDoc,
    activeResume: {
      sourceType: activeResume.sourceType,
      sourceName: activeResume.sourceName,
      hasCanonicalHtml: !!(activeResume.htmlSource && activeResume.htmlSource.dataBase64),
      parseMeta: activeResume.parseMeta,
      personal: activeResume.personal,
    },
  };
}

// ---- Standalone cover letter generation ------------------------------------

async function handleGenerateCoverLetter(msg) {
  const apiKey = await getApiKey();
  if (!apiKey) return { ok: false, error: "No OpenAI API key configured. Set it in Options." };
  const llmOn = await isLlmEnabled();
  if (!llmOn) return { ok: false, error: "LLM is disabled. Enable it in Options." };
  const profile = await getProfile();
  const activeResume = await resolveActiveResumeContext(msg.jobKey, {
    profile: profile,
    storedResume: await getResume(),
    apiKey: apiKey,
    allowParse: true,
  });
  const resume = activeResume.structuredResume;
  if (!resume) return { ok: false, error: "No resume data available. Upload a resume in Options or Documents." };

  const jdText = msg.jdText;
  if (!jdText || jdText.trim().length < 30) {
    return { ok: false, error: "Could not extract a job description from this page." };
  }

  let jdAnalysis;
  try {
    jdAnalysis = await analyzeJd(jdText, apiKey, msg.jobKey);
  } catch (err) {
    return { ok: false, error: "JD analysis failed: " + (err.message || String(err)) };
  }

  const styleProfile = await getStyleProfile();
  let coverLetterText;
  try {
    coverLetterText = await generateCoverLetterText(resume, jdAnalysis, styleProfile, apiKey, msg.jobKey);
  } catch (err) {
    return { ok: false, error: "Cover letter generation failed: " + (err.message || String(err)) };
  }

  return {
    ok: true,
    coverLetterText,
    jdAnalysis,
    activeResume: {
      sourceType: activeResume.sourceType,
      sourceName: activeResume.sourceName,
      hasCanonicalHtml: !!(activeResume.htmlSource && activeResume.htmlSource.dataBase64),
      parseMeta: activeResume.parseMeta,
      personal: activeResume.personal,
    },
  };
}

async function handleShortenCoverLetter(msg) {
  const apiKey = await getApiKey();
  if (!apiKey) return { ok: false, error: "No OpenAI API key configured. Set it in Options." };
  const llmOn = await isLlmEnabled();
  if (!llmOn) return { ok: false, error: "LLM is disabled. Enable it in Options." };
  const styleProfile = await getStyleProfile();
  if (!msg.coverLetterText || !String(msg.coverLetterText).trim()) {
    return { ok: false, error: "Missing cover letter text." };
  }
  try {
    return {
      ok: true,
      coverLetterText: await shortenCoverLetterText(
        msg.coverLetterText,
        msg.jdAnalysis || null,
        styleProfile,
        apiKey,
        msg.jobKey || ""
      ),
    };
  } catch (err) {
    return { ok: false, error: "Cover letter shortening failed: " + (err.message || String(err)) };
  }
}

// Log extension startup
console.log("[JobAutofill] Background service worker started.");

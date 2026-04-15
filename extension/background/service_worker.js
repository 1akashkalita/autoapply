/**
 * Background service worker.
 * Handles message routing between popup and content scripts,
 * profile storage management, and optional OpenAI API integration.
 */

importScripts("../shared/match_rules.js", "../shared/archive_db.js");

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

// ---- API usage (OpenAI responses) ------------------------------------------

function cloneJson(value) {
  return value ? JSON.parse(JSON.stringify(value)) : value;
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

async function resolveResumePdfForJob(jobKey) {
  if (jobKey) {
    const bucket = await getJobDocumentBucket(jobKey);
    const edited = bucket && Array.isArray(bucket.editedResumes) ? bucket.editedResumes : [];
    for (const d of edited) {
      if (!d || !d.dataBase64) continue;
      const mime = String(d.mime || "").toLowerCase();
      const name = String(d.name || "").toLowerCase();
      if (mime === "application/pdf" || name.endsWith(".pdf")) {
        return {
          dataBase64: d.dataBase64,
          name: d.name || "resume.pdf",
          mime: d.mime || "application/pdf",
        };
      }
    }
  }
  return await getBaseResumePdf();
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
  return result[STORAGE_KEYS.PROFILE] || null;
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
  await chrome.storage.local.set({ [STORAGE_KEYS.BASE_RESUME_PDF]: pdf });
}

function sortNewestFirst(a, b) {
  return String(b.createdAt || "").localeCompare(String(a.createdAt || ""));
}

async function getJobDocumentBucket(jobKey) {
  await ensureArchiveReady();
  const job = await ArchiveDB.getJob(jobKey);
  const docs = await ArchiveDB.listDocumentsByJob(jobKey);
  const bucket = {
    jobKey: jobKey,
    jobMeta: job && job.jobMeta ? job.jobMeta : null,
    editedResumes: [],
    coverLetters: [],
    updatedAt: (job && job.updatedAt) || null,
  };

  for (const doc of docs) {
    if (doc.docType === "editedResume") bucket.editedResumes.push(doc);
    else if (doc.docType === "coverLetter") bucket.coverLetters.push(doc);
  }
  bucket.editedResumes.sort(sortNewestFirst);
  bucket.coverLetters.sort(sortNewestFirst);
  return (bucket.editedResumes.length || bucket.coverLetters.length || bucket.jobMeta) ? bucket : null;
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
        size: doc.size || 0,
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
  "- For <select> fields the value MUST be one of the provided option values.\n" +
  '- For file-upload fields set value to "__FILE_UPLOAD__" with confidence 1.0.\n' +
  '- Set confidence < 0.8 and value "__PAUSE__" for anything ambiguous or not in the profile.\n' +
  "- Return ONLY a JSON array, no markdown fences, no commentary.";

function stripMarkdownFences(text) {
  const match = text.match(/```(?:json)?\s*([\s\S]*?)```/);
  if (match) return match[1].trim();
  return text.trim();
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
    return mappings;
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

const RESUME_TAILOR_PROMPT =
  "ROLE: You are an expert resume writer and ATS optimization specialist.\n\n" +
  "TASK: Produce a tailored version of the resume JSON that maximizes ATS match rate for the given job description analysis.\n\n" +
  "INPUT FORMAT:\n" +
  "The user message contains:\n" +
  "1. MASTER RESUME: the applicant's full resume in JSON format\n" +
  "2. JOB DESCRIPTION ANALYSIS: structured JD data with keywords, requirements, skills\n\n" +
  "OUTPUT FORMAT:\n" +
  'Return ONLY valid JSON with two top-level keys: "tailored_resume" and "requirements_gaps".\n' +
  '"tailored_resume" must have the EXACT same schema as the master resume.\n' +
  '"requirements_gaps" is an array where each item is:\n' +
  '{ "requirement": string, "status": "met"|"partially_met"|"not_met"|"filled_by_generated_project", "notes": string }\n\n' +
  "RULES:\n" +
  "- Never invent work experience, employers, job titles, or dates.\n" +
  "- Rewrite bullet point text to mirror the JD's keywords and language where honest.\n" +
  "- Reorder bullets within each job/project so the most JD-relevant ones come first.\n" +
  "- Max 3-4 bullets per job entry to keep the resume to one page.\n" +
  "- Select the 3 most relevant projects from the master resume for this role.\n" +
  "- Add JD hard_skills to the skills section ONLY if they already exist somewhere in the master resume.\n" +
  "- Keep the exact same JSON schema as the master resume.\n" +
  "- For each required_qualification, check if the resume addresses it. If not, find the closest honest rewrite of an existing bullet that covers it.\n" +
  "- SYNTHETIC PROJECT RULE: If a required skill/qualification cannot be covered by any existing experience or project, identify the weakest/least-relevant existing project, REPLACE it with a new generated project that:\n" +
  "  (a) Uses only technologies the applicant has demonstrably used elsewhere in the resume\n" +
  "  (b) Directly targets the uncovered requirement with a realistic, specific scope\n" +
  "  (c) Includes 3 bullet points with plausible outcomes/metrics consistent with a student/early-career engineer\n" +
  '  (d) Is marked with "generated": true in the project object\n' +
  '  Set the corresponding gap status to "filled_by_generated_project".\n\n' +
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
    "Produce the tailored resume JSON now.";

  return await callOpenAi({
    systemPrompt: RESUME_TAILOR_PROMPT,
    userContent,
    apiKey,
    expectJson: true,
    requiredKeys: ["tailored_resume", "requirements_gaps"],
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
      const isGenerated = tailItem.generated === true;

      const header = sectionKey === "experience"
        ? (tailItem.title || "") + " @ " + (tailItem.company || "")
        : (tailItem.name || tailItem.id || "Unknown");

      const entry = { section: sectionKey, header, generated: isGenerated, bullets: [] };

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

      if (isGenerated || entry.bullets.some((b) => b.type !== "unchanged")) {
        diff.push(entry);
      }
    }
  }
  return diff;
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

  const resume = await getResume();
  if (!resume) {
    return { ok: false, error: "No resume JSON configured. Upload it in Options." };
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

  const tailoredResume = tailorResult.tailored_resume || tailorResult;
  const requirementsGaps = tailorResult.requirements_gaps || [];
  const diff = computeResumeDiff(resume, tailoredResume);

  return {
    ok: true,
    tailoredResume,
    coverLetterText,
    jdAnalysis,
    requirementsGaps,
    diff,
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

async function renderHtmlToPdf(msg) {
  if (!msg.html) return { ok: false, error: "Missing HTML payload" };

  var renderId = genId("render");
  var sessionKey = "jaf_pdf_render_" + renderId;
  var target = null;
  var tab = null;

  try {
    await chrome.storage.session.set({
      [sessionKey]: {
        html: String(msg.html),
        createdAt: new Date().toISOString(),
      },
    });

    tab = await chrome.tabs.create({
      url: chrome.runtime.getURL("pdf/render.html?renderId=" + encodeURIComponent(renderId)),
      active: false,
    });
    target = { tabId: tab.id };

    await waitForTabComplete(tab.id);
    await delay(250);

    await chrome.debugger.attach(target, "1.3");
    try {
      await debuggerSend(target, "Page.enable");
      await debuggerSend(target, "Emulation.setEmulatedMedia", { media: "print" });
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
    try { await chrome.storage.session.remove(sessionKey); } catch (removeErr) {}
  }
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
      await chrome.storage.local.set({ [STORAGE_KEYS.PROFILE]: msg.profile });
      return { ok: true };

    case "saveResume":
      await chrome.storage.local.set({ [STORAGE_KEYS.RESUME]: msg.resume });
      return { ok: true };

    case "getSettings":
      const basePdf = await getBaseResumePdf();
      return {
        ok: true,
        profile: await getProfile(),
        resume: await getResume(),
        baseResumePdfMeta: basePdf
          ? {
              id: basePdf.id,
              name: basePdf.name,
              mime: basePdf.mime,
              size: basePdf.size,
              createdAt: basePdf.createdAt,
            }
          : null,
        apiKey: await getApiKey(),
        llmEnabled: await isLlmEnabled(),
        styleProfile: await getStyleProfile(),
      };

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
      await saveBaseResumePdf(msg.pdf);
      return { ok: true };

    case "getBaseResumePdf":
      return { ok: true, pdf: await getBaseResumePdf() };

    case "clearBaseResumePdf":
      await chrome.storage.local.remove(STORAGE_KEYS.BASE_RESUME_PDF);
      return { ok: true };

    case "getJobDocuments":
      if (!msg.jobKey) return { ok: false, error: "Missing jobKey" };
      return { ok: true, bucket: await getJobDocumentBucket(msg.jobKey) };

    case "listAllJobs":
      return { ok: true, jobs: await listAllArchivedJobs() };

    case "saveJobDocument":
      if (!msg.jobKey) return { ok: false, error: "Missing jobKey" };
      if (!msg.docType || (msg.docType !== "editedResume" && msg.docType !== "coverLetter")) {
        return { ok: false, error: "Invalid docType" };
      }
      if (!msg.doc || !msg.doc.dataBase64) return { ok: false, error: "Missing document data" };
      await ensureArchiveReady();
      await ArchiveDB.saveJobDocument(msg.jobKey, msg.jobMeta, msg.docType, msg.doc);
      return { ok: true };

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
  const resume = await getResume();

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

  // 3. Rule-based matching (shared module loaded via importScripts)
  let mappings = MatchRules.ruleBasedMatch(fields, profile);

  // 4. Optional LLM fallback for unmatched fields
  const llmEnabled = await isLlmEnabled();
  const apiKey = await getApiKey();
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

  const resumePdf = await resolveResumePdfForJob(jobKey);
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
  const resume = await getResume();
  if (!resume) return { ok: false, error: "No resume JSON configured. Upload it in Options." };

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
  };
}

async function handleExecuteResumeOptimization(msg) {
  const apiKey = await getApiKey();
  if (!apiKey) return { ok: false, error: "No OpenAI API key configured." };
  const resume = await getResume();
  if (!resume) return { ok: false, error: "No resume JSON configured." };

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

  const tailoredResume = tailorResult.tailored_resume || tailorResult;
  const requirementsGaps = tailorResult.requirements_gaps || [];
  const diff = computeResumeDiff(resume, tailoredResume);

  return {
    ok: true,
    tailoredResume: tailoredResume,
    coverLetterText: coverLetterText,
    jdAnalysis: jdAnalysis,
    requirementsGaps: requirementsGaps,
    diff: diff,
  };
}

// ---- Standalone cover letter generation ------------------------------------

async function handleGenerateCoverLetter(msg) {
  const apiKey = await getApiKey();
  if (!apiKey) return { ok: false, error: "No OpenAI API key configured. Set it in Options." };
  const llmOn = await isLlmEnabled();
  if (!llmOn) return { ok: false, error: "LLM is disabled. Enable it in Options." };
  const resume = await getResume();
  if (!resume) return { ok: false, error: "No resume JSON configured. Upload it in Options." };

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

  return { ok: true, coverLetterText, jdAnalysis };
}

// Log extension startup
console.log("[JobAutofill] Background service worker started.");

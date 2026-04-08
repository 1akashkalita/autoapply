/**
 * Background service worker.
 * Handles message routing between popup and content scripts,
 * profile storage management, and optional OpenAI API integration.
 */

importScripts("../shared/match_rules.js");

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
};

// Storage sizing/retention (chrome.storage.local is quota-limited; keep it bounded)
const MAX_DOCS_PER_JOB_PER_TYPE = 5;
const MAX_TOTAL_BYTES_SOFT = 8 * 1024 * 1024; // soft cap; we’ll trim before exceeding

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

async function getAllJobDocuments() {
  const result = await chrome.storage.local.get(STORAGE_KEYS.JOB_DOCUMENTS);
  return result[STORAGE_KEYS.JOB_DOCUMENTS] || {};
}

async function saveAllJobDocuments(allDocs) {
  await chrome.storage.local.set({ [STORAGE_KEYS.JOB_DOCUMENTS]: allDocs });
}

function ensureJobBucket(allDocs, jobKey, jobMeta) {
  if (!allDocs[jobKey]) {
    allDocs[jobKey] = {
      jobKey,
      jobMeta: jobMeta || null,
      editedResumes: [],
      coverLetters: [],
      updatedAt: new Date().toISOString(),
    };
  } else {
    if (jobMeta) allDocs[jobKey].jobMeta = jobMeta;
    allDocs[jobKey].updatedAt = new Date().toISOString();
    allDocs[jobKey].editedResumes = Array.isArray(allDocs[jobKey].editedResumes)
      ? allDocs[jobKey].editedResumes
      : [];
    allDocs[jobKey].coverLetters = Array.isArray(allDocs[jobKey].coverLetters)
      ? allDocs[jobKey].coverLetters
      : [];
  }
  return allDocs[jobKey];
}

function sortNewestFirst(a, b) {
  return String(b.createdAt || "").localeCompare(String(a.createdAt || ""));
}

function trimDocsInPlace(bucket) {
  bucket.editedResumes.sort(sortNewestFirst);
  bucket.coverLetters.sort(sortNewestFirst);
  bucket.editedResumes = bucket.editedResumes.slice(0, MAX_DOCS_PER_JOB_PER_TYPE);
  bucket.coverLetters = bucket.coverLetters.slice(0, MAX_DOCS_PER_JOB_PER_TYPE);
}

async function getBytesInUseSafe(keys) {
  try {
    return await chrome.storage.local.getBytesInUse(keys);
  } catch (e) {
    // Some environments may not support getBytesInUse; fall back gracefully.
    return 0;
  }
}

async function enforceStorageSoftCap(allDocs) {
  // If we’re over the soft cap, trim oldest docs across jobs until under cap.
  let bytes = await getBytesInUseSafe([STORAGE_KEYS.JOB_DOCUMENTS, STORAGE_KEYS.BASE_RESUME_PDF]);
  if (!bytes || bytes <= MAX_TOTAL_BYTES_SOFT) return { ok: true, bytes };

  // Build a global list of removable items (oldest first)
  const removables = [];
  for (const [jobKey, bucket] of Object.entries(allDocs || {})) {
    const er = Array.isArray(bucket.editedResumes) ? bucket.editedResumes : [];
    const cl = Array.isArray(bucket.coverLetters) ? bucket.coverLetters : [];
    for (const d of er) removables.push({ jobKey, type: "editedResumes", createdAt: d.createdAt || "", id: d.id });
    for (const d of cl) removables.push({ jobKey, type: "coverLetters", createdAt: d.createdAt || "", id: d.id });
  }
  removables.sort((a, b) => String(a.createdAt).localeCompare(String(b.createdAt))); // oldest first

  let removed = 0;
  while (bytes > MAX_TOTAL_BYTES_SOFT && removables.length > 0) {
    const r = removables.shift();
    const bucket = allDocs[r.jobKey];
    if (!bucket || !Array.isArray(bucket[r.type])) continue;
    const before = bucket[r.type].length;
    bucket[r.type] = bucket[r.type].filter((d) => d && d.id !== r.id);
    if (bucket[r.type].length !== before) {
      removed += 1;
      await saveAllJobDocuments(allDocs);
      bytes = await getBytesInUseSafe([STORAGE_KEYS.JOB_DOCUMENTS, STORAGE_KEYS.BASE_RESUME_PDF]);
      if (!bytes) break;
    }
  }

  if (bytes && bytes > MAX_TOTAL_BYTES_SOFT) {
    return { ok: false, error: "Storage is full; please delete old documents in the popup/options." };
  }
  return { ok: true, bytes, removed };
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
async function llmMapFields(unmatchedFields, profile, resume, apiKey) {
  const fullProfile = { applicant_info: profile, resume: resume || {} };

  const body = {
    model: "gpt-4o-mini",
    messages: [
      { role: "system", content: FIELD_MAP_PROMPT },
      {
        role: "user",
        content:
          "FORM FIELDS:\n" +
          JSON.stringify(unmatchedFields, null, 2) +
          "\n\nAPPLICANT PROFILE:\n" +
          JSON.stringify(fullProfile, null, 2),
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
  '  "keywords": array — terms that appear multiple times or carry obvious weight,\n' +
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
async function callOpenAi({ systemPrompt, userContent, apiKey, expectJson, requiredKeys, temperature }) {
  const messages = [
    { role: "system", content: systemPrompt },
    { role: "user", content: userContent },
  ];

  async function doFetch(msgs, temp) {
    const body = {
      model: "gpt-4o-mini",
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

async function analyzeJd(jdText, apiKey) {
  return await callOpenAi({
    systemPrompt: JD_ANALYSIS_PROMPT,
    userContent: jdText,
    apiKey,
    expectJson: true,
    requiredKeys: JD_ANALYSIS_REQUIRED_KEYS,
    temperature: 0.1,
  });
}

async function tailorResume(masterResume, jdAnalysis, apiKey) {
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
  });
}

async function generateCoverLetterText(masterResume, jdAnalysis, styleProfile, apiKey) {
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
  const jdAnalysis = await analyzeJd(jdText, apiKey);

  // Step 2 & 3: Tailor resume and generate cover letter in parallel
  const [tailorResult, coverLetterText] = await Promise.all([
    tailorResume(resume, jdAnalysis, apiKey),
    generateCoverLetterText(resume, jdAnalysis, styleProfile, apiKey),
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
      const allDocs1 = await getAllJobDocuments();
      return { ok: true, bucket: allDocs1[msg.jobKey] || null };

    case "listAllJobs":
      const allDocs2 = await getAllJobDocuments();
      return {
        ok: true,
        jobs: Object.values(allDocs2).map((b) => ({
          jobKey: b.jobKey,
          jobMeta: b.jobMeta || null,
          updatedAt: b.updatedAt,
          editedResumeCount: (b.editedResumes || []).length,
          coverLetterCount: (b.coverLetters || []).length,
        })),
      };

    case "saveJobDocument":
      if (!msg.jobKey) return { ok: false, error: "Missing jobKey" };
      if (!msg.docType || (msg.docType !== "editedResume" && msg.docType !== "coverLetter")) {
        return { ok: false, error: "Invalid docType" };
      }
      if (!msg.doc || !msg.doc.dataBase64) return { ok: false, error: "Missing document data" };
      const allDocs3 = await getAllJobDocuments();
      const bucket = ensureJobBucket(allDocs3, msg.jobKey, msg.jobMeta);
      if (msg.docType === "editedResume") bucket.editedResumes.unshift(msg.doc);
      if (msg.docType === "coverLetter") bucket.coverLetters.unshift(msg.doc);
      trimDocsInPlace(bucket);
      await saveAllJobDocuments(allDocs3);
      const cap = await enforceStorageSoftCap(allDocs3);
      if (!cap.ok) return { ok: false, error: cap.error };
      return { ok: true, bytesInUse: cap.bytes || null };

    case "deleteJobDocument":
      if (!msg.jobKey) return { ok: false, error: "Missing jobKey" };
      if (!msg.docType || (msg.docType !== "editedResume" && msg.docType !== "coverLetter")) {
        return { ok: false, error: "Invalid docType" };
      }
      if (!msg.id) return { ok: false, error: "Missing id" };
      const allDocs4 = await getAllJobDocuments();
      const bucket2 = allDocs4[msg.jobKey];
      if (!bucket2) return { ok: true };
      const key = msg.docType === "editedResume" ? "editedResumes" : "coverLetters";
      bucket2[key] = (bucket2[key] || []).filter((d) => d && d.id !== msg.id);
      bucket2.updatedAt = new Date().toISOString();
      await saveAllJobDocuments(allDocs4);
      return { ok: true };

    case "getLastLog":
      const logResult = await chrome.storage.local.get(STORAGE_KEYS.LAST_FILL_LOG);
      return { ok: true, log: logResult[STORAGE_KEYS.LAST_FILL_LOG] || [] };

    case "startAutofill":
      return await handleAutofill(msg);

    case "confirmFill":
      return await handleConfirmFill(msg);

    case "generateAiDocuments":
      return await handleGenerateAiDocuments(msg);

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
async function handleAutofill(msg) {
  const profile = await getProfile();
  if (!profile) {
    return { ok: false, error: "No profile configured. Open the Options page to set up your profile." };
  }
  const resume = await getResume();

  const mode = msg.mode || "preview"; // "preview" or "fill"

  // 1. Get the active tab
  const [tab] = await chrome.tabs.query({ active: true, currentWindow: true });
  if (!tab || !tab.id) {
    return { ok: false, error: "No active tab found." };
  }

  // 2. Ask content script to scan fields
  let scanResult;
  try {
    scanResult = await chrome.tabs.sendMessage(tab.id, { action: "scanFields" });
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
        const llmMappings = await llmMapFields(unmatched, profile, resume, apiKey);
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

  // 5. Send to content script
  if (mode === "preview") {
    try {
      await chrome.tabs.sendMessage(tab.id, { action: "previewFill", mappings });
    } catch (err) {
      return { ok: false, error: "Preview failed: " + String(err) };
    }
    return {
      ok: true,
      mode: "preview",
      mappings: mappings,
      navButton: scanResult.navButton,
      adapterName: scanResult.adapterName,
      fieldCount: fields.length,
      jobKey,
      jobMeta,
    };
  }

  // Direct fill (skip preview)
  const filled = await executeFillOnTab(tab.id, mappings);
  return { ...filled, jobKey, jobMeta };
}

async function handleConfirmFill(msg) {
  const [tab] = await chrome.tabs.query({ active: true, currentWindow: true });
  if (!tab || !tab.id) {
    return { ok: false, error: "No active tab found." };
  }
  return await executeFillOnTab(tab.id, msg.mappings);
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

// Log extension startup
console.log("[JobAutofill] Background service worker started.");

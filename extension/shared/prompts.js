/**
 * LLM prompts for optional AI-powered field mapping.
 * Ported verbatim from resume_tool/autofill_agent.py lines 37-60.
 */

window.JobAutofill = window.JobAutofill || {};

window.JobAutofill.prompts = {
  FIELD_MAP_PROMPT:
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
    "- Return ONLY a JSON array, no markdown fences, no commentary.",

  VISION_RESOLVE_PROMPT:
    "The screenshot shows a form field that the text-based mapper could not resolve.\n" +
    "Given the applicant profile below, determine the correct value for this field.\n" +
    'Return JSON: { "value": "...", "confidence": 0.0-1.0 }\n' +
    "If you cannot determine the value, set confidence to 0.0.\n" +
    "Return ONLY JSON, no markdown.",
};

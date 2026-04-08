# Job Autofill

A toolkit for automating job applications: tailored resumes, cover letters, and form autofill.

## Repository Structure

```
jobautofill/
  resume_tool/           Python CLI -- JD analysis, resume tailoring, Playwright autofill
  extension/             Chrome Extension (Manifest V3) -- browser-native form autofill
```

---

## 1. Resume Tool (Python CLI)

Located in `resume_tool/`. An OpenAI-powered pipeline that:

1. **Analyzes job descriptions** (`jd_analyzer.py`) into structured JSON
2. **Tailors your resume** (`resume_tailor.py`) to match each JD
3. **Generates cover letters** (`cover_letter.py`) in your writing style
4. **Autofills application forms** (`autofill_agent.py`) via Playwright browser automation

### Setup

```bash
cd resume_tool
pip install -r requirements.txt
playwright install chromium
cp .env.example .env   # add your OPENAI_API_KEY
```

### Usage

```bash
# Full pipeline: JD analysis -> tailored resume -> cover letter
python run.py

# Autofill a job application in the browser
python autofill_agent.py "https://example.com/apply"
```

All output files are saved to `resume_tool/outputs/`:
- `jd_analysis.json` -- structured JD analysis
- `tailored_resume.json` -- tailored resume JSON
- `tailored_resume.pdf` -- rendered PDF (requires WeasyPrint)
- `cover_letter.txt` -- generated cover letter (if requested)

---

## 2. Chrome Extension

Located in `extension/`. A Manifest V3 Chrome extension that autofills job application forms
directly in your browser using your saved profile data.

### Features

- **Rule-based field matching** -- works without any API key for ~30 common field types
  (name, email, phone, address, education, work authorization, LinkedIn, etc.).
  Matching rules include autocomplete attribute detection, keyword pattern matching,
  and special handling for boolean fields (sponsorship checkboxes/radios).
- **Optional LLM fallback** -- uses OpenAI (`gpt-4o-mini`) for ambiguous fields when
  an API key is configured. The LLM receives both your applicant profile and stored
  resume JSON for richer context.
- **Preview mode** -- highlights fields with proposed values before filling; confirm before writing
- **Framework-safe** -- dispatches proper events for React, Angular, and Vue-based forms
- **Site adapter pattern** -- built-in support for Greenhouse, Lever, and Workday ATS;
  easy to add new sites
- **No auto-submit** -- the extension never clicks Submit; you stay in control
- **Logging** -- tracks all filled and skipped fields for review
- **Base resume PDF storage** -- upload and keep your base resume PDF in extension-local storage
- **Job-scoped document vault** -- store edited resume PDFs and cover letters grouped by detected job
- **Per-job download/delete controls** -- manage saved documents from the popup with job-based filenames

### Setup

1. Open Chrome and navigate to `chrome://extensions/`
2. Enable **Developer mode** (toggle in the top right)
3. Click **Load unpacked**
4. Select the `extension/` folder from this repository

### Configure Your Profile

1. Click the Job Autofill extension icon in Chrome toolbar
2. Click **Edit Profile & Settings** (or right-click the icon -> Options)
3. Fill in your profile manually, **or** paste your existing
   `resume_tool/data/applicant_data.json` into the Import field
4. Click **Save Profile**

### Usage

1. Navigate to a job application page
2. Click the extension icon
3. Click **Preview** to see which fields will be filled and with what values
4. Review the preview -- fields are highlighted blue (will fill) or yellow (skipped)
5. Click **Confirm & Fill** to execute
6. Review the results log in the popup

### AI Settings (Optional)

To enable LLM-powered matching for fields the rule-based system can't handle:

1. Go to extension Options
2. Paste your OpenAI API key
3. Check "Enable LLM fallback"
4. Save

For richer LLM results, also paste your `master_resume.json` or `tailored_resume.json`
into the **Resume Data** section. The LLM uses both your applicant profile and resume
when mapping ambiguous fields.

### Document Storage (Base Resume + Per-Job Files)

The extension now stores document artifacts locally in `chrome.storage.local`:

- **Base Resume PDF** (Options page):
  - Upload a base resume PDF from **Options -> Base Resume PDF**
  - View stored metadata (file name, size, timestamp)
  - Download or clear the stored base PDF
- **Per-job document storage** (Popup):
  - On a job page, the extension derives a stable `jobKey` from job metadata and URL
  - Save **edited resume PDFs** and **cover letters** under that job
  - Cover letters can be saved as PDF uploads or plain text
  - Downloaded files use a job-based naming pattern like:
    - `Company-Title-YYYYMMDD-edited-resume.pdf`
    - `Company-Title-YYYYMMDD-cover-letter.pdf`

Storage safeguards:
- Keeps recent documents per job (bounded list) to avoid unbounded growth
- Trims oldest stored docs when local storage approaches a soft size cap
- Handles missing/unknown job metadata with safe filename and key fallbacks

### Architecture

```
extension/
  manifest.json              Manifest V3 configuration
  shared/                    Reusable logic (loaded by both service worker and content scripts)
    constants.js             Thresholds, navigation patterns
    match_rules.js           Shared matching rules + helpers (single source of truth)
    field_extraction.js      DOM scanner (ported from autofill_agent.py)
    field_matching.js        Content-side entry point (delegates to match_rules.js)
    event_dispatch.js        Framework-safe event firing
    prompts.js               LLM prompts (loaded by service worker only, not injected into pages)
    utils.js                 Utilities, logging, nav detection
  content/                   Content scripts (injected into pages)
    content_main.js          Message handler, orchestrator
    dom_filler.js            Field filling + preview overlays
    site_adapters/           Site-specific overrides
      adapter_registry.js    Selects adapter by URL
      base_adapter.js        Adapter interface
      generic.js             Fallback adapter
      greenhouse.js          Greenhouse ATS
      lever.js               Lever ATS
      workday.js             Workday ATS
  background/
    service_worker.js        Storage, message routing, OpenAI API calls
  popup/                     Extension popup UI
    popup.html / .css / .js
  options/                   Full settings page
    options.html / .css / .js
```

**Data flow:** Popup -> Background (loads profile + resume, runs matching via
`match_rules.js`) -> Content Script (scans DOM, derives `jobKey`, previews, fills) ->
Background (stores logs + document artifacts) -> Popup (shows results + per-job documents).

### Adding Support for a New Site

1. Create `extension/content/site_adapters/mysite.js`
2. Extend `BaseAdapter` with URL patterns and any field extraction or fill overrides
3. Add a `<script>` entry in `manifest.json` content_scripts before `adapter_registry.js`
4. Register the adapter in `adapter_registry.js`

Example:

```javascript
window.JobAutofill.MySiteAdapter = new window.JobAutofill.BaseAdapter({
  name: "mysite",
  urlPatterns: [/mysite\.com\/apply/i],
});

// Override extraction to handle custom components
window.JobAutofill.MySiteAdapter.extractFields = function () {
  var fields = window.JobAutofill.extractFields();
  // ... site-specific enhancements ...
  return fields;
};
```

### Testing

**Manual testing:**
1. Load the extension as described above
2. Configure your profile in Options
3. Navigate to a test form. Some good test targets:
   - Any Greenhouse job board (`boards.greenhouse.io/*/jobs/*`)
   - Any Lever job page (`jobs.lever.co/*/apply`)
   - Simple HTML forms on any site
4. Click Preview, verify the mappings, then Confirm & Fill
5. Check that values appear correctly and the form recognizes them

**Testing framework compatibility:**
- Test on React-based sites (most modern job boards)
- Test on plain HTML forms
- Verify `change` / `input` events fire by checking that form validation runs

### Limitations

- **Form file inputs** (resume upload fields in job forms) still cannot be programmatically
  set by Chrome extensions due to browser security restrictions
- Document storage is local to the browser profile (not synced to a backend)
- **Vision-based resolution** (screenshot + GPT vision) from the Python agent is not
  ported to the extension
- **Cross-origin iframes** (e.g., embedded Workday application frames) may not be
  accessible to content scripts
- **Multi-page forms** require clicking Fill on each page; no automatic page navigation
- The rule-based matcher covers ~30 common field patterns; exotic or custom-worded
  fields may need the LLM fallback or manual entry
- Workday's custom dropdown components need additional adapter work for full support

---

## Development

Both tools are independent and can be developed separately:

- **Resume Tool**: Python, edit files in `resume_tool/`
- **Chrome Extension**: Vanilla JS, edit files in `extension/`, reload in `chrome://extensions/`

No build step is needed for either component. The extension uses no bundler -- just
reload the extension after making changes.

/**
 * resume_html_builder.js
 *
 * JavaScript port of resume_renderer.py's build_html().
 * Uses the exact same CSS so the output is visually identical.
 * Also provides a cover letter HTML builder.
 *
 * Exposes:
 *   window.JobAutofill.buildResumeHtml(resumeJson)
 *   window.JobAutofill.buildCoverLetterHtml(coverLetterText, jobMeta, personal)
 */

window.JobAutofill = window.JobAutofill || {};

(function () {
  var JA = window.JobAutofill;
  var COVER_LETTER_TEMPLATE_PATH = "shared/templates/cover_letter_template.html";
  var coverLetterTemplatePromise = null;

  function esc(text) {
    var div = document.createElement("div");
    div.textContent = String(text || "");
    return div.innerHTML;
  }

  var RESUME_CSS =
    "@page { size: letter; margin: 0.45in 0.5in; }\n" +
    "* { margin: 0; padding: 0; box-sizing: border-box; }\n" +
    'body { font-family: "Helvetica Neue", Helvetica, Arial, sans-serif; font-size: 9pt; line-height: 1.35; color: #111; }\n' +
    "a { color: inherit; text-decoration: none; }\n" +
    ".header { text-align: center; margin-bottom: 6pt; }\n" +
    ".header-name { font-size: 20pt; font-weight: 700; letter-spacing: 0.04em; margin-bottom: 2pt; }\n" +
    ".header-contact { font-size: 8pt; color: #444; }\n" +
    ".section { margin-bottom: 6pt; page-break-inside: avoid; }\n" +
    ".section-header { font-size: 9.5pt; font-weight: 700; text-transform: uppercase; letter-spacing: 0.08em; border-bottom: 1px solid #222; padding-bottom: 1.5pt; margin-bottom: 4pt; }\n" +
    ".entry { margin-bottom: 4pt; page-break-inside: avoid; }\n" +
    ".entry-header { display: flex; justify-content: space-between; align-items: baseline; }\n" +
    ".entry-title { font-weight: 700; font-size: 9pt; }\n" +
    ".entry-company { font-weight: 400; font-style: italic; }\n" +
    ".entry-date { font-size: 8.5pt; color: #444; white-space: nowrap; margin-left: 8pt; flex-shrink: 0; }\n" +
    ".entry-subtitle { font-style: italic; color: #333; font-size: 8.5pt; }\n" +
    ".entry-headline { font-size: 8pt; color: #555; margin-top: 1pt; }\n" +
    ".sub { font-size: 8pt; color: #444; margin-top: 1pt; }\n" +
    "ul { margin-top: 2pt; padding-left: 13pt; }\n" +
    "li { margin-bottom: 1.5pt; font-size: 8.5pt; }\n" +
    ".skill-row { margin-bottom: 2pt; font-size: 8.5pt; }\n" +
    ".skill-label { font-weight: 600; }\n" +
    "@media print { body { -webkit-print-color-adjust: exact; } }";

  function contactStrip(personal) {
    var parts = [];
    if (personal.email) {
      parts.push('<a href="mailto:' + esc(personal.email) + '">' + esc(personal.email) + "</a>");
    }
    if (personal.phone) parts.push(esc(personal.phone));
    if (personal.location) parts.push(esc(personal.location));
    if (personal.linkedin) {
      var label = personal.linkedin.replace("https://", "").replace("http://", "");
      parts.push('<a href="' + esc(personal.linkedin) + '">' + esc(label) + "</a>");
    }
    if (personal.github) {
      var label2 = personal.github.replace("https://", "").replace("http://", "");
      parts.push('<a href="' + esc(personal.github) + '">' + esc(label2) + "</a>");
    }
    return parts.join(" &nbsp;&middot;&nbsp; ");
  }

  function sectionWrap(title, body) {
    return '<div class="section"><div class="section-header">' + esc(title) + "</div>" + body + "</div>";
  }

  function bulletsHtml(items) {
    if (!items || items.length === 0) return "";
    var lis = "";
    for (var i = 0; i < items.length; i++) {
      lis += "<li>" + esc(items[i].text || "") + "</li>";
    }
    return "<ul>" + lis + "</ul>";
  }

  function buildEducation(education) {
    if (!education || education.length === 0) return "";
    var blocks = "";
    for (var i = 0; i < education.length; i++) {
      var edu = education[i];
      var rightCol = esc(edu.expected || "");
      if (edu.gpa) rightCol += " &nbsp;&middot;&nbsp; GPA: " + esc(String(edu.gpa));
      var cwStr = "";
      if (edu.coursework && edu.coursework.length > 0) {
        cwStr = '<div class="sub">Coursework: ' + esc(edu.coursework.join(", ")) + "</div>";
      }
      var awStr = "";
      if (edu.awards && edu.awards.length > 0) {
        awStr = '<div class="sub">Awards: ' + esc(edu.awards.join(", ")) + "</div>";
      }
      blocks +=
        '<div class="entry">' +
        '<div class="entry-header">' +
        '<span class="entry-title">' + esc(edu.institution || "") + "</span>" +
        '<span class="entry-date">' + rightCol + "</span>" +
        "</div>" +
        '<div class="entry-subtitle">' + esc(edu.degree || "") + "</div>" +
        cwStr + awStr +
        "</div>";
    }
    return sectionWrap("Education", blocks);
  }

  function buildSkills(skills) {
    if (!skills) return "";
    var mapping = [["languages", "Languages"], ["technologies", "Technologies"], ["concepts", "Concepts"]];
    var rows = "";
    for (var i = 0; i < mapping.length; i++) {
      var items = skills[mapping[i][0]] || [];
      if (items.length > 0) {
        rows += '<div class="skill-row"><span class="skill-label">' + esc(mapping[i][1]) + ":</span> " + esc(items.join(", ")) + "</div>";
      }
    }
    return rows ? sectionWrap("Skills", rows) : "";
  }

  function buildExperience(experience) {
    if (!experience || experience.length === 0) return "";
    var blocks = "";
    for (var i = 0; i < experience.length; i++) {
      var exp = experience[i];
      var dateRange = (exp.start || exp.end) ? esc(exp.start || "") + " \u2013 " + esc(exp.end || "") : "";
      var right = dateRange + (exp.location ? " &nbsp;&middot;&nbsp; " + esc(exp.location) : "");
      var headlineStr = exp.headline ? '<div class="entry-headline">' + esc(exp.headline) + "</div>" : "";
      blocks +=
        '<div class="entry">' +
        '<div class="entry-header">' +
        '<span class="entry-title">' + esc(exp.title || "") + ' <span class="entry-company">@ ' + esc(exp.company || "") + "</span></span>" +
        '<span class="entry-date">' + right + "</span>" +
        "</div>" +
        headlineStr +
        bulletsHtml(exp.bullets || []) +
        "</div>";
    }
    return sectionWrap("Experience", blocks);
  }

  function buildProjects(projects) {
    if (!projects || projects.length === 0) return "";
    var blocks = "";
    for (var i = 0; i < projects.length; i++) {
      var proj = projects[i];
      var tech = proj.tech || [];
      var techStr = tech.length > 0 ? '<span class="entry-headline">' + esc(tech.join(", ")) + "</span>" : "";
      blocks +=
        '<div class="entry">' +
        '<div class="entry-header">' +
        '<span class="entry-title">' + esc(proj.name || "") + "</span>" +
        techStr +
        "</div>" +
        bulletsHtml(proj.bullets || []) +
        "</div>";
    }
    return sectionWrap("Projects", blocks);
  }

  function buildLeadership(leadership) {
    if (!leadership || leadership.length === 0) return "";
    var blocks = "";
    for (var i = 0; i < leadership.length; i++) {
      var lead = leadership[i];
      var dateRange = (lead.start || lead.end) ? esc(lead.start || "") + " \u2013 " + esc(lead.end || "") : "";
      var right = dateRange + (lead.location ? " &nbsp;&middot;&nbsp; " + esc(lead.location) : "");
      blocks +=
        '<div class="entry">' +
        '<div class="entry-header">' +
        '<span class="entry-title">' + esc(lead.role || "") + ' <span class="entry-company">@ ' + esc(lead.organization || "") + "</span></span>" +
        '<span class="entry-date">' + right + "</span>" +
        "</div>" +
        bulletsHtml(lead.bullets || []) +
        "</div>";
    }
    return sectionWrap("Leadership", blocks);
  }

  JA.buildResumeHtml = function (data) {
    var personal = data.personal || {};
    var name = esc(personal.name || "Resume");

    var header =
      '<div class="header">' +
      '<div class="header-name">' + name + "</div>" +
      '<div class="header-contact">' + contactStrip(personal) + "</div>" +
      "</div>";

    var sections = [
      header,
      buildEducation(data.education || []),
      buildSkills(data.skills || {}),
      buildExperience(data.experience || []),
      buildProjects(data.projects || []),
      buildLeadership(data.leadership || []),
    ].filter(function (s) { return s && s.trim(); });

    var body = sections.join("\n");

    return "<!DOCTYPE html>\n" +
      '<html lang="en">\n<head>\n<meta charset="UTF-8">\n' +
      "<style>" + RESUME_CSS + "</style>\n" +
      "</head>\n<body>\n" + body + "\n" +
      "</body>\n</html>";
  };

  function replaceTemplateTokens(template, values) {
    return String(template || "").replace(/\{\{([A-Z0-9_]+)\}\}/g, function (_, key) {
      return Object.prototype.hasOwnProperty.call(values, key) ? String(values[key]) : "";
    });
  }

  function loadCoverLetterTemplate() {
    if (coverLetterTemplatePromise) return coverLetterTemplatePromise;

    var url = (typeof chrome !== "undefined" && chrome.runtime && chrome.runtime.getURL)
      ? chrome.runtime.getURL(COVER_LETTER_TEMPLATE_PATH)
      : COVER_LETTER_TEMPLATE_PATH;

    coverLetterTemplatePromise = fetch(url).then(function (response) {
      if (!response.ok) {
        throw new Error("Failed to load cover letter template: " + response.status);
      }
      return response.text();
    }).catch(function (err) {
      coverLetterTemplatePromise = null;
      throw err;
    });

    return coverLetterTemplatePromise;
  }

  function splitCoverLetterParagraphs(coverLetterText) {
    return String(coverLetterText || "")
      .split(/\n\s*\n/)
      .map(function (paragraph) { return paragraph.trim(); })
      .filter(function (paragraph) { return paragraph; });
  }

  function splitParagraphIntoTwo(paragraph) {
    var normalized = String(paragraph || "").replace(/\s+/g, " ").trim();
    if (!normalized) return null;

    var sentences = normalized.match(/[^.!?]+(?:[.!?]+|$)/g) || [];
    sentences = sentences.map(function (sentence) { return sentence.trim(); }).filter(Boolean);
    if (sentences.length < 2) return null;

    var midpoint = Math.ceil(sentences.length / 2);
    var firstHalf = sentences.slice(0, midpoint).join(" ").trim();
    var secondHalf = sentences.slice(midpoint).join(" ").trim();
    if (!firstHalf || !secondHalf) return null;
    return [firstHalf, secondHalf];
  }

  function paragraphGroupsForTemplate(coverLetterText) {
    var paragraphs = splitCoverLetterParagraphs(coverLetterText);
    if (!paragraphs.length) {
      return {
        opening: [],
        body1: [],
        body2: [],
        closing: [],
      };
    }

    if (paragraphs.length > 4) {
      return {
        opening: [paragraphs[0]],
        body1: [paragraphs[1]],
        body2: paragraphs.slice(2, paragraphs.length - 1),
        closing: [paragraphs[paragraphs.length - 1]],
      };
    }

    var groups = paragraphs.map(function (paragraph) {
      return [paragraph];
    });

    while (groups.length < 4) {
      var splitIndex = -1;
      var splitLength = -1;
      for (var i = 0; i < groups.length; i++) {
        var group = groups[i];
        if (!group || group.length !== 1) continue;
        if (!splitParagraphIntoTwo(group[0])) continue;
        if (group[0].length > splitLength) {
          splitLength = group[0].length;
          splitIndex = i;
        }
      }

      if (splitIndex === -1) break;
      var splitPair = splitParagraphIntoTwo(groups[splitIndex][0]);
      if (!splitPair) break;
      groups.splice(splitIndex, 1, [splitPair[0]], [splitPair[1]]);
    }

    while (groups.length < 4) groups.push([]);

    return {
      opening: groups[0],
      body1: groups[1],
      body2: groups[2],
      closing: groups[3],
    };
  }

  function paragraphGroupHtml(paragraphs) {
    if (!paragraphs || !paragraphs.length) return "";
    return paragraphs.map(function (paragraph) {
      return "<p>" + esc(paragraph) + "</p>";
    }).join("\n");
  }

  function formatCoverLetterDate(date) {
    var now = date || new Date();
    var months = ["January", "February", "March", "April", "May", "June", "July", "August", "September", "October", "November", "December"];
    return months[now.getMonth()] + " " + now.getDate() + ", " + now.getFullYear();
  }

  function trimUrlLabel(url) {
    return String(url || "").replace(/^https?:\/\//i, "").replace(/\/+$/g, "");
  }

  function joinHtmlParts(parts) {
    return (parts || []).filter(function (part) { return !!part; }).join(" &nbsp;·&nbsp; ");
  }

  function wrapLine(className, html) {
    return html ? '<div class="' + className + '">' + html + "</div>" : "";
  }

  function buildApplicantMetaHtml(personal) {
    personal = personal || {};
    var primaryLine = joinHtmlParts([
      personal.email ? esc(personal.email) : "",
      personal.phone ? esc(personal.phone) : "",
    ]);
    var secondaryLine = joinHtmlParts([
      personal.linkedin ? '<a href="' + esc(personal.linkedin) + '">' + esc(trimUrlLabel(personal.linkedin)) + "</a>" : "",
      personal.location ? esc(personal.location) : "",
    ]);

    return [
      wrapLine("meta-line", primaryLine),
      wrapLine("meta-line", secondaryLine),
    ].filter(Boolean).join("\n");
  }

  function buildRecipientHtml(jobMeta) {
    jobMeta = jobMeta || {};

    var hiringManagerName = String(jobMeta.hiringManagerName || jobMeta.hiring_manager_name || "Hiring Manager").trim() || "Hiring Manager";
    var hiringManagerTitle = String(jobMeta.hiringManagerTitle || jobMeta.hiring_manager_title || "").trim();
    var companyName = String(jobMeta.company || "").trim();
    var companyLocation = String(jobMeta.location || "").trim();

    var detailLines = [
      hiringManagerTitle ? '<div class="recipient-detail-line">' + esc(hiringManagerTitle) + "</div>" : "",
      companyName ? '<div class="recipient-detail-line">' + esc(companyName) + "</div>" : "",
      companyLocation ? '<div class="recipient-detail-line">' + esc(companyLocation) + "</div>" : "",
    ].filter(Boolean).join("\n");

    return [
      '<div class="recipient-name">' + esc(hiringManagerName) + "</div>",
      detailLines ? '<div class="recipient-detail">' + detailLines + "</div>" : "",
    ].filter(Boolean).join("\n");
  }

  JA.buildCoverLetterHtml = async function (coverLetterText, jobMeta, personal) {
    personal = personal || {};
    jobMeta = jobMeta || {};

    var template = await loadCoverLetterTemplate();
    var name = String(personal.name || "").trim();
    var paragraphGroups = paragraphGroupsForTemplate(coverLetterText);
    var salutation = String(jobMeta.hiringManagerName || jobMeta.hiring_manager_name || "Hiring Manager").trim() || "Hiring Manager";

    return replaceTemplateTokens(template, {
      APPLICANT_NAME: esc(name),
      APPLICANT_NAME_PRINT: esc(name),
      APPLICANT_META_HTML: buildApplicantMetaHtml(personal),
      DATE: esc(formatCoverLetterDate(new Date())),
      RECIPIENT_HTML: buildRecipientHtml(jobMeta),
      SALUTATION_LINE: esc("Dear " + salutation + ","),
      OPENING_PARAGRAPH_HTML: paragraphGroupHtml(paragraphGroups.opening),
      BODY_PARAGRAPH_1_HTML: paragraphGroupHtml(paragraphGroups.body1),
      BODY_PARAGRAPH_2_HTML: paragraphGroupHtml(paragraphGroups.body2),
      CLOSING_PARAGRAPH_HTML: paragraphGroupHtml(paragraphGroups.closing),
    });
  };

  loadCoverLetterTemplate().catch(function () {});
})();

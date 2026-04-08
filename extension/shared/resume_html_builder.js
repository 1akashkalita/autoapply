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
      "<script>window.onload=function(){window.print();}<\/script>\n" +
      "</body>\n</html>";
  };

  var COVER_LETTER_CSS =
    "@page { size: letter; margin: 1in; }\n" +
    "* { margin: 0; padding: 0; box-sizing: border-box; }\n" +
    'body { font-family: "Helvetica Neue", Helvetica, Arial, sans-serif; font-size: 11pt; line-height: 1.5; color: #111; }\n' +
    "a { color: inherit; text-decoration: none; }\n" +
    ".cl-header { text-align: center; margin-bottom: 24pt; }\n" +
    ".cl-name { font-size: 18pt; font-weight: 700; letter-spacing: 0.03em; margin-bottom: 2pt; }\n" +
    ".cl-contact { font-size: 9pt; color: #444; }\n" +
    ".cl-date { margin-bottom: 18pt; font-size: 10pt; color: #444; }\n" +
    ".cl-body p { margin-bottom: 12pt; text-align: justify; }\n" +
    "@media print { body { -webkit-print-color-adjust: exact; } }";

  JA.buildCoverLetterHtml = function (coverLetterText, jobMeta, personal) {
    personal = personal || {};
    jobMeta = jobMeta || {};

    var name = esc(personal.name || "");
    var contactParts = [];
    if (personal.email) contactParts.push(esc(personal.email));
    if (personal.phone) contactParts.push(esc(personal.phone));
    if (personal.location) contactParts.push(esc(personal.location));
    var contactLine = contactParts.join(" &nbsp;&middot;&nbsp; ");

    var now = new Date();
    var months = ["January","February","March","April","May","June","July","August","September","October","November","December"];
    var dateStr = months[now.getMonth()] + " " + now.getDate() + ", " + now.getFullYear();

    var paragraphs = (coverLetterText || "").split(/\n\s*\n/).filter(function (p) { return p.trim(); });
    var bodyHtml = "";
    for (var i = 0; i < paragraphs.length; i++) {
      bodyHtml += "<p>" + esc(paragraphs[i].trim()) + "</p>\n";
    }

    return "<!DOCTYPE html>\n" +
      '<html lang="en">\n<head>\n<meta charset="UTF-8">\n' +
      "<style>" + COVER_LETTER_CSS + "</style>\n" +
      "</head>\n<body>\n" +
      '<div class="cl-header">\n' +
      '<div class="cl-name">' + name + "</div>\n" +
      '<div class="cl-contact">' + contactLine + "</div>\n" +
      "</div>\n" +
      '<div class="cl-date">' + esc(dateStr) + "</div>\n" +
      '<div class="cl-body">\n' + bodyHtml + "</div>\n" +
      "<script>window.onload=function(){window.print();}<\/script>\n" +
      "</body>\n</html>";
  };
})();

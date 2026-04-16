/**
 * Shared matching rules and logic.
 * Environment-agnostic: works in both service worker (importScripts) and
 * content script (window) contexts.
 */

/* eslint-disable no-var */
var MatchRules = (function () {
  var LINK_HOSTS = {
    linkedin: "linkedin.com",
    github: "github.com",
    leetcode: "leetcode.com",
    huggingface: "huggingface.co",
  };

  var RULES = [
    {
      key: "first_name",
      patterns: [/\bfirst[\s_-]?name\b/i, /\bgiven[\s_-]?name\b/i, /\bfname\b/i],
      autocomplete: "given-name",
    },
    {
      key: "last_name",
      patterns: [/\blast[\s_-]?name\b/i, /\bfamily[\s_-]?name\b/i, /\bsurname\b/i, /\blname\b/i],
      autocomplete: "family-name",
    },
    {
      key: "full_name",
      patterns: [/\bfull[\s_-]?name\b/i, /\byour[\s_-]?name\b/i],
      autocomplete: "name",
      derive: function (p) { return [p.first_name, p.last_name].filter(Boolean).join(" "); },
    },
    {
      key: "email",
      patterns: [/\be[\s_-]?mail\b/i, /\bemail[\s_-]?address\b/i],
      autocomplete: "email",
      inputType: "email",
    },
    {
      key: "phone",
      patterns: [/\bphone\b/i, /\btelephone\b/i, /\bmobile\b/i, /\bcell\b/i, /\bphone[\s_-]?number\b/i],
      autocomplete: "tel",
      inputType: "tel",
    },
    {
      key: "address.street",
      patterns: [/\bstreet[\s_-]?address\b/i, /\baddress[\s_-]?line[\s_-]?1\b/i, /\baddress\b/i],
      autocomplete: "address-line1",
    },
    {
      key: "address.city",
      patterns: [/\bcity\b/i, /\btown\b/i],
      autocomplete: "address-level2",
    },
    {
      key: "address.state",
      patterns: [/\bstate\b/i, /\bprovince\b/i, /\bregion\b/i],
      autocomplete: "address-level1",
    },
    {
      key: "address.zip",
      patterns: [/\bzip\b/i, /\bpostal[\s_-]?code\b/i, /\bpostcode\b/i],
      autocomplete: "postal-code",
    },
    {
      key: "address.country",
      patterns: [/\bcountry\b/i],
      autocomplete: "country-name",
    },
    {
      key: "linkedin",
      patterns: [/\blinked[\s_-]?in\b/i, /\blinkedin[\s_-]?profile\b/i],
      derive: function (p, field, signal) { return deriveLinkValue(p.linkedin, "linkedin", field, signal); },
    },
    {
      key: "github",
      patterns: [/\bgit[\s_-]?hub\b/i, /\bgithub[\s_-]?profile\b/i],
      derive: function (p, field, signal) { return deriveLinkValue(p.github, "github", field, signal); },
    },
    {
      key: "portfolio",
      patterns: [/\bportfolio\b/i, /\bpersonal[\s_-]?(site|website|web[\s_-]?site)\b/i, /\bportfolio[\s_-]?link\b/i, /\bhomepage\b/i, /\bpublic[\s_-]?profile\b/i],
      derive: function (p, field, signal) {
        if (shouldSkipGenericWebsiteField(field, signal)) return "";
        return deriveLinkValue(p.portfolio, "portfolio", field, signal);
      },
    },
    {
      key: "leetcode",
      patterns: [/\bleet[\s_-]?code\b/i, /\bcoding[\s_-]?profile\b/i],
      derive: function (p, field, signal) { return deriveLinkValue(p.leetcode, "leetcode", field, signal); },
    },
    {
      key: "huggingface",
      patterns: [/\bhugging[\s_-]?face\b/i, /\bhf[\s_-]?profile\b/i],
      derive: function (p, field, signal) { return deriveLinkValue(p.huggingface, "huggingface", field, signal); },
    },
    {
      key: "university",
      patterns: [/\buniversity\b/i, /\bschool\b/i, /\bcollege\b/i, /\binstitution\b/i, /\bschool[\s_-]?name\b/i],
    },
    {
      key: "degree",
      patterns: [/\bdegree\b/i, /\bmajor\b/i, /\bfield[\s_-]?of[\s_-]?study\b/i],
    },
    {
      key: "gpa",
      patterns: [/\bgpa\b/i, /\bgrade[\s_-]?point\b/i, /\bcumulative[\s_-]?gpa\b/i],
    },
    {
      key: "graduation_year",
      patterns: [
        /\bgraduation[\s_-]?year\b/i, /\bgrad[\s_-]?year\b/i,
        /\byear[\s_-]?of[\s_-]?graduation\b/i, /\bexpected[\s_-]?graduation\b/i,
      ],
    },
    {
      key: "graduation_month",
      patterns: [/\bgraduation[\s_-]?month\b/i, /\bgrad[\s_-]?month\b/i],
    },
    {
      key: "graduation_date",
      patterns: [/\bgraduation[\s_-]?date\b/i, /\bgrad[\s_-]?date\b/i],
      derive: function (p) { return [p.graduation_month, p.graduation_year].filter(Boolean).join(" "); },
    },
    {
      key: "work_authorization",
      patterns: [
        /\bwork[\s_-]?auth/i, /\bauthori[sz]ed[\s_-]?to[\s_-]?work\b/i,
        /\beligib/i, /\blegal[\s_-]?right\b/i,
      ],
    },
    {
      key: "require_sponsorship",
      patterns: [
        /\bsponsorship\b/i, /\bvisa[\s_-]?sponsor/i, /\brequire[\s_-]?sponsor/i,
        /\bneed[\s_-]?sponsor/i, /\bimmigration[\s_-]?sponsor/i,
      ],
    },
    {
      key: "years_of_experience",
      patterns: [
        /\byears[\s_-]?of[\s_-]?experience\b/i, /\bexperience[\s_-]?years\b/i,
        /\byears[\s_-]?experience\b/i, /\btotal[\s_-]?experience\b/i,
      ],
    },
    {
      key: "gender",
      patterns: [/\bgender\b/i, /\bsex\b/i],
      semanticType: "gender",
    },
    {
      key: "veteran_status",
      patterns: [/\bveteran\b/i, /\bprotected[\s_-]?veteran\b/i],
      semanticType: "veteran",
    },
    {
      key: "military_status",
      patterns: [/\bmilitary[\s_-]?status\b/i, /\bservice[\s_-]?status\b/i, /\barmed[\s_-]?forces\b/i],
      semanticType: "military",
    },
    {
      key: "disability_status",
      patterns: [/\bdisabilit(y|ies)\b/i, /\bself[\s_-]?identify\b/i],
      semanticType: "disability",
    },
  ];

  function normalizeProfile(profile) {
    var next = profile || {};
    if (!next.address || typeof next.address !== "object") next.address = {};
    return next;
  }

  function normalizeUrl(url, hostKey) {
    var value = String(url || "").trim();
    if (!value) return "";
    if (!/^https?:\/\//i.test(value)) value = "https://" + value.replace(/^\/+/, "");
    try {
      var parsed = new URL(value);
      if (hostKey && LINK_HOSTS[hostKey]) parsed.hostname = LINK_HOSTS[hostKey];
      parsed.hash = "";
      return parsed.toString().replace(/\/$/, "");
    } catch (err) {
      return value;
    }
  }

  function extractUsernameFromUrl(url, hostKey) {
    var normalized = normalizeUrl(url, hostKey);
    if (!normalized) return "";
    try {
      var parsed = new URL(normalized);
      var parts = parsed.pathname.split("/").filter(Boolean);
      if (!parts.length) return "";
      if (hostKey === "linkedin" && parts[0] === "in" && parts[1]) return parts[1];
      return parts[parts.length - 1];
    } catch (err) {
      return "";
    }
  }

  function fieldWantsUsername(field, signal) {
    var label = String(field.label || "") + " " + String(field.placeholder || "");
    return /\b(username|user\s*name|handle|profile\s*id|id)\b/i.test(label) ||
      (field.type === "text" && /\bhandle\b/i.test(signal));
  }

  function shouldSkipGenericWebsiteField(field, signal) {
    if (!/\b(url|website|portfolio|site|homepage|profile)\b/i.test(signal)) return true;
    if (/\b(company|employer|school|university|reference|referrer|recruiter|social\s*security)\b/i.test(signal)) return true;
    if (field.type && field.type !== "url" && field.type !== "text") return true;
    return false;
  }

  function deriveLinkValue(rawUrl, hostKey, field, signal) {
    var normalized = normalizeUrl(rawUrl, hostKey);
    if (!normalized) return "";
    if (fieldWantsUsername(field, signal) && hostKey !== "portfolio") {
      return extractUsernameFromUrl(normalized, hostKey);
    }
    return normalized;
  }

  function buildCustomLinkRules(profile) {
    var rules = [];
    [1, 2].forEach(function (index) {
      var label = String(profile["other_link_" + index + "_label"] || "").trim();
      var url = String(profile["other_link_" + index + "_url"] || "").trim();
      if (!label || !url) return;
      var safeLabel = label.replace(/[.*+?^${}()|[\]\\]/g, "\\$&");
      rules.push({
        key: "other_link_" + index + "_url",
        patterns: [new RegExp("\\b" + safeLabel + "\\b", "i")],
        derive: function (p, field, signal) {
          return deriveLinkValue(p["other_link_" + index + "_url"], "portfolio", field, signal);
        },
      });
    });
    return rules;
  }

  function buildSignal(field) {
    return [
      field.label, field.placeholder, field.name, field.id,
      field.aria_label, field.nearby_text,
      Object.values(field.data_attrs || {}).join(" "),
    ].join(" ").toLowerCase();
  }

  function resolveKey(obj, key) {
    return key.split(".").reduce(function (o, k) {
      return o && o[k] !== undefined ? o[k] : "";
    }, obj);
  }

  function matchBooleanOption(profileValue, options) {
    var boolVal = profileValue === true || profileValue === "true" ||
                  profileValue === "yes" || profileValue === "Yes";
    var pos = /\b(yes|true|i\s*do|will\s*require)\b/i;
    var neg = /\b(no|false|i\s*do\s*not|will\s*not|don'?t)\b/i;

    for (var i = 0; i < options.length; i++) {
      var text = options[i].text || options[i].value || "";
      if (boolVal && pos.test(text)) return options[i].value;
      if (!boolVal && neg.test(text)) return options[i].value;
    }
    return null;
  }

  function matchAuthorizationOption(profileValue, options) {
    var lower = String(profileValue || "").toLowerCase();
    for (var i = 0; i < options.length; i++) {
      var optText = String(options[i].text || "").toLowerCase();
      if (optText && lower && optText.indexOf(lower.substring(0, 10)) !== -1) return options[i].value;
    }
    var isCitizen = /citizen|authorized|permanent/i.test(lower);
    for (var j = 0; j < options.length; j++) {
      var text = String(options[j].text || "").toLowerCase();
      if (isCitizen && /citizen|authorized|permanent|no\s*sponsor/i.test(text)) return options[j].value;
    }
    return null;
  }

  function matchGenericOption(value, options) {
    var lower = String(value || "").toLowerCase();
    for (var i = 0; i < options.length; i++) {
      var ov = String(options[i].value || "").toLowerCase();
      var ot = String(options[i].text || "").toLowerCase();
      if (ov === lower || ot === lower || ot.indexOf(lower) !== -1 || ov.indexOf(lower) !== -1) {
        return options[i].value;
      }
    }
    return null;
  }

  function semanticMatches(type, optionText, optionValue) {
    var text = (optionText + " " + optionValue).toLowerCase();
    return {
      isDecline: /decline|prefer\s*not|self[\s_-]?identify|choose\s*not/i.test(text),
      isYes: /\byes\b|have\s+a\s+disability|protected\s+veteran|active\s+duty|currently\s+serving|male|female|non[\s_-]?binary/i.test(text),
      isNo: /\bno\b|not\s+have|not\s+a\s+veteran|none|not\s+applicable|do\s+not\s+wish/i.test(text),
      type: type,
    };
  }

  function matchSemanticOption(profileValue, options, semanticType) {
    var normalized = String(profileValue || "").toLowerCase();
    if (!normalized) return null;

    for (var i = 0; i < options.length; i++) {
      var ov = String(options[i].value || "");
      var ot = String(options[i].text || "");
      var lowerCombined = (ov + " " + ot).toLowerCase();
      if (lowerCombined === normalized || lowerCombined.indexOf(normalized) !== -1 || normalized.indexOf(lowerCombined) !== -1) {
        return options[i].value;
      }
    }

    for (var j = 0; j < options.length; j++) {
      var option = options[j];
      var flags = semanticMatches(semanticType, String(option.text || ""), String(option.value || ""));
      if (semanticType === "gender") {
        if (normalized === "decline" && flags.isDecline) return option.value;
        if (normalized === "male" && /\bmale\b/i.test(option.text || option.value || "")) return option.value;
        if (normalized === "female" && /\bfemale\b/i.test(option.text || option.value || "")) return option.value;
        if (normalized === "non_binary" && /non[\s_-]?binary|genderqueer|gender\s+non/i.test(option.text || option.value || "")) return option.value;
      } else if (semanticType === "veteran") {
        if (normalized === "decline" && flags.isDecline) return option.value;
        if (normalized === "protected_veteran" && /protected\s+veteran|disabled\s+veteran|recently\s+separated/i.test(option.text || option.value || "")) return option.value;
        if (normalized === "not_protected_veteran" && (/not\s+a?\s*protected\s+veteran|i\s*am\s*not\s*a?\s*veteran|\bno\b/i.test(option.text || option.value || ""))) return option.value;
      } else if (semanticType === "military") {
        if (normalized === "decline" && flags.isDecline) return option.value;
        if (normalized === "active_duty" && /active\s+duty|currently\s+serving/i.test(option.text || option.value || "")) return option.value;
        if (normalized === "veteran" && /\bveteran\b/i.test(option.text || option.value || "")) return option.value;
        if (normalized === "military_spouse" && /spouse/i.test(option.text || option.value || "")) return option.value;
        if (normalized === "not_applicable" && (flags.isNo || /not\s+applicable|none/i.test(option.text || option.value || ""))) return option.value;
      } else if (semanticType === "disability") {
        if (normalized === "decline" && flags.isDecline) return option.value;
        if (normalized === "has_disability" && /yes|have\s+a\s+disability/i.test(option.text || option.value || "")) return option.value;
        if (normalized === "no_disability" && /no|do\s+not\s+have/i.test(option.text || option.value || "")) return option.value;
      }
    }

    return null;
  }

  function matchRadioValue(field, profileValue, semanticType, signal) {
    var raw = String(profileValue || "");
    if (!raw) return "";
    if (semanticType) return raw;
    if (field.type === "radio" && /\b(no|don'?t|do\s*not)\b/i.test(signal)) {
      var boolVal = raw === true || raw === "true" || raw === "yes";
      return String(!boolVal);
    }
    return raw;
  }

  function matchesRule(rule, field, signal) {
    if (rule.autocomplete && field.autocomplete && field.autocomplete === rule.autocomplete) return true;
    if (rule.inputType && field.type === rule.inputType) return true;
    if (rule.patterns) {
      for (var i = 0; i < rule.patterns.length; i++) {
        if (rule.patterns[i].test(signal)) return true;
      }
    }
    return false;
  }

  function valueForRule(rule, profile, field, signal) {
    var value = rule.derive ? rule.derive(profile, field, signal) : resolveKey(profile, rule.key);
    var isDropdown = field.tag === "select" || field.control_kind === "native_select" || field.control_kind === "custom_select";

    if (isDropdown && field.options && field.options.length > 0) {
      if (rule.key === "require_sponsorship") {
        value = matchBooleanOption(value, field.options);
      } else if (rule.key === "work_authorization") {
        value = matchAuthorizationOption(value, field.options);
      } else if (rule.semanticType) {
        value = matchSemanticOption(value, field.options, rule.semanticType);
      } else {
        value = matchGenericOption(value, field.options);
      }
    } else if (field.control_kind === "custom_select") {
      value = value === null || value === undefined ? "" : String(value);
    }

    if ((field.type === "checkbox" || field.type === "radio") && rule.key === "require_sponsorship") {
      var boolVal = value === true || value === "true" || value === "yes";
      var isNegativeField = /\b(no|don'?t|do\s*not)\b/i.test(signal);
      value = isNegativeField ? !boolVal : boolVal;
    } else if (field.type === "radio" && rule.semanticType) {
      value = matchRadioValue(field, value, rule.semanticType, signal);
    }

    return value;
  }

  /**
   * Run rule-based matching on an array of extracted fields against a profile.
   * @param {Array} fields
   * @param {Object} profile
   * @returns {Array} mappings
   */
  function ruleBasedMatch(fields, profile) {
    var normalizedProfile = normalizeProfile(profile);
    var rules = RULES.concat(buildCustomLinkRules(normalizedProfile));
    var mappings = [];
    var matched = {};

    for (var fi = 0; fi < fields.length; fi++) {
      var field = fields[fi];
      var signal = buildSignal(field);

      for (var ri = 0; ri < rules.length; ri++) {
        var rule = rules[ri];
        if (!matchesRule(rule, field, signal)) continue;

        var value = valueForRule(rule, normalizedProfile, field, signal);
        var label = field.label || field.placeholder || field.name || field.selector;

        if (value !== null && value !== undefined && value !== "") {
          mappings.push({
            field_label: label,
            selector: field.selector,
            value: String(value),
            confidence: 0.95,
            profileKey: rule.key,
          });
        } else {
          mappings.push({
            field_label: label,
            selector: field.selector,
            value: "",
            confidence: 0.3,
            profileKey: rule.key,
            reason: "no profile value for matched key",
          });
        }

        matched[field.selector] = true;
        break;
      }

      if (!matched[field.selector]) {
        var fieldLabel = field.label || field.placeholder || field.name || field.selector;
        mappings.push({
          field_label: fieldLabel,
          selector: field.selector,
          value: "",
          confidence: 0,
          profileKey: null,
          reason: "no matching rule",
        });
      }
    }

    return mappings;
  }

  return {
    RULES: RULES,
    buildSignal: buildSignal,
    resolveKey: resolveKey,
    normalizeUrl: normalizeUrl,
    extractUsernameFromUrl: extractUsernameFromUrl,
    matchBooleanOption: matchBooleanOption,
    matchAuthorizationOption: matchAuthorizationOption,
    matchGenericOption: matchGenericOption,
    matchSemanticOption: matchSemanticOption,
    ruleBasedMatch: ruleBasedMatch,
  };
})();

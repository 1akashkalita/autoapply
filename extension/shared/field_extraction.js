/**
 * DOM field scanner.
 * Extracts native inputs plus common custom dropdown widgets.
 */

window.JobAutofill = window.JobAutofill || {};

window.JobAutofill.extractFields = function () {
  function textOf(el) {
    return el && (el.innerText || el.textContent || "").replace(/\s+/g, " ").trim();
  }

  function visible(el) {
    if (!el || !el.getBoundingClientRect) return false;
    var rect = el.getBoundingClientRect();
    if (!rect.width && !rect.height) return false;
    var style = window.getComputedStyle ? window.getComputedStyle(el) : null;
    if (style && (style.visibility === "hidden" || style.display === "none")) return false;
    return true;
  }

  function labelFor(el) {
    if (!el) return "";

    var labelledBy = el.getAttribute("aria-labelledby");
    if (labelledBy) {
      var labelText = labelledBy.split(/\s+/).map(function (id) {
        return textOf(document.getElementById(id));
      }).filter(Boolean).join(" ");
      if (labelText) return labelText;
    }

    var ariaLabel = el.getAttribute("aria-label");
    if (ariaLabel) return ariaLabel.trim();

    if (el.id) {
      var lbl = document.querySelector('label[for="' + el.id + '"]');
      if (lbl) return textOf(lbl);
    }

    var parent = el.closest("label");
    if (parent) return textOf(parent);

    var prev = el.previousElementSibling;
    if (prev && prev.tagName === "LABEL") return textOf(prev);

    var wrapper = el.closest("[data-automation-id], [data-testid], .application-field, .field, .form-group, fieldset, section, li, div");
    if (wrapper) {
      var candidate = wrapper.querySelector("label, legend, [data-automation-id*='label' i], [data-testid*='label' i]");
      if (candidate) return textOf(candidate);
    }

    return "";
  }

  function selectorFor(el) {
    if (el.id) return "#" + CSS.escape(el.id);
    if (el.name) {
      var byName = document.querySelectorAll(el.tagName + '[name="' + el.name + '"]');
      if (byName.length === 1) return el.tagName.toLowerCase() + '[name="' + el.name + '"]';
    }
    var parent = el.parentElement;
    if (!parent) return el.tagName.toLowerCase();
    var siblings = Array.from(parent.children).filter(function (c) { return c.tagName === el.tagName; });
    var idx = siblings.indexOf(el) + 1;
    var parentSel = parent.id ? "#" + CSS.escape(parent.id) : parent.tagName.toLowerCase();
    return parentSel + " > " + el.tagName.toLowerCase() + ":nth-of-type(" + idx + ")";
  }

  function nearbyText(el) {
    var node = el.previousSibling;
    for (var i = 0; i < 3 && node; i++) {
      if (node.nodeType === Node.TEXT_NODE) {
        var txt = node.textContent.trim();
        if (txt) return txt;
      }
      if (node.nodeType === Node.ELEMENT_NODE) {
        var elementText = textOf(node);
        if (elementText && elementText.length < 200) return elementText;
      }
      node = node.previousSibling;
    }

    var wrapper = el.closest("div, fieldset, section, li");
    if (wrapper) {
      var heading = wrapper.querySelector("h1, h2, h3, h4, h5, h6, legend");
      if (heading) return textOf(heading);
    }
    return "";
  }

  function dataAttrs(el) {
    var out = {};
    for (var i = 0; i < el.attributes.length; i++) {
      var attr = el.attributes[i];
      if (attr.name.indexOf("data-") === 0) out[attr.name] = attr.value;
    }
    return out;
  }

  function classifyNativeControl(el) {
    var tag = el.tagName.toLowerCase();
    var type = (el.type || "").toLowerCase();
    if (tag === "select") return "native_select";
    if (type === "file") return "file";
    if (type === "checkbox") return "checkbox";
    if (type === "radio") return "radio";
    return "text";
  }

  function optionListForNativeSelect(el) {
    return Array.from(el.options || []).map(function (o) {
      return {
        value: o.value,
        text: textOf(o),
      };
    });
  }

  function collectVisibleCustomOptions(host) {
    var results = [];
    var seen = {};
    var optionNodes = [];
    var controlsId = host.getAttribute("aria-controls");
    if (controlsId) {
      var controlled = document.getElementById(controlsId);
      if (controlled) optionNodes = optionNodes.concat(Array.from(controlled.querySelectorAll('[role="option"], option, li')));
    }
    optionNodes = optionNodes.concat(Array.from(document.querySelectorAll('[role="listbox"] [role="option"], [role="option"]')));

    optionNodes.forEach(function (node) {
      if (!visible(node)) return;
      var text = textOf(node);
      if (!text) return;
      var key = text.toLowerCase();
      if (seen[key]) return;
      seen[key] = true;
      results.push({
        value: node.getAttribute("data-value") || node.getAttribute("value") || text,
        text: text,
      });
    });
    return results;
  }

  function customSelectCandidates() {
    var selector = [
      '[role="combobox"]',
      'button[aria-haspopup="listbox"]',
      '[aria-haspopup="listbox"][tabindex]',
      '[data-automation-id*="dropdown" i]',
      '[data-automation-id*="select" i][tabindex]'
    ].join(", ");

    return Array.from(document.querySelectorAll(selector)).filter(function (el) {
      if (!visible(el)) return false;
      if (/^(INPUT|SELECT|TEXTAREA)$/.test(el.tagName)) return false;
      if (el.closest('input, select, textarea')) return false;
      var role = (el.getAttribute("role") || "").toLowerCase();
      var label = (labelFor(el) + " " + nearbyText(el) + " " + textOf(el)).trim();
      if (!role && !/select|choose|dropdown|option|workday/i.test(label + " " + (el.getAttribute("data-automation-id") || ""))) {
        return false;
      }
      return true;
    });
  }

  var results = [];
  var seenSelectors = {};
  var elements = document.querySelectorAll("input, select, textarea");

  Array.from(elements).forEach(function (el) {
    if (el.type === "hidden") return;
    if (el.type !== "file" && !visible(el)) return;

    var info = {
      tag: el.tagName.toLowerCase(),
      type: el.type || "",
      control_kind: classifyNativeControl(el),
      name: el.name || "",
      id: el.id || "",
      placeholder: el.placeholder || "",
      aria_label: el.getAttribute("aria-label") || "",
      autocomplete: el.getAttribute("autocomplete") || "",
      label: labelFor(el),
      nearby_text: nearbyText(el),
      value: el.value || "",
      required: el.required || false,
      selector: selectorFor(el),
      data_attrs: dataAttrs(el),
      options: [],
      interaction: null,
    };

    if (info.control_kind === "native_select") {
      info.options = optionListForNativeSelect(el);
      info.interaction = {
        kind: "native_select",
        openSelector: info.selector,
      };
    }

    if (info.control_kind === "checkbox" || info.control_kind === "radio") {
      info.checked = !!el.checked;
    }

    results.push(info);
    seenSelectors[info.selector] = true;
  });

  customSelectCandidates().forEach(function (el) {
    var selector = selectorFor(el);
    if (seenSelectors[selector]) return;
    var options = collectVisibleCustomOptions(el);
    var info = {
      tag: el.tagName.toLowerCase(),
      type: "",
      control_kind: "custom_select",
      name: el.getAttribute("name") || "",
      id: el.id || "",
      placeholder: el.getAttribute("placeholder") || "",
      aria_label: el.getAttribute("aria-label") || "",
      autocomplete: "",
      label: labelFor(el),
      nearby_text: nearbyText(el),
      value: textOf(el),
      required: el.getAttribute("aria-required") === "true",
      selector: selector,
      data_attrs: dataAttrs(el),
      options: options,
      interaction: {
        kind: "custom_select",
        openSelector: selector,
        listboxId: el.getAttribute("aria-controls") || "",
        popupRole: el.getAttribute("aria-haspopup") || "",
      },
    };
    results.push(info);
    seenSelectors[selector] = true;
  });

  return results;
};

/**
 * DOM field scanner.
 * Ported from resume_tool/autofill_agent.py JS_EXTRACT_FIELDS (lines 78-137)
 * with enhancements: autocomplete attribute, data-* attributes, nearby text.
 */

window.JobAutofill = window.JobAutofill || {};

window.JobAutofill.extractFields = function () {
  function labelFor(el) {
    if (el.id) {
      const lbl = document.querySelector('label[for="' + el.id + '"]');
      if (lbl) return lbl.innerText.trim();
    }
    const parent = el.closest("label");
    if (parent) return parent.innerText.trim();
    const prev = el.previousElementSibling;
    if (prev && prev.tagName === "LABEL") return prev.innerText.trim();
    return "";
  }

  function selectorFor(el) {
    if (el.id) return "#" + CSS.escape(el.id);
    if (el.name) {
      const byName = document.querySelectorAll(
        el.tagName + '[name="' + el.name + '"]'
      );
      if (byName.length === 1)
        return el.tagName.toLowerCase() + '[name="' + el.name + '"]';
    }
    const parent = el.parentElement;
    if (!parent) return el.tagName.toLowerCase();
    const siblings = Array.from(parent.children).filter(
      (c) => c.tagName === el.tagName
    );
    const idx = siblings.indexOf(el) + 1;
    const parentSel = parent.id
      ? "#" + CSS.escape(parent.id)
      : parent.tagName.toLowerCase();
    return (
      parentSel + " > " + el.tagName.toLowerCase() + ":nth-of-type(" + idx + ")"
    );
  }

  function nearbyText(el) {
    // Walk backwards through siblings / parent to find contextual text
    let node = el.previousSibling;
    for (let i = 0; i < 3 && node; i++) {
      if (node.nodeType === Node.TEXT_NODE) {
        const t = node.textContent.trim();
        if (t) return t;
      }
      if (node.nodeType === Node.ELEMENT_NODE) {
        const t = node.innerText && node.innerText.trim();
        if (t && t.length < 200) return t;
      }
      node = node.previousSibling;
    }
    // Check parent's preceding heading
    const wrapper = el.closest("div, fieldset, section, li");
    if (wrapper) {
      const heading = wrapper.querySelector("h1, h2, h3, h4, h5, h6, legend");
      if (heading) return heading.innerText.trim();
    }
    return "";
  }

  function dataAttrs(el) {
    const out = {};
    for (const attr of el.attributes) {
      if (attr.name.startsWith("data-")) {
        out[attr.name] = attr.value;
      }
    }
    return out;
  }

  const results = [];
  const elements = document.querySelectorAll("input, select, textarea");
  for (const el of elements) {
    if (el.type === "hidden") continue;
    const rect = el.getBoundingClientRect();
    if (el.type !== "file" && rect.width === 0 && rect.height === 0) continue;

    const info = {
      tag: el.tagName.toLowerCase(),
      type: el.type || "",
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
    };

    if (el.tagName === "SELECT") {
      info.options = Array.from(el.options).map((o) => ({
        value: o.value,
        text: o.text.trim(),
      }));
    }

    if (el.type === "checkbox" || el.type === "radio") {
      info.checked = el.checked;
    }

    results.push(info);
  }
  return results;
};

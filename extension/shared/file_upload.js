/**
 * Shared file upload helpers for native and custom ATS widgets.
 */

window.JobAutofill = window.JobAutofill || {};

(function () {
  var JA = window.JobAutofill;

  function normalizedDocType(docType) {
    return docType === "coverLetter" ? "coverLetter" : "resume";
  }

  function contextForInput(el) {
    var parts = [
      el.name || "",
      el.id || "",
      el.getAttribute("aria-label") || "",
      el.getAttribute("accept") || "",
      el.getAttribute("data-automation-id") || "",
      el.getAttribute("data-testid") || "",
    ];

    if (el.id) {
      var label = document.querySelector('label[for="' + el.id + '"]');
      if (label) parts.push(label.innerText || "");
    }
    var parentLabel = el.closest("label");
    if (parentLabel) parts.push(parentLabel.innerText || "");

    var wrapper = el.closest("section, form, fieldset, div, li");
    if (wrapper) {
      parts.push(wrapper.innerText || "");
      var describedBy = wrapper.getAttribute && wrapper.getAttribute("aria-describedby");
      if (describedBy) {
        var described = document.getElementById(describedBy);
        if (described) parts.push(described.innerText || "");
      }
    }

    if (JA.nearbyTextForElement) parts.push(JA.nearbyTextForElement(el));
    return parts.join(" ").replace(/\s+/g, " ").trim().toLowerCase();
  }

  function scoreInput(el, docType) {
    var ctx = contextForInput(el);
    var score = 0;

    if ((el.accept || "").toLowerCase().indexOf("pdf") !== -1) score += 1;
    if (docType === "resume" && /resume|curriculum|cv/.test(ctx)) score += 8;
    if (docType === "coverLetter" && /cover\s*letter|motivation|supporting document|letter of/.test(ctx)) score += 8;
    if (/upload|drop|attach|document|file/.test(ctx)) score += 2;
    if (el.disabled) score -= 100;
    return score;
  }

  function getAdapter() {
    return JA.adapterRegistry ? JA.adapterRegistry.getAdapter(window.location.href) : null;
  }

  function findBestGenericInput(docType) {
    var inputs = Array.from(document.querySelectorAll('input[type="file"]'));
    if (!inputs.length) return null;

    var scored = inputs
      .map(function (el) { return { el: el, score: scoreInput(el, docType) }; })
      .sort(function (a, b) { return b.score - a.score; });

    if (scored[0] && scored[0].score > -50) return scored[0].el;
    return inputs[0];
  }

  function buildSyntheticFile(fileData) {
    var bytes = JA.base64ToBytes(fileData.dataBase64);
    return new File([bytes], fileData.name || "resume.pdf", {
      type: fileData.mime || "application/pdf",
      lastModified: Date.now(),
    });
  }

  function assignFiles(input, files) {
    var dt = new DataTransfer();
    files.forEach(function (file) { dt.items.add(file); });
    input.files = dt.files;
  }

  function dispatchFileEvents(input) {
    try { input.dispatchEvent(new Event("focus", { bubbles: true })); } catch (e) {}
    try { input.dispatchEvent(new Event("input", { bubbles: true })); } catch (e2) {}
    try { input.dispatchEvent(new Event("change", { bubbles: true })); } catch (e3) {}
    try { input.dispatchEvent(new Event("blur", { bubbles: true })); } catch (e4) {}
  }

  JA.attachFileToElement = function (input, fileData) {
    if (!input || !fileData || !fileData.dataBase64) {
      throw new Error("Missing file input or file data");
    }
    var synthetic = buildSyntheticFile(fileData);
    assignFiles(input, [synthetic]);
    dispatchFileEvents(input);
    return {
      ok: true,
      fileName: synthetic.name,
      selector: input.id ? ("#" + input.id) : (input.name || input.type || "input[type=file]"),
    };
  };

  JA.resolveUploadTarget = function (docType) {
    docType = normalizedDocType(docType);
    var adapter = getAdapter();
    if (adapter && typeof adapter.resolveFileUploadTarget === "function") {
      var target = adapter.resolveFileUploadTarget(docType);
      if (target) return target;
    }
    return findBestGenericInput(docType);
  };

  JA.attachFileToPage = function (fileData, docType) {
    var target = JA.resolveUploadTarget(docType);
    if (!target) throw new Error("No file input found on page");
    return JA.attachFileToElement(target, fileData);
  };
})();

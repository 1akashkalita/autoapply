/**
 * Shared PDF export helpers.
 * Generates PDFs through the background service worker so popup/sidebar/options
 * can all use the same pipeline.
 */

window.JobAutofill = window.JobAutofill || {};

(function () {
  var JA = window.JobAutofill;

  function escapeHtml(text) {
    var div = document.createElement("div");
    div.textContent = String(text || "");
    return div.innerHTML;
  }

  function sendBg(msg) {
    return new Promise(function (resolve) {
      chrome.runtime.sendMessage(msg, function (resp) {
        resolve(resp || { ok: false, error: "No response from background" });
      });
    });
  }

  JA.arrayBufferToBase64 = JA.arrayBufferToBase64 || function (arrayBuffer) {
    var bytes = new Uint8Array(arrayBuffer);
    var binary = "";
    var chunkSize = 0x8000;
    for (var i = 0; i < bytes.length; i += chunkSize) {
      binary += String.fromCharCode.apply(null, bytes.subarray(i, i + chunkSize));
    }
    return btoa(binary);
  };

  JA.downloadBase64File = JA.downloadBase64File || function (base64, filename, mime) {
    var byteChars = atob(base64);
    var byteNumbers = new Array(byteChars.length);
    for (var i = 0; i < byteChars.length; i++) byteNumbers[i] = byteChars.charCodeAt(i);
    var blob = new Blob([new Uint8Array(byteNumbers)], { type: mime || "application/octet-stream" });
    var url = URL.createObjectURL(blob);
    var a = document.createElement("a");
    a.href = url;
    a.download = filename || "download";
    a.click();
    setTimeout(function () { URL.revokeObjectURL(url); }, 2000);
  };

  JA.readFileAsBase64 = JA.readFileAsBase64 || function (file) {
    return new Promise(function (resolve, reject) {
      var reader = new FileReader();
      reader.onerror = function () { reject(new Error("Failed to read file")); };
      reader.onload = function () { resolve(JA.arrayBufferToBase64(reader.result)); };
      reader.readAsArrayBuffer(file);
    });
  };

  JA.renderPdfFromHtml = async function (html, filename, options) {
    var resp = await sendBg({
      action: "renderHtmlToPdf",
      html: String(html || ""),
      filename: filename || "document.pdf",
      pdfOptions: options || null,
    });
    if (!resp || !resp.ok || !resp.doc || !resp.doc.dataBase64) {
      throw new Error(resp && resp.error ? resp.error : "PDF render failed");
    }
    return resp.doc;
  };

  JA.renderCoverLetterPdfDoc = async function (coverLetterText, jobMeta, personal, filename, options) {
    var html;
    if (JA.buildCoverLetterHtml) {
      html = await JA.buildCoverLetterHtml(coverLetterText, jobMeta, personal);
    } else {
      html = "<pre>" + escapeHtml(coverLetterText || "") + "</pre>";
    }
    return await JA.renderPdfFromHtml(html, filename || "cover-letter.pdf", options);
  };

  JA.downloadPdfFromHtml = async function (html, filename, options) {
    var doc = await JA.renderPdfFromHtml(html, filename, options);
    JA.downloadBase64File(doc.dataBase64, doc.name || filename || "document.pdf", doc.mime || "application/pdf");
    return doc;
  };
})();

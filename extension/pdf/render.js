(async function () {
  try {
    var params = new URLSearchParams(window.location.search);
    var renderId = params.get("renderId");
    if (!renderId) return;
    var key = "jaf_pdf_render_" + renderId;
    var result = await chrome.storage.session.get(key);
    var payload = result && result[key];
    if (!payload || !payload.html) return;
    document.open();
    document.write(String(payload.html));
    document.close();
  } catch (e) {
    document.body.textContent = "PDF render failed: " + String(e);
  }
})();

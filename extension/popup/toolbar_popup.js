(function () {
  var errLine = document.getElementById("errLine");

  function showError(msg) {
    errLine.textContent = msg;
    errLine.hidden = !msg;
  }

  document.getElementById("btnOpenPanel").addEventListener("click", function () {
    showError("");
    chrome.tabs.query({ active: true, currentWindow: true }, function (tabs) {
      var tab = tabs && tabs[0];
      if (!tab || tab.id == null) {
        showError("No active tab.");
        return;
      }
      chrome.tabs.sendMessage(tab.id, { action: "openSidebar" }, function () {
        if (chrome.runtime.lastError) {
          showError(
            "Could not open the panel. Try refreshing the page, or open a normal web page (not chrome://)."
          );
          return;
        }
        window.close();
      });
    });
  });

  document.getElementById("btnSettings").addEventListener("click", function () {
    chrome.runtime.openOptionsPage();
    window.close();
  });
})();

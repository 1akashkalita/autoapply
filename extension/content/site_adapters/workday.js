/**
 * Workday ATS adapter.
 * Workday applications typically run on *.myworkdayjobs.com or *.wd5.myworkdayjobs.com.
 *
 * Known quirks:
 * - Heavy React/custom component usage
 * - Fields often render inside shadow DOM or complex nested divs
 * - The form is a multi-step wizard with URL hash changes
 * - Dropdown selects are custom (not native <select>)
 * - Application may be inside an iframe
 * - Labels are often in data-automation-id attributes
 */

window.JobAutofill = window.JobAutofill || {};

(function () {
  var adapter = new window.JobAutofill.BaseAdapter({
    name: "workday",
    urlPatterns: [
      /myworkdayjobs\.com/i,
      /myworkday\.com/i,
      /workday\.com\/.*\/job/i,
    ],
  });

  adapter.extractFields = function () {
    var fields = window.JobAutofill.extractFields();

    // Workday uses data-automation-id for field identification
    for (var i = 0; i < fields.length; i++) {
      var f = fields[i];
      if (f.data_attrs && f.data_attrs["data-automation-id"] && !f.label) {
        // Convert automation-id to a human-readable label
        f.label = f.data_attrs["data-automation-id"]
          .replace(/[-_]/g, " ")
          .replace(/\b\w/g, function (c) { return c.toUpperCase(); });
      }

      if (f.control_kind === "custom_select") {
        f.interaction = f.interaction || { kind: "custom_select" };
        f.interaction.provider = "workday";
        if (!f.interaction.listboxId && f.id) {
          f.interaction.listboxId = f.id + "-listbox";
        }
      }
    }

    return fields;
  };

  /**
   * Workday's custom dropdowns need special handling -- clicking to open,
   * then selecting the option from a listbox.
   * This is a stub for future implementation.
   */
  adapter.beforeFill = function () {
    var dismissors = document.querySelectorAll('[aria-label*="close" i], button[data-automation-id*="close" i]');
    Array.from(dismissors).slice(0, 2).forEach(function (el) {
      try { el.click(); } catch (e) {}
    });
  };

  adapter.resolveFileUploadTarget = function (docType) {
    var selectors = docType === "coverLetter"
      ? [
          'input[type="file"][data-automation-id*="cover" i]',
          'input[type="file"][data-automation-id*="letter" i]',
          'input[type="file"][aria-label*="cover" i]',
        ]
      : [
          'input[type="file"][data-automation-id*="resume" i]',
          'input[type="file"][data-automation-id*="file-upload" i]',
          'input[type="file"][aria-label*="resume" i]',
        ];

    for (var i = 0; i < selectors.length; i++) {
      var match = document.querySelector(selectors[i]);
      if (match) return match;
    }
    return null;
  };

  window.JobAutofill.WorkdayAdapter = adapter;
})();

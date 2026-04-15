/**
 * Lever ATS adapter.
 * Lever job pages typically run on jobs.lever.co.
 *
 * Known quirks:
 * - Application form is at /apply path
 * - Fields use class-based selectors (.application-field)
 * - "Additional information" section has free-text custom questions
 * - Resume upload uses a custom dropzone
 * - Some fields are rendered with React
 */

window.JobAutofill = window.JobAutofill || {};

(function () {
  var adapter = new window.JobAutofill.BaseAdapter({
    name: "lever",
    urlPatterns: [
      /jobs\.lever\.co/i,
      /lever\.co\/.*\/apply/i,
    ],
  });

  adapter.extractFields = function () {
    var fields = window.JobAutofill.extractFields();

    // Lever wraps fields in .application-field divs with a label child
    for (var i = 0; i < fields.length; i++) {
      var f = fields[i];
      if (!f.label) {
        try {
          var el = document.querySelector(f.selector);
          if (el) {
            var appField = el.closest(".application-field");
            if (appField) {
              var label = appField.querySelector("label, .field-label");
              if (label) f.label = label.innerText.trim();
            }
          }
        } catch (e) {
          // ignore
        }
      }
    }

    return fields;
  };

  adapter.resolveFileUploadTarget = function (docType) {
    var selectors = docType === "coverLetter"
      ? [
          '.application-field input[type="file"][name*="cover" i]',
          '.application-field input[type="file"][name*="letter" i]',
          'input[type="file"][id*="cover" i]',
        ]
      : [
          '.application-field input[type="file"][name*="resume" i]',
          '.application-field input[type="file"][name*="cv" i]',
          'input[type="file"][id*="resume" i]',
        ];

    for (var i = 0; i < selectors.length; i++) {
      var match = document.querySelector(selectors[i]);
      if (match) return match;
    }
    return null;
  };

  window.JobAutofill.LeverAdapter = adapter;
})();

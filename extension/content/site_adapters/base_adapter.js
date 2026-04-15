/**
 * Base adapter interface.
 * All site-specific adapters extend this prototype.
 * Override any method to customize behavior for a particular ATS.
 */

window.JobAutofill = window.JobAutofill || {};

window.JobAutofill.BaseAdapter = function (config) {
  this.name = config.name || "base";
  this.urlPatterns = config.urlPatterns || [];
};

window.JobAutofill.BaseAdapter.prototype = {
  /**
   * Test whether this adapter should handle the given URL.
   */
  matches: function (url) {
    for (var i = 0; i < this.urlPatterns.length; i++) {
      if (this.urlPatterns[i].test(url)) return true;
    }
    return false;
  },

  /**
   * Extract form fields from the page.
   * Default: use the shared field_extraction.js logic.
   */
  extractFields: function () {
    return window.JobAutofill.extractFields();
  },

  /**
   * Match fields to profile using the shared rule-based matcher.
   * Override to add site-specific matching logic.
   */
  matchFields: function (fields, profile) {
    return window.JobAutofill.matchFields(fields, profile);
  },

  /**
   * Fill fields using the shared DOM filler.
   * Override to add site-specific fill quirks.
   */
  fillFields: function (mappings) {
    return window.JobAutofill.fillFields(mappings);
  },

  /**
   * Hook called before filling begins.
   * Can be used to dismiss overlays, expand collapsed sections, etc.
   */
  beforeFill: function () {
    // no-op by default
  },

  /**
   * Hook called after filling completes.
   * Can be used to trigger site-specific validation or UI updates.
   */
  afterFill: function () {
    // no-op by default
  },

  /**
   * Resolve the native file input backing a visible upload widget.
   * Return null to fall back to the generic file-upload helper.
   */
  resolveFileUploadTarget: function () {
    return null;
  },
};

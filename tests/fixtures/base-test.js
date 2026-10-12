const { test: base, expect } = require("@playwright/test");
const { captureFailureEvidence } = require("../../scripts/capture-evidence");

/**
 * Custom Playwright test fixture with automatic headless failure evidence capture.
 * When any test fails, it captures live DOM and accessibility snapshots before browser teardown.
 */
const test = base.extend({
    autoEvidenceCapture: [
        async ({ page }, use, testInfo) => {
            await use();
            if (testInfo.status !== testInfo.expectedStatus) {
                await captureFailureEvidence(page, testInfo);
            }
        },
        { auto: true }
    ]
});

module.exports = { test, expect };

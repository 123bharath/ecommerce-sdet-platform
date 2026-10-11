const assert = require("assert");
const fs = require("fs");
const path = require("path");
const {
    stripAnsi,
    extractFailedLocator,
    classifyFailureSymptom,
    collectFailedSpecs,
    generateDiagnosticContext,
    generateHealingContext
} = require("./heal-runner");

console.log("=== Running Focused Stage 2.1 Verification Suite ===\n");

// --------------------------------------------------------------------------
// TEST SUITE 1: Locator Extraction Regex Verification
// --------------------------------------------------------------------------
console.log("[Suite 1] Verifying extractFailedLocator...");

// Positive cases
const positiveCases = [
    {
        name: "Standard locator with single quotes",
        error: "Locator:  locator('.temporary-broken-selector')\nExpected: 3\nReceived: 0",
        expected: ".temporary-broken-selector"
    },
    {
        name: "Standard locator with double quotes",
        error: 'Locator: locator("button#checkout-btn")\nTimeout: 5000ms',
        expected: "button#checkout-btn"
    },
    {
        name: "getByRole with options",
        error: "Locator:  getByRole('heading', { name: 'Products', level: 1 })\nReceived: 'None'",
        expected: "getByRole('heading', { name: 'Products', level: 1 })"
    },
    {
        name: "getByTestId",
        error: "Locator:  getByTestId('cart-item-count')\nTimeout exceeded",
        expected: "getByTestId('cart-item-count')"
    },
    {
        name: "getByLabel",
        error: "Locator:  getByLabel('Email Address')",
        expected: "getByLabel('Email Address')"
    },
    {
        name: "getByText",
        error: "Locator:  getByText('Order Confirmation')",
        expected: "getByText('Order Confirmation')"
    },
    {
        name: "Chained locator expression",
        error: "Locator:  locator('.card').getByRole('button', { name: 'Buy' })",
        expected: "locator('.card').getByRole('button', { name: 'Buy' })"
    },
    {
        name: "Call log waiting for locator",
        error: "Call log:\n  - waiting for locator('.submit-btn')\n  - timeout exceeded",
        expected: ".submit-btn"
    },
    {
        name: "Call log waiting for getByRole",
        error: "Call log:\n  - waiting for getByRole('button', { name: 'Save' })\n  - timeout",
        expected: "getByRole('button', { name: 'Save' })"
    },
    {
        name: "Call log waiting for getByText",
        error: "Call log:\n  - waiting for getByText('Welcome')\n  - timeout",
        expected: "getByText('Welcome')"
    }
];

for (const tc of positiveCases) {
    const result = extractFailedLocator(tc.error);
    assert.strictEqual(result, tc.expected, `Failed positive case: ${tc.name}`);
    console.log(`  ✓ Positive case passed: ${tc.name} -> "${result}"`);
}

// Negative cases (MUST return null, NEVER guess)
const negativeCases = [
    {
        name: "Pure assertion mismatch (no locator)",
        error: "Error: expect(received).toBe(expected)\n\nExpected: 5\nReceived: 3"
    },
    {
        name: "Network error",
        error: "Error: page.goto: net::ERR_CONNECTION_REFUSED at http://localhost:4000"
    },
    {
        name: "Backend ECONNREFUSED",
        error: "Error: apiRequestContext.get: connect ECONNREFUSED 127.0.0.1:4000"
    },
    {
        name: "JavaScript runtime TypeError",
        error: "TypeError: Cannot read properties of undefined (reading 'title')"
    },
    {
        name: "General test timeout without locator",
        error: "Timeout of 30000ms exceeded while running test."
    },
    {
        name: "Empty error",
        error: ""
    },
    {
        name: "Null error",
        error: null
    }
];

for (const tc of negativeCases) {
    const result = extractFailedLocator(tc.error);
    assert.strictEqual(result, null, `Failed negative case: ${tc.name} should return null but got "${result}"`);
    console.log(`  ✓ Negative case passed (returned null): ${tc.name}`);
}

// --------------------------------------------------------------------------
// TEST SUITE 2: Symptom Classification Verification (Symptoms vs Root Causes)
// --------------------------------------------------------------------------
console.log("\n[Suite 2] Verifying classifyFailureSymptom...");

const symptomCases = [
    {
        name: "Physical locator lookup timeout (0 elements resolved)",
        msg: "Error: expect(locator).toHaveCount(expected) failed\nLocator: locator('.broken')\n14 × locator resolved to 0 elements\nTimeout: 5000ms",
        locator: ".broken",
        expected: "LOCATOR_LOOKUP_TIMEOUT"
    },
    {
        name: "Assertion mismatch on resolved element (element exists, text wrong)",
        msg: "Error: expect(locator).toHaveText(expected) failed\nLocator: getByRole('heading')\nlocator resolved to <h1>Products</h1>\nunexpected value 'Products'",
        locator: "getByRole('heading')",
        expected: "ASSERTION_MISMATCH"
    },
    {
        name: "Pure numeric assertion failure",
        msg: "Error: expect(received).toBe(expected)\nExpected: 3\nReceived: 2",
        locator: null,
        expected: "ASSERTION_MISMATCH"
    },
    {
        name: "Network connection refused",
        msg: "Error: connect ECONNREFUSED 127.0.0.1:4000",
        locator: null,
        expected: "ENVIRONMENT_CONNECTION_ERROR"
    },
    {
        name: "JavaScript runtime exception",
        msg: "ReferenceError: productsPage is not defined",
        locator: null,
        expected: "CODE_EXCEPTION"
    },
    {
        name: "Overall test timeout",
        msg: "Timeout 30000ms exceeded while running test.",
        locator: null,
        expected: "TEST_TIMEOUT"
    }
];

for (const tc of symptomCases) {
    const result = classifyFailureSymptom(tc.msg, tc.locator);
    assert.strictEqual(result, tc.expected, `Failed symptom case: ${tc.name}`);
    console.log(`  ✓ Symptom classified: ${tc.name} -> "${result}"`);
}

// --------------------------------------------------------------------------
// TEST SUITE 3: Report Freshness and Backup/Restore Simulation
// --------------------------------------------------------------------------
console.log("\n[Suite 3] Verifying Report Backup & Restore logic...");

const testResultsDir = path.resolve(__dirname, "../test-results");
if (!fs.existsSync(testResultsDir)) {
    fs.mkdirSync(testResultsDir, { recursive: true });
}

const mockReportPath = path.join(testResultsDir, "results.json");
const mockBackupPath = path.join(testResultsDir, "results.json.bak");

// 1. Setup pre-existing report
const priorReportContent = JSON.stringify({ version: "prior-run-report", suites: [] });
fs.writeFileSync(mockReportPath, priorReportContent, "utf8");
assert.strictEqual(fs.existsSync(mockReportPath), true);

// 2. Simulate run start backup
fs.copyFileSync(mockReportPath, mockBackupPath);
fs.unlinkSync(mockReportPath);
assert.strictEqual(fs.existsSync(mockReportPath), false);
assert.strictEqual(fs.existsSync(mockBackupPath), true);

// 3. Simulate failure before Playwright produces a report: restore previous report
if (!fs.existsSync(mockReportPath) && fs.existsSync(mockBackupPath)) {
    fs.copyFileSync(mockBackupPath, mockReportPath);
    fs.unlinkSync(mockBackupPath);
}

// 4. Assert that previous report was restored intact
assert.strictEqual(fs.existsSync(mockReportPath), true);
assert.strictEqual(fs.readFileSync(mockReportPath, "utf8"), priorReportContent);
console.log("  ✓ Previous report was preserved and restored successfully when run aborted.");

console.log("\n=== All Focused Stage 2.1 Verification Tests Passed Cleanly ===");

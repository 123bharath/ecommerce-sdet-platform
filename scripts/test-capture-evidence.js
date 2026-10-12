const assert = require("assert");
const fs = require("fs");
const path = require("path");
const {
    captureFailureEvidence,
    readFailureEvidence
} = require("./capture-evidence");

const TEST_DIR = path.resolve(__dirname, "../test-results/.test-evidence-sandbox");

function setupSandbox() {
    if (!fs.existsSync(TEST_DIR)) {
        fs.mkdirSync(TEST_DIR, { recursive: true });
    }
}

function teardownSandbox() {
    if (fs.existsSync(TEST_DIR)) {
        try {
            fs.rmSync(TEST_DIR, { recursive: true, force: true });
        } catch {
            // Best effort
        }
    }
}

let totalTests = 0;
let passedTests = 0;

async function runTest(title, fn) {
    totalTests++;
    try {
        await fn();
        console.log(`  ✓ ${title}`);
        passedTests++;
    } catch (err) {
        console.error(`  ✗ ${title}`);
        console.error(`    ${err.message}`);
        throw err;
    }
}

async function runAll() {
    console.log("=== Running Headless Failure Evidence Collector (Phase 3B.1) Unit Tests ===\n");
    setupSandbox();

    try {
        console.log("[Suite 1] Null / Closed Page Safety");

        await runTest("captureFailureEvidence safely handles null page", async () => {
            const result = await captureFailureEvidence(null, { title: "null test" });
            assert.strictEqual(result.hasEvidence, false);
            assert.match(result.error, /missing or already closed/);
        });

        await runTest("captureFailureEvidence safely handles closed page", async () => {
            const mockClosedPage = { isClosed: () => true };
            const result = await captureFailureEvidence(mockClosedPage, { title: "closed test" });
            assert.strictEqual(result.hasEvidence, false);
            assert.match(result.error, /missing or already closed/);
        });

        console.log("\n[Suite 2] DOM & Accessibility Extraction");

        await runTest("captureFailureEvidence extracts DOM and ARIA snapshots accurately", async () => {
            const customOut = path.resolve(TEST_DIR, "evidence-1.json");
            const mockPage = {
                isClosed: () => false,
                url: () => "http://localhost:5173/",
                title: async () => "ShopApp",
                content: async () => "<div class=\"product-list-page\"><h1>Products</h1></div>",
                locator: (selector) => ({
                    ariaSnapshot: async () => "- heading \"Products\" [level=1]"
                })
            };

            const mockTestInfo = {
                title: "should display products",
                status: "failed",
                attachCalls: [],
                attach: async (name, opts) => {
                    mockTestInfo.attachCalls.push({ name, opts });
                }
            };

            const result = await captureFailureEvidence(mockPage, mockTestInfo, { outputPath: customOut });

            assert.strictEqual(result.hasEvidence, true);
            assert.strictEqual(result.url, "http://localhost:5173/");
            assert.strictEqual(result.title, "ShopApp");
            assert.strictEqual(result.testTitle, "should display products");
            assert.strictEqual(result.testStatus, "failed");
            assert.strictEqual(result.domSnapshot, "<div class=\"product-list-page\"><h1>Products</h1></div>");
            assert.strictEqual(result.accessibilitySnapshot, "- heading \"Products\" [level=1]");
            assert.strictEqual(fs.existsSync(customOut), true);
            assert.strictEqual(mockTestInfo.attachCalls.length, 1);
            assert.strictEqual(mockTestInfo.attachCalls[0].name, "live-evidence");
        });

        await runTest("captureFailureEvidence falls back to body locator when :root fails", async () => {
            const customOut = path.resolve(TEST_DIR, "evidence-fallback.json");
            const mockPage = {
                isClosed: () => false,
                url: () => "http://localhost:5173/",
                title: async () => "ShopApp",
                content: async () => "<h1>Products</h1>",
                locator: (selector) => {
                    if (selector === ":root") {
                        return {
                            ariaSnapshot: async () => { throw new Error(":root snapshot failed"); }
                        };
                    }
                    if (selector === "body") {
                        return {
                            ariaSnapshot: async () => "- heading \"Products\" [level=1]"
                        };
                    }
                    return {};
                }
            };

            const result = await captureFailureEvidence(mockPage, {}, { outputPath: customOut });
            assert.strictEqual(result.hasEvidence, true);
            assert.strictEqual(result.accessibilitySnapshot, "- heading \"Products\" [level=1]");
        });

        await runTest("captureFailureEvidence handles content() exception gracefully without crashing", async () => {
            const customOut = path.resolve(TEST_DIR, "evidence-err.json");
            const mockPage = {
                isClosed: () => false,
                url: () => "http://localhost:5173/",
                title: async () => "ShopApp",
                content: async () => { throw new Error("Execution context destroyed"); },
                locator: () => ({
                    ariaSnapshot: async () => "- heading \"Products\" [level=1]"
                })
            };

            const result = await captureFailureEvidence(mockPage, {}, { outputPath: customOut });
            assert.strictEqual(result.hasEvidence, true);
            assert.strictEqual(result.domSnapshot, null);
            assert.strictEqual(result.accessibilitySnapshot, "- heading \"Products\" [level=1]");
        });

        console.log("\n[Suite 3] Evidence Reader & Deserialization");

        await runTest("readFailureEvidence returns null for non-existent file", () => {
            const result = readFailureEvidence(path.resolve(TEST_DIR, "non-existent.json"));
            assert.strictEqual(result, null);
        });

        await runTest("readFailureEvidence returns null for malformed JSON file", () => {
            const malformedPath = path.resolve(TEST_DIR, "malformed.json");
            fs.writeFileSync(malformedPath, "{ bad json", "utf8");
            const result = readFailureEvidence(malformedPath);
            assert.strictEqual(result, null);
        });

        await runTest("readFailureEvidence successfully reads valid evidence file", () => {
            const validPath = path.resolve(TEST_DIR, "valid.json");
            const payload = {
                hasEvidence: true,
                domSnapshot: "<h1>Products</h1>",
                accessibilitySnapshot: "heading \"Products\""
            };
            fs.writeFileSync(validPath, JSON.stringify(payload), "utf8");
            const result = readFailureEvidence(validPath);
            assert.strictEqual(result.hasEvidence, true);
            assert.strictEqual(result.domSnapshot, "<h1>Products</h1>");
            assert.strictEqual(result.accessibilitySnapshot, "heading \"Products\"");
        });

        console.log("\n============================================================");
        console.log(`All Headless Evidence Collector Unit Tests Passed! (${passedTests}/${totalTests} tests passed)`);
        console.log("============================================================\n");
    } finally {
        teardownSandbox();
    }
}

runAll().catch((err) => {
    console.error("\n[TEST RUNNER FAILED]:", err);
    process.exit(1);
});

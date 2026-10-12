const assert = require("assert");
const fs = require("fs");
const path = require("path");
const {
    evaluateEligibility,
    isRecursiveRepairBranch,
    writeStepSummary,
    setGithubOutputs,
    OUTPUT_SUMMARY_PATH
} = require("./check-repair-eligibility");

console.log("=== Running AI Repair Eligibility Evaluator (Phase 3A) Unit Tests ===\n");

const TEMP_SANDBOX = path.resolve(__dirname, "../test-results/test-eligibility-sandbox");

function setupSandbox() {
    if (fs.existsSync(TEMP_SANDBOX)) {
        fs.rmSync(TEMP_SANDBOX, { recursive: true, force: true });
    }
    fs.mkdirSync(TEMP_SANDBOX, { recursive: true });
}

function teardownSandbox() {
    if (fs.existsSync(TEMP_SANDBOX)) {
        fs.rmSync(TEMP_SANDBOX, { recursive: true, force: true });
    }
}

let passed = 0;
let total = 0;

function runTest(name, fn) {
    total++;
    try {
        fn();
        console.log(`  ✓ ${name}`);
        passed++;
    } catch (err) {
        console.error(`  ✗ ${name}`);
        console.error(`    ${err.stack || err.message}`);
        throw err;
    }
}

function runAll() {
    setupSandbox();

    try {
        // 1. Recursive Branch Filter Tests
        console.log("[Suite 1] Recursive Branch Filter Checks");

        runTest("Detects ai-repair/ prefixed branch as recursive", () => {
            assert.strictEqual(isRecursiveRepairBranch("ai-repair/fix-heading-locator"), true);
            assert.strictEqual(isRecursiveRepairBranch("refs/heads/ai-repair/fix-heading-locator"), true);
        });

        runTest("Detects repair/ prefixed branch as recursive", () => {
            assert.strictEqual(isRecursiveRepairBranch("repair/test-repair-123"), true);
            assert.strictEqual(isRecursiveRepairBranch("refs/heads/repair/test-repair-123"), true);
        });

        runTest("Allows standard development and feature branches", () => {
            assert.strictEqual(isRecursiveRepairBranch("main"), false);
            assert.strictEqual(isRecursiveRepairBranch("feature/product-crud"), false);
            assert.strictEqual(isRecursiveRepairBranch("bugfix/login-page"), false);
            assert.strictEqual(isRecursiveRepairBranch(""), false);
            assert.strictEqual(isRecursiveRepairBranch(null), false);
        });

        // 2. Missing and Malformed Context Handling
        console.log("\n[Suite 2] Missing & Malformed Context Ingestion");

        runTest("Returns MISSING_CONTEXT when file does not exist", () => {
            const nonExistent = path.resolve(TEMP_SANDBOX, "nonexistent.json");
            const res = evaluateEligibility(nonExistent);
            assert.strictEqual(res.eligible, false);
            assert.strictEqual(res.status, "MISSING_CONTEXT");
        });

        runTest("Returns MALFORMED_JSON when file contains invalid syntax", () => {
            const malformed = path.resolve(TEMP_SANDBOX, "malformed.json");
            fs.writeFileSync(malformed, "{ not valid json ", "utf8");
            const res = evaluateEligibility(malformed);
            assert.strictEqual(res.eligible, false);
            assert.strictEqual(res.status, "MALFORMED_JSON");
        });

        runTest("Returns INVALID_CONTEXT when context schema fails validation", () => {
            const invalid = path.resolve(TEMP_SANDBOX, "invalid.json");
            fs.writeFileSync(invalid, JSON.stringify({ status: "PASSED", timestamp: new Date().toISOString() }), "utf8");
            const res = evaluateEligibility(invalid);
            assert.strictEqual(res.eligible, false);
            assert.strictEqual(res.status, "INVALID_CONTEXT");
        });

        // 3. Pre-Filter Classification & GEMINI.md Ineligibility Gates
        console.log("\n[Suite 3] Ineligibility Classification Gates (GEMINI.md)");

        runTest("Marks orchestration error as INELIGIBLE (ENVIRONMENT_ISSUE)", () => {
            const orch = path.resolve(TEMP_SANDBOX, "orchestration.json");
            fs.writeFileSync(orch, JSON.stringify({
                status: "ERROR",
                timestamp: new Date().toISOString(),
                isOrchestrationError: true,
                errorType: "NPX_LAUNCH_FAILED"
            }), "utf8");
            const res = evaluateEligibility(orch);
            assert.strictEqual(res.eligible, false);
            assert.strictEqual(res.status, "INELIGIBLE");
            assert.strictEqual(res.classification, "ENVIRONMENT_ISSUE");
            assert.match(res.reason, /Orchestration error/);
        });

        runTest("Marks connection loss as INELIGIBLE (ENVIRONMENT_ISSUE)", () => {
            const envError = path.resolve(TEMP_SANDBOX, "env-error.json");
            fs.writeFileSync(envError, JSON.stringify({
                status: "FAILED",
                timestamp: new Date().toISOString(),
                failures: [{
                    testTitle: "Catalog API fetch",
                    errorMessage: "connect ECONNREFUSED 127.0.0.1:4000",
                    observedSymptom: "ENVIRONMENT_CONNECTION_ERROR"
                }]
            }), "utf8");
            const res = evaluateEligibility(envError);
            assert.strictEqual(res.eligible, false);
            assert.strictEqual(res.status, "INELIGIBLE");
            assert.strictEqual(res.classification, "ENVIRONMENT_ISSUE");
            assert.match(res.reason, /connection refused/);
        });

        runTest("Marks uncaught code exception as INELIGIBLE (APPLICATION_DEFECT)", () => {
            const codeError = path.resolve(TEMP_SANDBOX, "code-error.json");
            fs.writeFileSync(codeError, JSON.stringify({
                status: "FAILED",
                timestamp: new Date().toISOString(),
                failures: [{
                    testTitle: "Product catalog render",
                    errorMessage: "TypeError: Cannot read properties of undefined (reading 'map')",
                    observedSymptom: "CODE_EXCEPTION"
                }]
            }), "utf8");
            const res = evaluateEligibility(codeError);
            assert.strictEqual(res.eligible, false);
            assert.strictEqual(res.status, "INELIGIBLE");
            assert.strictEqual(res.classification, "APPLICATION_DEFECT");
            assert.match(res.reason, /Uncaught code exception/);
        });

        runTest("Marks value assertion mismatch as INELIGIBLE (APPLICATION_DEFECT)", () => {
            const assertError = path.resolve(TEMP_SANDBOX, "assert-error.json");
            fs.writeFileSync(assertError, JSON.stringify({
                status: "FAILED",
                timestamp: new Date().toISOString(),
                failures: [{
                    testTitle: "Product count check",
                    errorMessage: "Expected: 10\nReceived: 5",
                    observedSymptom: "ASSERTION_MISMATCH",
                    targetLocator: null
                }]
            }), "utf8");
            const res = evaluateEligibility(assertError);
            assert.strictEqual(res.eligible, false);
            assert.strictEqual(res.status, "INELIGIBLE");
            assert.strictEqual(res.classification, "APPLICATION_DEFECT");
            assert.match(res.reason, /Assertion value mismatch/);
        });

        runTest("Marks API test failures as INELIGIBLE (APPLICATION_DEFECT)", () => {
            const apiError = path.resolve(TEMP_SANDBOX, "api-error.json");
            fs.writeFileSync(apiError, JSON.stringify({
                status: "FAILED",
                timestamp: new Date().toISOString(),
                failures: [{
                    testTitle: "should create a new product",
                    specFile: "api/products/create-product.spec.js",
                    errorMessage: "Error: expect(response.status()).toBe(201)",
                    observedSymptom: "LOCATOR_LOOKUP_TIMEOUT"
                }]
            }), "utf8");
            const res = evaluateEligibility(apiError);
            assert.strictEqual(res.eligible, false);
            assert.strictEqual(res.status, "INELIGIBLE");
            assert.strictEqual(res.classification, "APPLICATION_DEFECT");
            assert.match(res.reason, /API test/);
        });

        // 4. Confirmed Locator Failure Eligibility & Evidence Detection
        console.log("\n[Suite 4] Confirmed Stale Locator Eligibility Gate");

        runTest("Marks confirmed locator lookup timeout as ELIGIBLE with evidence detection", () => {
            const locatorFailure = path.resolve(TEMP_SANDBOX, "locator-failure.json");
            fs.writeFileSync(locatorFailure, JSON.stringify({
                status: "FAILED",
                timestamp: new Date().toISOString(),
                summary: { hasBrowserEvidence: true },
                failures: [{
                    testTitle: "Catalog page displays heading",
                    specFile: "ui/product-list.spec.js",
                    errorMessage: "Timeout 5000ms waiting for locator('.old-heading')",
                    observedSymptom: "LOCATOR_LOOKUP_TIMEOUT",
                    targetLocator: "locator('.old-heading')",
                    domSnapshot: "<h1>Products</h1>"
                }]
            }), "utf8");
            const res = evaluateEligibility(locatorFailure);
            assert.strictEqual(res.eligible, true);
            assert.strictEqual(res.status, "ELIGIBLE");
            assert.strictEqual(res.classification, "STALE_LOCATOR_CANDIDATE");
            assert.strictEqual(res.testTitle, "Catalog page displays heading");
            assert.strictEqual(res.targetLocator, "locator('.old-heading')");
            assert.strictEqual(res.targetFile, "tests/pages/ProductListPage.js");
            assert.strictEqual(res.hasEvidence, true);
        });

        runTest("Marks confirmed locator lookup timeout as ELIGIBLE without evidence when evidence is absent", () => {
            const noEvidenceFailure = path.resolve(TEMP_SANDBOX, "no-evidence.json");
            fs.writeFileSync(noEvidenceFailure, JSON.stringify({
                status: "FAILED",
                timestamp: new Date().toISOString(),
                summary: { hasBrowserEvidence: false },
                failures: [{
                    testTitle: "Catalog page displays heading",
                    specFile: "ui/product-list.spec.js",
                    errorMessage: "Timeout 5000ms waiting for locator('.old-heading')",
                    observedSymptom: "LOCATOR_LOOKUP_TIMEOUT",
                    targetLocator: "locator('.old-heading')"
                }]
            }), "utf8");
            const res = evaluateEligibility(noEvidenceFailure);
            assert.strictEqual(res.eligible, true);
            assert.strictEqual(res.hasEvidence, false);
        });

        // 5. CI Output Reporting (GITHUB_STEP_SUMMARY & GITHUB_OUTPUT)
        console.log("\n[Suite 5] CI Step Summary & Enriched Output Writers");

        runTest("Generates Markdown table in GITHUB_STEP_SUMMARY with evidence status", () => {
            const summaryFile = path.resolve(TEMP_SANDBOX, "step-summary.md");
            process.env.GITHUB_STEP_SUMMARY = summaryFile;

            try {
                writeStepSummary({
                    eligible: true,
                    status: "ELIGIBLE",
                    classification: "STALE_LOCATOR_CANDIDATE",
                    reason: "Locator lookup timeout on POM element.",
                    testTitle: "Catalog heading test",
                    targetLocator: "locator('.heading')",
                    targetFile: "tests/pages/ProductListPage.js",
                    hasEvidence: true
                });

                assert.ok(fs.existsSync(summaryFile));
                const content = fs.readFileSync(summaryFile, "utf8");
                assert.ok(content.includes("ELIGIBLE FOR AI INVESTIGATION"));
                assert.ok(content.includes("STALE_LOCATOR_CANDIDATE"));
                assert.ok(content.includes("Catalog heading test"));
                assert.ok(content.includes("tests/pages/ProductListPage.js"));
                assert.ok(content.includes("Available"));
            } finally {
                delete process.env.GITHUB_STEP_SUMMARY;
            }
        });

        runTest("Sets enriched key-value pairs in GITHUB_OUTPUT", () => {
            const outputFile = path.resolve(TEMP_SANDBOX, "github-output.txt");
            process.env.GITHUB_OUTPUT = outputFile;

            try {
                setGithubOutputs({
                    eligible: true,
                    status: "ELIGIBLE",
                    classification: "STALE_LOCATOR_CANDIDATE",
                    targetFile: "tests/pages/ProductListPage.js",
                    testTitle: "Catalog page displays heading",
                    targetLocator: "locator('.old-heading')",
                    hasEvidence: true,
                    reason: "Locator lookup timeout on POM element."
                });

                assert.ok(fs.existsSync(outputFile));
                const content = fs.readFileSync(outputFile, "utf8");
                assert.ok(content.includes("eligible=true"));
                assert.ok(content.includes("status=ELIGIBLE"));
                assert.ok(content.includes("classification=STALE_LOCATOR_CANDIDATE"));
                assert.ok(content.includes("target_file=tests/pages/ProductListPage.js"));
                assert.ok(content.includes("failing_test=Catalog page displays heading"));
                assert.ok(content.includes("target_locator=locator('.old-heading')"));
                assert.ok(content.includes("has_evidence=true"));
                assert.ok(content.includes("reason=Locator lookup timeout on POM element."));
            } finally {
                delete process.env.GITHUB_OUTPUT;
            }
        });

        console.log(`\n============================================================`);
        console.log(`All Phase 3A & 3B.2 Eligibility Unit Tests Passed! (${passed}/${total} tests passed)`);
        console.log(`============================================================\n`);
    } finally {
        teardownSandbox();
    }
}

runAll();

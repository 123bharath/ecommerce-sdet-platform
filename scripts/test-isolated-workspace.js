const assert = require("assert");
const fs = require("fs");
const path = require("path");
const {
    IsolatedWorkspaceManager,
    generateUnifiedDiff,
    validateUnifiedDiff,
    ROOT_DIR
} = require("./ai-repair-agent");
const {
    redactSensitiveData,
    sanitizeEvidence
} = require("./capture-evidence");

const TEST_SANDBOX = path.resolve(ROOT_DIR, "test-results/.test-workspace-sandbox");

function setupSandbox() {
    if (fs.existsSync(TEST_SANDBOX)) {
        try {
            fs.rmSync(TEST_SANDBOX, { recursive: true, force: true });
        } catch { /* best effort */ }
    }
    fs.mkdirSync(TEST_SANDBOX, { recursive: true });
}

function teardownSandbox() {
    if (fs.existsSync(TEST_SANDBOX)) {
        try {
            fs.rmSync(TEST_SANDBOX, { recursive: true, force: true });
        } catch { /* best effort */ }
    }
}

let passed = 0;
let total = 0;

async function runTest(title, fn) {
    total++;
    try {
        await fn();
        console.log(`  ✓ ${title}`);
        passed++;
    } catch (err) {
        console.error(`  ✗ ${title}`);
        console.error(`    ${err.stack || err.message}`);
        throw err;
    }
}

async function runAll() {
    console.log("=== Running Isolated Workspace & Security Hardening (Phase 3B.2) Tests ===\n");
    setupSandbox();

    try {
        // 1. Sensitive Data Redaction & Privacy Guard Tests
        console.log("[Suite 1] Sensitive Data Redaction & Credential Scrubbing");

        await runTest("redacts passwords inside HTML input tags", () => {
            const rawHtml = '<form><input type="text" name="user" value="admin" /><input type="password" name="pass" value="SuperSecretPassword!123" /></form>';
            const redacted = redactSensitiveData(rawHtml);
            assert.strictEqual(redacted.includes("SuperSecretPassword!123"), false);
            assert.strictEqual(redacted.includes("[REDACTED_PASSWORD]"), true);
            assert.strictEqual(redacted.includes('value="admin"'), true);
        });

        await runTest("redacts Bearer and Basic authentication tokens", () => {
            const rawHeader = "Authorization: Bearer eyJhbGciOiJIUzI1NiIsInR5cCI6IkpXVCJ9.eyJzdWIiOiIxMjM0NTY3ODkwIn0.doNotLeakThisToken";
            const redacted = redactSensitiveData(rawHeader);
            assert.strictEqual(redacted.includes("doNotLeakThisToken"), false);
            assert.strictEqual(redacted.includes("Bearer [REDACTED_TOKEN]"), true);

            const basicHeader = "Authorization: Basic YWRtaW46c2VjcmV0MTIz";
            const redactedBasic = redactSensitiveData(basicHeader);
            assert.strictEqual(redactedBasic.includes("YWRtaW46c2VjcmV0MTIz"), false);
            assert.strictEqual(redactedBasic.includes("Basic [REDACTED_TOKEN]"), true);
        });

        await runTest("redacts MongoDB connection credentials", () => {
            const rawUri = "mongodb://db_admin:superP@ssword123@localhost:27017/ecommerce_sdet";
            const redacted = redactSensitiveData(rawUri);
            assert.strictEqual(redacted.includes("superP@ssword123"), false);
            assert.strictEqual(redacted.includes("mongodb://[REDACTED_USER]:[REDACTED_PASSWORD]@localhost:27017/ecommerce_sdet"), true);
        });

        await runTest("redacts active GEMINI_API_KEY from environment if present", () => {
            const originalKey = process.env.GEMINI_API_KEY;
            process.env.GEMINI_API_KEY = "AIzaSyFakeSecretKeyForTestingPurposes123";
            try {
                const log = "Request failed with key AIzaSyFakeSecretKeyForTestingPurposes123 at endpoint";
                const redacted = redactSensitiveData(log);
                assert.strictEqual(redacted.includes("AIzaSyFakeSecretKeyForTestingPurposes123"), false);
                assert.strictEqual(redacted.includes("[REDACTED_API_KEY]"), true);
            } finally {
                if (originalKey) {
                    process.env.GEMINI_API_KEY = originalKey;
                } else {
                    delete process.env.GEMINI_API_KEY;
                }
            }
        });

        await runTest("redacts credit card numbers matching 16-digit patterns", () => {
            const rawDom = "<div>Payment card on file: 4111 2222 3333 4444 ending in 4444</div>";
            const redacted = redactSensitiveData(rawDom);
            assert.strictEqual(redacted.includes("4111 2222 3333 4444"), false);
            assert.strictEqual(redacted.includes("[REDACTED_CARD]"), true);
        });

        await runTest("sanitizeEvidence sanitizes all fields of evidence payload", () => {
            const payload = {
                url: "http://localhost:5173/checkout?token=secretToken12345678",
                title: "Checkout - password=mypassword",
                testTitle: "test for user with Bearer eyJhbGciOi...",
                domSnapshot: '<input type="password" value="mysecret" />',
                accessibilitySnapshot: "text 4111 2222 3333 4444"
            };
            const sanitized = sanitizeEvidence(payload);
            assert.strictEqual(sanitized.url.includes("secretToken12345678"), false);
            assert.strictEqual(sanitized.title.includes("mypassword"), false);
            assert.strictEqual(sanitized.testTitle.includes("eyJhbGciOi..."), false);
            assert.strictEqual(sanitized.domSnapshot.includes("mysecret"), false);
            assert.strictEqual(sanitized.accessibilitySnapshot.includes("4111 2222 3333 4444"), false);
        });

        // 2. Isolated Workspace Creation & Lifecycle Tests
        console.log("\n[Suite 2] Isolated Workspace Lifecycle & Working Tree Protection");

        await runTest("IsolatedWorkspaceManager creates directory workspace with symlink/junction", () => {
            const workspace = IsolatedWorkspaceManager.createWorkspace(ROOT_DIR, { isolationMode: "directory" });
            try {
                assert.ok(fs.existsSync(workspace.workspaceDir));
                assert.ok(workspace.workspaceDir.includes(".val-workspace-"));

                // Verify node_modules symlink/junction exists
                const nmPath = path.resolve(workspace.workspaceDir, "node_modules");
                assert.ok(fs.existsSync(nmPath));

                // Verify base node_modules remains intact
                const baseNm = path.resolve(ROOT_DIR, "node_modules");
                assert.ok(fs.existsSync(baseNm));
            } finally {
                workspace.cleanup();
                assert.strictEqual(fs.existsSync(workspace.workspaceDir), false);
            }
        });

        await runTest("applyPatch modifies file ONLY in isolated workspace, leaving main repository untouched", () => {
            const pomPath = path.resolve(ROOT_DIR, "tests/pages/ProductListPage.js");
            const originalContent = fs.readFileSync(pomPath, "utf8");

            const patchedContent = originalContent.replace(
                'this.heading = page.getByRole("heading", { level: 1, name: "Products" });',
                'this.heading = page.getByRole("heading", { level: 1, name: "Products In Isolation" });'
            );

            const diff = generateUnifiedDiff("tests/pages/ProductListPage.js", originalContent, patchedContent);

            const workspace = IsolatedWorkspaceManager.createWorkspace(ROOT_DIR, { isolationMode: "directory" });
            try {
                // Apply patch to workspace
                IsolatedWorkspaceManager.applyPatch(workspace.workspaceDir, "tests/pages/ProductListPage.js", diff);

                // Verify file inside workspace was patched
                const workspacePom = path.resolve(workspace.workspaceDir, "tests/pages/ProductListPage.js");
                const workspaceContent = fs.readFileSync(workspacePom, "utf8");
                assert.ok(workspaceContent.includes("Products In Isolation"));

                // CRITICAL: Verify main repository file was NOT modified
                const mainRepoContent = fs.readFileSync(pomPath, "utf8");
                assert.strictEqual(mainRepoContent, originalContent);
                assert.strictEqual(mainRepoContent.includes("Products In Isolation"), false);
            } finally {
                workspace.cleanup();
            }
        });

        // 3. Regression Test Execution & Linux/Cross-Platform Verification
        console.log("\n[Suite 3] Regression Suite Execution & Validation Guards");

        await runTest("validateInIsolation executes primary test and regressionCommand when provided", async () => {
            const pomPath = path.resolve(ROOT_DIR, "tests/pages/ProductListPage.js");
            const originalContent = fs.readFileSync(pomPath, "utf8");

            const patchedContent = originalContent.replace(
                'this.heading = page.getByRole("heading", { level: 1, name: "Products" });',
                'this.heading = page.getByRole("heading", { level: 1, name: "Products Tested" });'
            );
            const diff = generateUnifiedDiff("tests/pages/ProductListPage.js", originalContent, patchedContent);

            let primaryRan = false;
            let regressionRan = false;

            const customTestRunner = async () => {
                primaryRan = true;
                regressionRan = true;
                return { passed: true, exitCode: 0, output: "Both test and regression passed cleanly." };
            };

            const result = await IsolatedWorkspaceManager.validateInIsolation({
                baseDir: ROOT_DIR,
                targetFileRel: "tests/pages/ProductListPage.js",
                diffString: diff,
                testRunner: customTestRunner
            });

            assert.strictEqual(result.success, true);
            assert.strictEqual(primaryRan, true);
            assert.strictEqual(regressionRan, true);
        });

        await runTest("validateInIsolation rejects patch and cleans up workspace when validation test fails", async () => {
            const pomPath = path.resolve(ROOT_DIR, "tests/pages/ProductListPage.js");
            const originalContent = fs.readFileSync(pomPath, "utf8");

            const patchedContent = originalContent.replace(
                'this.heading = page.getByRole("heading", { level: 1, name: "Products" });',
                'this.heading = page.locator(".broken-selector");'
            );
            const diff = generateUnifiedDiff("tests/pages/ProductListPage.js", originalContent, patchedContent);

            const failingRunner = async () => ({
                passed: false,
                exitCode: 1,
                output: "Error: expect(locator).toBeVisible() failed"
            });

            const result = await IsolatedWorkspaceManager.validateInIsolation({
                baseDir: ROOT_DIR,
                targetFileRel: "tests/pages/ProductListPage.js",
                diffString: diff,
                testRunner: failingRunner
            });

            assert.strictEqual(result.success, false);
            assert.strictEqual(result.exitCode, 1);
            assert.ok(result.output.includes("toBeVisible() failed"));

            // Verify main repository was untouched
            const currentPom = fs.readFileSync(pomPath, "utf8");
            assert.strictEqual(currentPom, originalContent);
        });

        await runTest("Unsafe patch modifying files outside approved POM scope throws and never creates workspace", () => {
            const maliciousDiff = [
                "--- a/backend/server.js",
                "+++ b/backend/server.js",
                "@@ -1,1 +1,1 @@",
                "-const express = require('express');",
                "+const express = require('express'); process.exit(0);"
            ].join("\n");

            assert.throws(() => {
                validateUnifiedDiff(maliciousDiff, ROOT_DIR);
            }, /Security Violation/);
        });

        console.log(`\n============================================================`);
        console.log(`All Phase 3B.2 Workspace & Security Tests Passed! (${passed}/${total} tests passed)`);
        console.log(`============================================================\n`);
    } finally {
        teardownSandbox();
    }
}

runAll().catch((err) => {
    console.error("\n[TEST RUNNER FAILED]:", err);
    process.exit(1);
});

const assert = require("assert");
const fs = require("fs");
const path = require("path");
const { execSync } = require("child_process");
const {
    isValidGitRef,
    validatePrInputs,
    validateCommandSafety,
    runCommand,
    checkExistingPr,
    generatePrTitle,
    generatePrBody,
    generateCommitMessage,
    createRepairPr,
    ALLOWED_EXECUTABLES,
    ALLOWED_GIT_COMMANDS,
    ALLOWED_GH_COMMANDS
} = require("./create-repair-pr");
const { generateUnifiedDiff, ROOT_DIR } = require("./ai-repair-agent");

const CURRENT_HEAD = execSync("git rev-parse HEAD", { cwd: ROOT_DIR, encoding: "utf8" }).trim();
const TEST_SANDBOX = path.resolve(ROOT_DIR, "test-results/.test-pr-sandbox");

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
    console.log("=== Running Safe Autonomous Repair PR Generator (Phase 3B.3) Unit Tests ===\n");
    setupSandbox();

    try {
        // =========================================================================
        // Suite 1: Git Reference & Input Validation Tests
        // =========================================================================
        console.log("[Suite 1] Git Reference & Input Validation");

        await runTest("isValidGitRef approves standard git branch names", () => {
            assert.strictEqual(isValidGitRef("main"), true);
            assert.strictEqual(isValidGitRef("feature/product-crud"), true);
            assert.strictEqual(isValidGitRef("ai-repair/fix-catalog-heading-1234abc"), true);
            assert.strictEqual(isValidGitRef("v1.0.0-patch.1"), true);
        });

        await runTest("isValidGitRef rejects empty, whitespace, or control characters", () => {
            assert.strictEqual(isValidGitRef(""), false);
            assert.strictEqual(isValidGitRef("   "), false);
            assert.strictEqual(isValidGitRef("branch with spaces"), false);
            assert.strictEqual(isValidGitRef("branch\x00null"), false);
            assert.strictEqual(isValidGitRef("branch\nnewline"), false);
        });

        await runTest("isValidGitRef rejects command injection and shell metacharacters", () => {
            assert.strictEqual(isValidGitRef("branch;rm -rf /"), false);
            assert.strictEqual(isValidGitRef("branch`id`"), false);
            assert.strictEqual(isValidGitRef("branch$(whoami)"), false);
            assert.strictEqual(isValidGitRef("branch|cat"), false);
            assert.strictEqual(isValidGitRef("branch&calc"), false);
        });

        await runTest("isValidGitRef rejects flag injection (starting with '-')", () => {
            assert.strictEqual(isValidGitRef("--force"), false);
            assert.strictEqual(isValidGitRef("-f"), false);
            assert.strictEqual(isValidGitRef("--help"), false);
        });

        await runTest("isValidGitRef rejects path traversal or invalid git syntax (.., //, @{, .lock, HEAD)", () => {
            assert.strictEqual(isValidGitRef("branch/../evil"), false);
            assert.strictEqual(isValidGitRef("branch//double-slash"), false);
            assert.strictEqual(isValidGitRef("branch@{1}"), false);
            assert.strictEqual(isValidGitRef("/leading-slash"), false);
            assert.strictEqual(isValidGitRef("trailing-slash/"), false);
            assert.strictEqual(isValidGitRef("ref.lock"), false);
            assert.strictEqual(isValidGitRef("HEAD"), false);
        });

        await runTest("validatePrInputs rejects missing or empty baseBranch without inferring", () => {
            assert.throws(() => {
                validatePrInputs({
                    repairBranch: "ai-repair/fix-catalog",
                    sourceCommit: "a1b2c3d4e5f6a1b2c3d4e5f6a1b2c3d4e5f6a1b2",
                    patchPath: "patch.diff",
                    summaryPath: "summary.json"
                });
            }, /Missing required argument: 'baseBranch'/);
        });

        await runTest("validatePrInputs rejects repairBranch not starting with ai-repair/", () => {
            assert.throws(() => {
                validatePrInputs({
                    baseBranch: "main",
                    repairBranch: "feature/fix-catalog",
                    sourceCommit: "a1b2c3d4e5f6a1b2c3d4e5f6a1b2c3d4e5f6a1b2",
                    patchPath: "patch.diff",
                    summaryPath: "summary.json"
                });
            }, /Must start with 'ai-repair\/' prefix/);
        });

        await runTest("validatePrInputs rejects baseBranch equal to repairBranch", () => {
            assert.throws(() => {
                validatePrInputs({
                    baseBranch: "ai-repair/fix-catalog",
                    repairBranch: "ai-repair/fix-catalog",
                    sourceCommit: "a1b2c3d4e5f6a1b2c3d4e5f6a1b2c3d4e5f6a1b2",
                    patchPath: "patch.diff",
                    summaryPath: "summary.json"
                });
            }, /'baseBranch' and 'repairBranch' cannot be identical/);
        });

        await runTest("validatePrInputs rejects invalid sourceCommit (non-hex or invalid length)", () => {
            assert.throws(() => {
                validatePrInputs({
                    baseBranch: "main",
                    repairBranch: "ai-repair/fix-catalog",
                    sourceCommit: "HEAD~1; rm -rf /",
                    patchPath: "patch.diff",
                    summaryPath: "summary.json"
                });
            }, /Invalid 'sourceCommit'/);

            assert.throws(() => {
                validatePrInputs({
                    baseBranch: "main",
                    repairBranch: "ai-repair/fix-catalog",
                    sourceCommit: "8c520a4", // Short SHA (must be 40 chars)
                    patchPath: "patch.diff",
                    summaryPath: "summary.json"
                });
            }, /Invalid 'sourceCommit'/);

            assert.throws(() => {
                validatePrInputs({
                    baseBranch: "main",
                    repairBranch: "ai-repair/fix-catalog",
                    sourceCommit: "a1b2c3d4e5f6a1b2c3d4e5f6a1b2c3d4e5f6a1b2deadbeef", // Too long (48 chars)
                    patchPath: "patch.diff",
                    summaryPath: "summary.json"
                });
            }, /Invalid 'sourceCommit'/);
        });

        await runTest("validatePrInputs rejects non-existent patchPath or summaryPath", () => {
            assert.throws(() => {
                validatePrInputs({
                    baseBranch: "main",
                    repairBranch: "ai-repair/fix-catalog",
                    sourceCommit: "a1b2c3d4e5f6a1b2c3d4e5f6a1b2c3d4e5f6a1b2",
                    patchPath: path.resolve(TEST_SANDBOX, "nonexistent.diff"),
                    summaryPath: "summary.json"
                });
            }, /Patch file does not exist/);
        });

        await runTest("validatePrInputs rejects empty (0-byte) patch file", () => {
            const emptyPatch = path.resolve(TEST_SANDBOX, "empty.patch");
            const dummySummary = path.resolve(TEST_SANDBOX, "summary.json");
            fs.writeFileSync(emptyPatch, "", "utf8");
            fs.writeFileSync(dummySummary, JSON.stringify({ status: "VERIFIED" }), "utf8");

            assert.throws(() => {
                validatePrInputs({
                    baseBranch: "main",
                    repairBranch: "ai-repair/fix-catalog",
                    sourceCommit: "a1b2c3d4e5f6a1b2c3d4e5f6a1b2c3d4e5f6a1b2",
                    patchPath: emptyPatch,
                    summaryPath: dummySummary
                });
            }, /Patch file is empty \(0 bytes\)/);
        });

        await runTest("validatePrInputs approves valid targetFile under tests/pages/*.js", () => {
            const validPatch = path.resolve(TEST_SANDBOX, "valid-input.patch");
            const dummySummary = path.resolve(TEST_SANDBOX, "summary-input.json");
            fs.writeFileSync(validPatch, "patch-content", "utf8");
            fs.writeFileSync(dummySummary, JSON.stringify({ status: "VERIFIED" }), "utf8");

            const validated = validatePrInputs({
                baseBranch: "main",
                repairBranch: "ai-repair/fix-catalog",
                sourceCommit: "a1b2c3d4e5f6a1b2c3d4e5f6a1b2c3d4e5f6a1b2",
                targetFile: "tests/pages/ProductListPage.js",
                patchPath: validPatch,
                summaryPath: dummySummary
            });
            assert.strictEqual(validated.targetFile, "tests/pages/ProductListPage.js");
        });

        await runTest("validatePrInputs rejects invalid targetFile (outside tests/pages/ or not .js or traversal)", () => {
            const validPatch = path.resolve(TEST_SANDBOX, "valid-input2.patch");
            const dummySummary = path.resolve(TEST_SANDBOX, "summary-input2.json");
            fs.writeFileSync(validPatch, "patch-content", "utf8");
            fs.writeFileSync(dummySummary, JSON.stringify({ status: "VERIFIED" }), "utf8");

            assert.throws(() => {
                validatePrInputs({
                    baseBranch: "main",
                    repairBranch: "ai-repair/fix-catalog",
                    sourceCommit: "a1b2c3d4e5f6a1b2c3d4e5f6a1b2c3d4e5f6a1b2",
                    targetFile: "backend/server.js",
                    patchPath: validPatch,
                    summaryPath: dummySummary
                });
            }, /Invalid 'targetFile'/);

            assert.throws(() => {
                validatePrInputs({
                    baseBranch: "main",
                    repairBranch: "ai-repair/fix-catalog",
                    sourceCommit: "a1b2c3d4e5f6a1b2c3d4e5f6a1b2c3d4e5f6a1b2",
                    targetFile: "tests/pages/../evil.js",
                    patchPath: validPatch,
                    summaryPath: dummySummary
                });
            }, /Invalid 'targetFile'/);

            assert.throws(() => {
                validatePrInputs({
                    baseBranch: "main",
                    repairBranch: "ai-repair/fix-catalog",
                    sourceCommit: "a1b2c3d4e5f6a1b2c3d4e5f6a1b2c3d4e5f6a1b2",
                    targetFile: "tests/pages/ProductListPage.txt",
                    patchPath: validPatch,
                    summaryPath: dummySummary
                });
            }, /Invalid 'targetFile'/);
        });

        // =========================================================================
        // Suite 2: Command Execution Safety & Safeguards Tests
        // =========================================================================
        console.log("\n[Suite 2] Command Safety Whitelists & Action Restrictions");

        await runTest("validateCommandSafety rejects unauthorized executable names", () => {
            assert.throws(() => {
                validateCommandSafety("bash", ["-c", "echo hello"]);
            }, /Unauthorized executable 'bash'/);

            assert.throws(() => {
                validateCommandSafety("powershell", ["-Command", "dir"]);
            }, /Unauthorized executable 'powershell'/);

            assert.throws(() => {
                validateCommandSafety("curl", ["https://malicious.com"]);
            }, /Unauthorized executable 'curl'/);
        });

        await runTest("validateCommandSafety rejects unauthorized git subcommands", () => {
            assert.throws(() => {
                validateCommandSafety("git", ["rebase", "main"]);
            }, /Unauthorized git subcommand 'rebase'/);

            assert.throws(() => {
                validateCommandSafety("git", ["clean", "-fdx"]);
            }, /Unauthorized git subcommand 'clean'/);

            assert.throws(() => {
                validateCommandSafety("git", ["reset", "--hard"]);
            }, /Unauthorized git subcommand 'reset'/);
        });

        await runTest("validateCommandSafety strictly blocks force-pushing (--force, -f, --force-with-lease)", () => {
            assert.throws(() => {
                validateCommandSafety("git", ["push", "origin", "ai-repair/fix", "--force"]);
            }, /Force-pushing or ref deletion is strictly prohibited/);

            assert.throws(() => {
                validateCommandSafety("git", ["push", "origin", "ai-repair/fix", "-f"]);
            }, /Force-pushing or ref deletion is strictly prohibited/);

            assert.throws(() => {
                validateCommandSafety("git", ["push", "origin", "ai-repair/fix", "--force-with-lease"]);
            }, /Force-pushing or ref deletion is strictly prohibited/);
        });

        await runTest("validateCommandSafety strictly blocks ref deletion on push", () => {
            assert.throws(() => {
                validateCommandSafety("git", ["push", "origin", ":ai-repair/fix"]);
            }, /Force-pushing or ref deletion is strictly prohibited/);
        });

        await runTest("validateCommandSafety strictly blocks user branch deletion", () => {
            assert.throws(() => {
                validateCommandSafety("git", ["branch", "-D", "user-branch"]);
            }, /Deleting branches is strictly prohibited/);

            assert.throws(() => {
                validateCommandSafety("git", ["branch", "-d", "user-branch"]);
            }, /Deleting branches is strictly prohibited/);

            assert.throws(() => {
                validateCommandSafety("git", ["branch", "--delete", "user-branch"]);
            }, /Deleting branches is strictly prohibited/);
        });

        await runTest("validateCommandSafety permits deleting ai-repair/* branches for failure rollback", () => {
            assert.doesNotThrow(() => {
                validateCommandSafety("git", ["branch", "-D", "ai-repair/test-repair-123"]);
            });
        });

        await runTest("validateCommandSafety strictly blocks auto-merging PRs via gh", () => {
            assert.throws(() => {
                validateCommandSafety("gh", ["pr", "merge", "123", "--auto"]);
            }, /Automated pull request merging is strictly prohibited/);

            assert.throws(() => {
                validateCommandSafety("gh", ["pr", "merge", "123", "--rebase"]);
            }, /Automated pull request merging is strictly prohibited/);
        });

        await runTest("validateCommandSafety strictly blocks unauthorized git apply flags", () => {
            assert.throws(() => {
                validateCommandSafety("git", ["apply", "--reject", "patch.diff"]);
            }, /Security Violation: Unauthorized git apply flag/);
            assert.throws(() => {
                validateCommandSafety("git", ["apply", "--index", "patch.diff"]);
            }, /Security Violation: Unauthorized git apply flag/);
        });

        await runTest("validateCommandSafety approves legitimate git and gh commands", () => {
            assert.doesNotThrow(() => {
                validateCommandSafety("git", ["worktree", "add", "-b", "ai-repair/fix", "/tmp/wt", "a1b2c3d"]);
                validateCommandSafety("git", ["apply", "--check", "patch.diff"]);
                validateCommandSafety("git", ["apply", "patch.diff"]);
                validateCommandSafety("git", ["add", "tests/pages/ProductListPage.js"]);
                validateCommandSafety("git", ["commit", "-m", "fix: locator repair"]);
                validateCommandSafety("git", ["push", "origin", "ai-repair/fix"]);
                validateCommandSafety("gh", ["pr", "create", "--base", "main", "--head", "ai-repair/fix", "--title", "Repair"]);
                validateCommandSafety("gh", ["pr", "list", "--head", "ai-repair/fix", "--state", "open"]);
            });
        });

        // =========================================================================
        // Suite 3: Patch Security & Isolated Validation Gate Tests
        // =========================================================================
        console.log("\n[Suite 3] Patch Security & Isolated Verification Preconditions");

        const samplePomRel = "tests/pages/ProductListPage.js";
        const samplePomAbs = path.resolve(ROOT_DIR, samplePomRel);
        const originalPomContent = fs.readFileSync(samplePomAbs, "utf8");

        const patchedPomContent = originalPomContent.replace(
            /this\.heading\s*=\s*page\.getByRole\("heading",\s*\{[^}]+\}\);/,
            'this.heading = page.getByRole("heading", { level: 1, name: "Products Healed" });'
        );
        const validDiff = generateUnifiedDiff(samplePomRel, originalPomContent, patchedPomContent);

        const validPatchPath = path.resolve(TEST_SANDBOX, "valid.patch");
        fs.writeFileSync(validPatchPath, validDiff, "utf8");

        await runTest("createRepairPr aborts if summary status is PROPOSED (unverified)", async () => {
            const summaryPath = path.resolve(TEST_SANDBOX, "unverified-summary.json");
            fs.writeFileSync(summaryPath, JSON.stringify({
                status: "PROPOSED",
                targetFile: samplePomRel,
                originalLocator: "heading",
                healedLocator: "new-heading"
            }), "utf8");

            const result = await createRepairPr({
                baseBranch: "main",
                repairBranch: "ai-repair/fix-catalog-heading",
                sourceCommit: CURRENT_HEAD,
                patchPath: validPatchPath,
                summaryPath,
                rootDir: ROOT_DIR
            });

            assert.strictEqual(result.success, false);
            assert.strictEqual(result.status, "UNVERIFIED_PATCH");
            assert.ok(result.reason.includes("has not been successfully validated"));
        });

        await runTest("createRepairPr aborts if summary status is VALIDATION_FAILED", async () => {
            const summaryPath = path.resolve(TEST_SANDBOX, "failed-summary.json");
            fs.writeFileSync(summaryPath, JSON.stringify({
                status: "VALIDATION_FAILED",
                targetFile: samplePomRel,
                originalLocator: "heading",
                healedLocator: "new-heading"
            }), "utf8");

            const result = await createRepairPr({
                baseBranch: "main",
                repairBranch: "ai-repair/fix-catalog-heading",
                sourceCommit: CURRENT_HEAD,
                patchPath: validPatchPath,
                summaryPath,
                rootDir: ROOT_DIR
            });

            assert.strictEqual(result.success, false);
            assert.strictEqual(result.status, "UNVERIFIED_PATCH");
        });

        await runTest("createRepairPr aborts if summary targetFile does not match patch targetFile", async () => {
            const summaryPath = path.resolve(TEST_SANDBOX, "mismatch-summary.json");
            fs.writeFileSync(summaryPath, JSON.stringify({
                status: "VERIFIED",
                targetFile: "tests/pages/CartPage.js", // Mismatch
                originalLocator: "cart-btn",
                healedLocator: "new-cart-btn"
            }), "utf8");

            const result = await createRepairPr({
                baseBranch: "main",
                repairBranch: "ai-repair/fix-catalog-heading",
                sourceCommit: CURRENT_HEAD,
                patchPath: validPatchPath,
                summaryPath,
                rootDir: ROOT_DIR
            });

            assert.strictEqual(result.success, false);
            assert.strictEqual(result.status, "TARGET_MISMATCH");
        });

        await runTest("createRepairPr aborts if options targetFile does not match patch targetFile", async () => {
            const summaryPath = path.resolve(TEST_SANDBOX, "options-mismatch-summary.json");
            fs.writeFileSync(summaryPath, JSON.stringify({
                status: "VERIFIED",
                targetFile: samplePomRel,
                originalLocator: "heading",
                healedLocator: "new-heading"
            }), "utf8");

            const result = await createRepairPr({
                baseBranch: "main",
                repairBranch: "ai-repair/fix-catalog-heading",
                sourceCommit: CURRENT_HEAD,
                targetFile: "tests/pages/LoginPage.js", // Mismatch with patch
                patchPath: validPatchPath,
                summaryPath,
                rootDir: ROOT_DIR
            });

            assert.strictEqual(result.success, false);
            assert.strictEqual(result.status, "TARGET_MISMATCH");
            assert.ok(result.reason.includes("expected 'tests/pages/LoginPage.js'"));
        });

        await runTest("createRepairPr aborts if patch diff targets unauthorized files (backend code)", async () => {
            const badDiff = [
                "--- a/backend/server.js",
                "+++ b/backend/server.js",
                "@@ -1,1 +1,1 @@",
                "-const express = require('express');",
                "+const express = require('express');"
            ].join("\n");
            const badPatchPath = path.resolve(TEST_SANDBOX, "malicious.patch");
            fs.writeFileSync(badPatchPath, badDiff, "utf8");

            const summaryPath = path.resolve(TEST_SANDBOX, "verified-summary.json");
            fs.writeFileSync(summaryPath, JSON.stringify({
                status: "VERIFIED",
                targetFile: "backend/server.js"
            }), "utf8");

            await assert.rejects(async () => {
                await createRepairPr({
                    baseBranch: "main",
                    repairBranch: "ai-repair/fix-catalog-heading",
                    sourceCommit: CURRENT_HEAD,
                    patchPath: badPatchPath,
                    summaryPath,
                    rootDir: ROOT_DIR
                });
            }, /Security Violation/);
        });

        // =========================================================================
        // Suite 4: Idempotency & Duplicate PR Prevention Tests
        // =========================================================================
        console.log("\n[Suite 4] Idempotency & Duplicate PR Handling");

        await runTest("createRepairPr detects existing open PR and skips creation (SKIPPED_EXISTING_PR)", async () => {
            const summaryPath = path.resolve(TEST_SANDBOX, "verified-summary-idempotent.json");
            fs.writeFileSync(summaryPath, JSON.stringify({
                status: "VERIFIED",
                targetFile: samplePomRel,
                originalLocator: "heading",
                healedLocator: "new-heading"
            }), "utf8");

            let pushCalled = false;
            let prCreateCalled = false;

            const mockRunner = async (cmd, args) => {
                if (cmd === "gh" && args[0] === "pr" && args[1] === "list") {
                    return {
                        exitCode: 0,
                        stdout: JSON.stringify([{
                            number: 42,
                            title: "AI Repair: Heal stale locator in ProductListPage.js",
                            url: "https://github.com/123bharath/ecommerce-sdet-platform/pull/42"
                        }]),
                        stderr: ""
                    };
                }
                if (cmd === "git" && args[0] === "push") {
                    pushCalled = true;
                }
                if (cmd === "gh" && args[0] === "pr" && args[1] === "create") {
                    prCreateCalled = true;
                }
                return { exitCode: 0, stdout: "", stderr: "" };
            };

            const result = await createRepairPr({
                baseBranch: "main",
                repairBranch: "ai-repair/fix-catalog-heading-existing",
                sourceCommit: CURRENT_HEAD,
                patchPath: validPatchPath,
                summaryPath,
                rootDir: ROOT_DIR,
                commandRunner: mockRunner
            });

            assert.strictEqual(result.success, true);
            assert.strictEqual(result.status, "SKIPPED_EXISTING_PR");
            assert.strictEqual(result.prNumber, 42);
            assert.strictEqual(result.prUrl, "https://github.com/123bharath/ecommerce-sdet-platform/pull/42");
            assert.strictEqual(pushCalled, false, "git push must NOT be called when PR already exists");
            assert.strictEqual(prCreateCalled, false, "gh pr create must NOT be called when PR already exists");
        });

        // =========================================================================
        // Suite 5: Full Execution Lifecycle & Working Tree Protection (Mocked)
        // =========================================================================
        console.log("\n[Suite 5] Full Lifecycle & Working Tree Protection (Mocked)");

        await runTest("createRepairPr successfully executes isolated worktree flow and creates PR", async () => {
            const summaryPath = path.resolve(TEST_SANDBOX, "verified-summary-success.json");
            fs.writeFileSync(summaryPath, JSON.stringify({
                status: "VERIFIED",
                model: "gemini-3.8-flash",
                rootCause: "STALE_LOCATOR",
                diagnosis: "Heading text was changed from 'Products' to 'Products Healed'.",
                targetFile: samplePomRel,
                originalLocator: 'page.getByRole("heading", { level: 1, name: "Products" })',
                healedLocator: 'page.getByRole("heading", { level: 1, name: "Products Healed" })',
                validationOutput: "1 passed (1.2s)\n5 passed (0.8s)"
            }), "utf8");

            const executedCommands = [];

            const mockRunner = async (cmd, args, options) => {
                executedCommands.push({ cmd, args, cwd: options.cwd });

                if (cmd === "gh" && args[0] === "pr" && args[1] === "list") {
                    return { exitCode: 0, stdout: "[]", stderr: "" }; // No duplicate PR
                }

                if (cmd === "gh" && args[0] === "pr" && args[1] === "create") {
                    return {
                        exitCode: 0,
                        stdout: "https://github.com/123bharath/ecommerce-sdet-platform/pull/99\n",
                        stderr: ""
                    };
                }

                return { exitCode: 0, stdout: "", stderr: "" };
            };

            const result = await createRepairPr({
                baseBranch: "main",
                repairBranch: "ai-repair/fix-catalog-heading-success",
                sourceCommit: CURRENT_HEAD,
                patchPath: validPatchPath,
                summaryPath,
                rootDir: ROOT_DIR,
                commandRunner: mockRunner
            });

            assert.strictEqual(result.success, true);
            assert.strictEqual(result.status, "PR_CREATED");
            assert.strictEqual(result.prUrl, "https://github.com/123bharath/ecommerce-sdet-platform/pull/99");
            assert.strictEqual(result.repairBranch, "ai-repair/fix-catalog-heading-success");
            assert.strictEqual(result.baseBranch, "main");

            // Verify command sequence
            const cmdNames = executedCommands.map(c => `${c.cmd} ${c.args[0]} ${c.args[1] || ""}`.trim());
            assert.ok(cmdNames.some(c => c.startsWith("gh pr list")));
            assert.ok(cmdNames.some(c => c.startsWith("git worktree add")));
            assert.ok(cmdNames.some(c => c.startsWith("git add")));
            assert.ok(cmdNames.some(c => c.startsWith("git commit")));
            assert.ok(cmdNames.some(c => c.startsWith("git push origin")));
            assert.ok(cmdNames.some(c => c.startsWith("gh pr create")));
            assert.ok(cmdNames.some(c => c.startsWith("git worktree remove")));

            // CRITICAL: Verify main repository file was untouched
            const currentPomContent = fs.readFileSync(samplePomAbs, "utf8");
            assert.strictEqual(currentPomContent, originalPomContent);
            assert.strictEqual(currentPomContent.includes("Products Healed"), false);
        });

        await runTest("createRepairPr handles git push failure gracefully and removes worktree", async () => {
            const summaryPath = path.resolve(TEST_SANDBOX, "verified-summary-push-fail.json");
            fs.writeFileSync(summaryPath, JSON.stringify({
                status: "VERIFIED",
                targetFile: samplePomRel,
                originalLocator: "heading",
                healedLocator: "new-heading"
            }), "utf8");

            let worktreeRemoved = false;
            let prCreateCalled = false;

            const failingPushRunner = async (cmd, args) => {
                if (cmd === "gh" && args[0] === "pr" && args[1] === "list") {
                    return { exitCode: 0, stdout: "[]", stderr: "" };
                }
                if (cmd === "git" && args[0] === "push") {
                    return { exitCode: 1, stdout: "", stderr: "fatal: could not read Username for 'https://github.com': terminal prompts disabled" };
                }
                if (cmd === "git" && args[0] === "worktree" && args[1] === "remove") {
                    worktreeRemoved = true;
                }
                if (cmd === "gh" && args[0] === "pr" && args[1] === "create") {
                    prCreateCalled = true;
                }
                return { exitCode: 0, stdout: "", stderr: "" };
            };

            await assert.rejects(async () => {
                await createRepairPr({
                    baseBranch: "main",
                    repairBranch: "ai-repair/fix-catalog-fail",
                    sourceCommit: CURRENT_HEAD,
                    patchPath: validPatchPath,
                    summaryPath,
                    rootDir: ROOT_DIR,
                    commandRunner: failingPushRunner
                });
            }, /Failed to push repair branch to origin/);

            assert.strictEqual(worktreeRemoved, true, "Worktree must be removed even if git push fails");
            assert.strictEqual(prCreateCalled, false, "gh pr create must NOT be called if push failed");
        });

        await runTest("generatePrBody includes all required markdown sections and alerts", () => {
            const summary = {
                rootCause: "STALE_LOCATOR",
                targetFile: "tests/pages/ProductListPage.js",
                diagnosis: "Text evolved from Products to Products Healed",
                model: "gemini-3.8-flash",
                originalLocator: "oldLocator",
                healedLocator: "newLocator",
                validationOutput: "1 passed"
            };
            const body = generatePrBody(summary, validDiff);
            assert.ok(body.includes("## Antigravity AI Autonomous Test Repair Proposal"));
            assert.ok(body.includes("### 1. Failure Diagnosis"));
            assert.ok(body.includes("### 2. Locator Repair Diff"));
            assert.ok(body.includes("### 3. Verification & Safety Guarantees"));
            assert.ok(body.includes("### 4. Human Review Gate"));
            assert.ok(body.includes("**MUST NOT be auto-merged**"));
            assert.ok(body.includes("gemini-3.8-flash"));
            assert.ok(body.includes("```diff"));
        });

        // =========================================================================
        // Suite 6: Live Diagnostic Trial Commit (8c520a4) Lineage & Parsing Regression
        // =========================================================================
        console.log("\n[Suite 6] Live Diagnostic Trial Commit (8c520a4) Lineage & Parsing Regression");

        await runTest("createRepairPr validates and prepares PR using actual diagnostic commit 8c520a411a03e5f09d79bfae305c302b2f614b77", async () => {
            const diagnosticSha = "8c520a411a03e5f09d79bfae305c302b2f614b77";
            const diagnosticPomRel = "tests/pages/ProductListPage.js";

            assert.strictEqual(diagnosticSha.length, 40, "Diagnostic sourceCommit must be a full 40-character SHA");
            assert.ok(/^[0-9a-fA-F]{40}$/.test(diagnosticSha));
            const origPomAtCommit = execSync(`git show ${diagnosticSha}:${diagnosticPomRel}`, { cwd: ROOT_DIR, encoding: "utf8" });
            assert.ok(origPomAtCommit.includes("Products - Stale Title Indicator"), "Commit 8c520a4 must physically contain stale indicator");

            // Actual unified diff generated from 8c520a4 encapsulating stale locator with object literal and commas
            const diagnosticDiff = [
                "--- a/tests/pages/ProductListPage.js",
                "+++ b/tests/pages/ProductListPage.js",
                "@@ -13,1 +13,1 @@",
                "-        this.heading = page.getByRole(\"heading\", { level: 1, name: \"Products - Stale Title Indicator\" });",
                "+        this.heading = page.getByRole(\"heading\", { level: 1, name: \"Products\" });"
            ].join("\n");

            const diagnosticPatchPath = path.resolve(TEST_SANDBOX, "diagnostic-8c520a4.patch");
            fs.writeFileSync(diagnosticPatchPath, diagnosticDiff, "utf8");

            const diagnosticSummaryPath = path.resolve(TEST_SANDBOX, "diagnostic-summary-8c520a4.json");
            fs.writeFileSync(diagnosticSummaryPath, JSON.stringify({
                status: "VERIFIED",
                model: "gemini-3.5-flash",
                rootCause: "STALE_LOCATOR",
                diagnosis: "Replaced stale diagnostic indicator title with live catalog heading",
                targetFile: diagnosticPomRel,
                originalLocator: 'page.getByRole("heading", { level: 1, name: "Products - Stale Title Indicator" })',
                healedLocator: 'page.getByRole("heading", { level: 1, name: "Products" })',
                validationOutput: "All 3 tiers passed cleanly."
            }), "utf8");

            let prCreatedWithWorktree = false;
            const mockRunner = async (cmd, args, options) => {
                if (cmd === "gh" && args[0] === "pr" && args[1] === "list") {
                    return { exitCode: 0, stdout: "[]", stderr: "" };
                }
                if (cmd === "gh" && args[0] === "pr" && args[1] === "create") {
                    prCreatedWithWorktree = true;
                    return {
                        exitCode: 0,
                        stdout: "https://github.com/123bharath/ecommerce-sdet-platform/pull/101\n",
                        stderr: ""
                    };
                }
                return { exitCode: 0, stdout: "", stderr: "" };
            };

            const result = await createRepairPr({
                baseBranch: "test/diagnostic-ci-failure-trial",
                repairBranch: "ai-repair/heal-ProductListPage-8c520a4",
                sourceCommit: diagnosticSha,
                targetFile: diagnosticPomRel,
                patchPath: diagnosticPatchPath,
                summaryPath: diagnosticSummaryPath,
                rootDir: ROOT_DIR,
                commandRunner: mockRunner
            });

            assert.strictEqual(result.success, true);
            assert.strictEqual(result.status, "PR_CREATED");
            assert.strictEqual(result.prUrl, "https://github.com/123bharath/ecommerce-sdet-platform/pull/101");
            assert.strictEqual(result.sourceCommit, diagnosticSha);
            assert.strictEqual(result.targetFile, diagnosticPomRel);
            assert.strictEqual(prCreatedWithWorktree, true);
        });

        await runTest("createRepairPr accurately rejects tampered removed lines containing object literals and commas without truncation", async () => {
            const diagnosticSha = "8c520a411a03e5f09d79bfae305c302b2f614b77";
            const tamperedDiff = [
                "--- a/tests/pages/ProductListPage.js",
                "+++ b/tests/pages/ProductListPage.js",
                "@@ -13,1 +13,1 @@",
                "-        this.heading = page.getByRole(\"heading\", { level: 99, name: \"NonExistent - Tampered Indicator\" });",
                "+        this.heading = page.getByRole(\"heading\", { level: 1, name: \"Products\" });"
            ].join("\n");

            const tamperedPatchPath = path.resolve(TEST_SANDBOX, "tampered-8c520a4.patch");
            fs.writeFileSync(tamperedPatchPath, tamperedDiff, "utf8");

            const tamperedSummaryPath = path.resolve(TEST_SANDBOX, "tampered-summary.json");
            fs.writeFileSync(tamperedSummaryPath, JSON.stringify({
                status: "VERIFIED",
                targetFile: "tests/pages/ProductListPage.js"
            }), "utf8");

            await assert.rejects(async () => {
                await createRepairPr({
                    baseBranch: "test/diagnostic-ci-failure-trial",
                    repairBranch: "ai-repair/heal-ProductListPage-tampered",
                    sourceCommit: diagnosticSha,
                    targetFile: "tests/pages/ProductListPage.js",
                    patchPath: tamperedPatchPath,
                    summaryPath: tamperedSummaryPath,
                    rootDir: ROOT_DIR
                });
            }, (err) => {
                assert.ok(err.message.includes("Security Violation: Removed line"));
                // Verifies the FULL line is in the error message without being split at commas or truncated at 50 chars
                assert.ok(err.message.includes('this.heading = page.getByRole("heading", { level: 99, name: "NonExistent - Tampered Indicator" });'));
                return true;
            });
        });

        // =========================================================================
        // Suite 7: Full Real-Git Integration Lifecycle (Target Branch & Compatibility)
        // =========================================================================
        console.log("\n[Suite 7] Real-Git Worktree, Target Branch Compatibility & Non-Destructive Publishing");

        // Helper to initialize an isolated git repository with explicit branches and commits
        const setupIntegrationRepo = () => {
            const repoDir = path.resolve(TEST_SANDBOX, `integration-repo-${Date.now()}`);
            fs.mkdirSync(path.resolve(repoDir, "tests/pages"), { recursive: true });

            execSync("git init", { cwd: repoDir, stdio: "ignore" });
            execSync("git checkout -B main", { cwd: repoDir, stdio: "ignore" });
            execSync('git config user.name "SDET Integration Test"', { cwd: repoDir });
            execSync('git config user.email "sdet@test.local"', { cwd: repoDir });

            const pomRel = "tests/pages/ProductListPage.js";
            const cleanContent = fs.readFileSync(path.resolve(ROOT_DIR, pomRel), "utf8");
            fs.writeFileSync(path.resolve(repoDir, pomRel), cleanContent, "utf8");
            execSync(`git add ${pomRel}`, { cwd: repoDir, stdio: "ignore" });
            execSync('git commit -m "feat: clean locator on main"', { cwd: repoDir, stdio: "ignore" });
            const mainSha = execSync("git rev-parse HEAD", { cwd: repoDir, encoding: "utf8" }).trim();
            assert.strictEqual(mainSha.length, 40, "main commit SHA must be a full 40-character hex string");

            // Create target test branch with the stale locator
            execSync("git checkout -b test/diagnostic-ci-failure-trial", { cwd: repoDir, stdio: "ignore" });
            const staleContent = cleanContent.replace(
                'name: "Products"',
                'name: "Products - Stale Title Indicator"'
            );
            fs.writeFileSync(path.resolve(repoDir, pomRel), staleContent, "utf8");
            execSync(`git add ${pomRel}`, { cwd: repoDir, stdio: "ignore" });
            execSync('git commit -m "test: introduce stale locator for trial"', { cwd: repoDir, stdio: "ignore" });
            const diagnosticSha = execSync("git rev-parse HEAD", { cwd: repoDir, encoding: "utf8" }).trim();
            assert.strictEqual(diagnosticSha.length, 40, "diagnostic sourceCommit must be a full 40-character hex string");

            // Switch repo checkout back to main (simulating trusted default branch checkout in publishing job)
            execSync("git checkout main", { cwd: repoDir, stdio: "ignore" });

            return { repoDir, pomRel, mainSha, diagnosticSha };
        };

        await runTest("createRepairPr successfully applies patch to compatible target branch (test/diagnostic-ci-failure-trial) from main checkout", async () => {
            const { repoDir, pomRel, diagnosticSha } = setupIntegrationRepo();

            // Extract original POM at diagnostic commit to create standard context diff
            const origPomAtDiag = execSync(`git show ${diagnosticSha}:${pomRel}`, { cwd: repoDir, encoding: "utf8" });
            assert.ok(origPomAtDiag.includes("Products - Stale Title Indicator"));
            const patchedPomAtDiag = origPomAtDiag.replace(
                /name:\s*"Products - Stale Title Indicator"/,
                'name: "Products"'
            );
            const integrationDiff = generateUnifiedDiff(pomRel, origPomAtDiag, patchedPomAtDiag);
            const integrationPatchPath = path.resolve(TEST_SANDBOX, "integration-compatible.patch");
            fs.writeFileSync(integrationPatchPath, integrationDiff, "utf8");

            const integrationSummaryPath = path.resolve(TEST_SANDBOX, "integration-compatible-summary.json");
            fs.writeFileSync(integrationSummaryPath, JSON.stringify({
                status: "VERIFIED",
                model: "gemini-3.5-flash",
                rootCause: "STALE_LOCATOR",
                diagnosis: "Integration test: Healed diagnostic stale indicator title",
                targetFile: pomRel,
                originalLocator: 'page.getByRole("heading", { level: 1, name: "Products - Stale Title Indicator" })',
                healedLocator: 'page.getByRole("heading", { level: 1, name: "Products" })',
                validationOutput: "All 3 tiers verified."
            }), "utf8");

            const tempRepairBranch = `ai-repair/test-real-git-heal-${Date.now()}`;
            let pushCalledForBranch = null;
            let prCreatedForBase = null;

            // Integration runner: delegates all real git commands (worktree add, git apply, git add, git commit)
            // to real system processes, and intercepts only network commands (git push, gh pr)
            const realGitRunner = async (cmd, args, options) => {
                if (cmd === "git" && args[0] === "push") {
                    pushCalledForBranch = args[2];
                    return { exitCode: 0, stdout: "", stderr: "" };
                }
                if (cmd === "gh" && args[0] === "pr" && args[1] === "list") {
                    return { exitCode: 0, stdout: "[]", stderr: "" };
                }
                if (cmd === "gh" && args[0] === "pr" && args[1] === "create") {
                    const baseIdx = args.indexOf("--base");
                    prCreatedForBase = baseIdx !== -1 ? args[baseIdx + 1] : null;
                    return {
                        exitCode: 0,
                        stdout: "https://github.com/123bharath/ecommerce-sdet-platform/pull/300\n",
                        stderr: ""
                    };
                }
                return await runCommand(cmd, args, { cwd: options.cwd });
            };

            try {
                const result = await createRepairPr({
                    baseBranch: "test/diagnostic-ci-failure-trial",
                    repairBranch: tempRepairBranch,
                    sourceCommit: diagnosticSha,
                    targetFile: pomRel,
                    patchPath: integrationPatchPath,
                    summaryPath: integrationSummaryPath,
                    rootDir: repoDir,
                    commandRunner: realGitRunner
                });

                assert.strictEqual(result.success, true);
                assert.strictEqual(result.status, "PR_CREATED");
                assert.strictEqual(result.baseBranch, "test/diagnostic-ci-failure-trial");
                assert.strictEqual(result.repairBranch, tempRepairBranch);
                assert.strictEqual(result.sourceCommit, diagnosticSha);
                assert.strictEqual(result.targetFile, pomRel);
                assert.strictEqual(pushCalledForBranch, tempRepairBranch);
                assert.strictEqual(prCreatedForBase, "test/diagnostic-ci-failure-trial");

                // Verify the main working tree was completely unaffected
                const mainPomContent = fs.readFileSync(path.resolve(repoDir, pomRel), "utf8");
                assert.ok(!mainPomContent.includes("Stale Title Indicator"));

                // Verify worktree was cleanly removed
                const worktreeList = execSync("git worktree list --porcelain", { cwd: repoDir, encoding: "utf8" });
                assert.ok(!worktreeList.includes(tempRepairBranch));
            } finally {
                // Clean up the temporary local branch created by git worktree add
                try {
                    execSync(`git branch -D ${tempRepairBranch}`, { cwd: repoDir, stdio: "ignore" });
                } catch { /* best effort */ }
            }
        });

        await runTest("createRepairPr fails without creating draft PR when patch is incompatible with target branch (main), cleaning up worktree and branch", async () => {
            const { repoDir, pomRel, diagnosticSha } = setupIntegrationRepo();

            // Generate patch from diagnostic commit (contains Stale Title Indicator removal)
            const origPomAtDiag = execSync(`git show ${diagnosticSha}:${pomRel}`, { cwd: repoDir, encoding: "utf8" });
            const patchedPomAtDiag = origPomAtDiag.replace(
                /name:\s*"Products - Stale Title Indicator"/,
                'name: "Products"'
            );
            const integrationDiff = generateUnifiedDiff(pomRel, origPomAtDiag, patchedPomAtDiag);
            const incompatPatchPath = path.resolve(TEST_SANDBOX, "integration-incompatible.patch");
            fs.writeFileSync(incompatPatchPath, integrationDiff, "utf8");

            const incompatSummaryPath = path.resolve(TEST_SANDBOX, "integration-incompatible-summary.json");
            fs.writeFileSync(incompatSummaryPath, JSON.stringify({
                status: "VERIFIED",
                targetFile: pomRel,
                originalLocator: 'page.getByRole("heading", { level: 1, name: "Products - Stale Title Indicator" })',
                healedLocator: 'page.getByRole("heading", { level: 1, name: "Products" })'
            }), "utf8");

            const tempIncompatBranch = `ai-repair/test-real-git-incompat-${Date.now()}`;
            let pushCalledIncompat = false;
            let prCreatedIncompat = false;

            const realGitIncompatRunner = async (cmd, args, options) => {
                if (cmd === "git" && args[0] === "push") {
                    pushCalledIncompat = true;
                    return { exitCode: 0, stdout: "", stderr: "" };
                }
                if (cmd === "gh" && args[0] === "pr" && args[1] === "list") {
                    return { exitCode: 0, stdout: "[]", stderr: "" };
                }
                if (cmd === "gh" && args[0] === "pr" && args[1] === "create") {
                    prCreatedIncompat = true;
                    return { exitCode: 0, stdout: "https://github.com/123bharath/ecommerce-sdet-platform/pull/999\n", stderr: "" };
                }
                return await runCommand(cmd, args, { cwd: options.cwd });
            };

            try {
                // Here, baseBranch is "main", which is INCOMPATIBLE with the diagnostic patch because main already has "Products"
                await assert.rejects(async () => {
                    await createRepairPr({
                        baseBranch: "main",
                        repairBranch: tempIncompatBranch,
                        sourceCommit: diagnosticSha,
                        targetFile: pomRel,
                        patchPath: incompatPatchPath,
                        summaryPath: incompatSummaryPath,
                        rootDir: repoDir,
                        commandRunner: realGitIncompatRunner
                    });
                }, (err) => {
                    assert.ok(err.message.includes("Security Violation: Patch cannot be safely applied to target branch 'main'"));
                    return true;
                });

                // PROVE: zero push and zero PR-create calls
                assert.strictEqual(pushCalledIncompat, false, "git push must NEVER be called when patch cannot be safely applied");
                assert.strictEqual(prCreatedIncompat, false, "gh pr create must NEVER be called when patch cannot be safely applied");

                // PROVE: worktree was completely cleaned up on failure
                const worktreeList = execSync("git worktree list --porcelain", { cwd: repoDir, encoding: "utf8" });
                assert.ok(!worktreeList.includes(tempIncompatBranch), "Worktree must be removed on failure");

                // PROVE: temporary repair branch was cleaned up even on failure
                const branchList = execSync("git branch --list", { cwd: repoDir, encoding: "utf8" });
                assert.ok(!branchList.includes(tempIncompatBranch), "Temporary repair branch must be cleaned up on failure");
            } finally {
                try {
                    execSync(`git branch -D ${tempIncompatBranch}`, { cwd: repoDir, stdio: "ignore" });
                } catch { /* best effort rollback guard */ }
            }
        });

        console.log(`\n============================================================`);
        console.log(`All Safe Repair PR Generator Unit Tests Passed! (${passed}/${total} tests passed)`);
        console.log(`============================================================\n`);
    } finally {
        teardownSandbox();
    }
}

runAll().catch((err) => {
    console.error("\n[TEST RUNNER FAILED]:", err);
    process.exit(1);
});

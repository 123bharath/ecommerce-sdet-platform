const assert = require("assert");
const fs = require("fs");
const path = require("path");
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
                    sourceCommit: "abc", // Too short (min 7)
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

        await runTest("validateCommandSafety strictly blocks auto-merging PRs via gh", () => {
            assert.throws(() => {
                validateCommandSafety("gh", ["pr", "merge", "123", "--auto"]);
            }, /Automated pull request merging is strictly prohibited/);

            assert.throws(() => {
                validateCommandSafety("gh", ["pr", "merge", "123", "--rebase"]);
            }, /Automated pull request merging is strictly prohibited/);
        });

        await runTest("validateCommandSafety approves legitimate git and gh commands", () => {
            assert.doesNotThrow(() => {
                validateCommandSafety("git", ["worktree", "add", "-b", "ai-repair/fix", "/tmp/wt", "a1b2c3d"]);
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
                sourceCommit: "1234567890abcdef1234567890abcdef12345678",
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
                sourceCommit: "1234567890abcdef1234567890abcdef12345678",
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
                sourceCommit: "1234567890abcdef1234567890abcdef12345678",
                patchPath: validPatchPath,
                summaryPath,
                rootDir: ROOT_DIR
            });

            assert.strictEqual(result.success, false);
            assert.strictEqual(result.status, "TARGET_MISMATCH");
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
                    sourceCommit: "1234567890abcdef1234567890abcdef12345678",
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
                sourceCommit: "1234567890abcdef1234567890abcdef12345678",
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
                sourceCommit: "1234567890abcdef1234567890abcdef12345678",
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
                    sourceCommit: "1234567890abcdef1234567890abcdef12345678",
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

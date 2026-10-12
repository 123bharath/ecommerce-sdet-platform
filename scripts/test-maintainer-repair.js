const assert = require("assert");
const fs = require("fs");
const path = require("path");
const {
    isValidGitRef,
    validateTargetPomPath,
    validateTestSpecPath,
    verifyCiMetadata,
    resolveRunRepository,
    resolvePrRepository,
    extractRepoFromRunUrl,
    extractRepoFromPrUrl
} = require("./verify-ci-metadata");
const {
    resolveCandidatePatch,
    validatePatchAst,
    validateUnifiedDiff,
    checkSyntaxIntegrity,
    checkPermittedLocatorChanges,
    validateAstIntegrity,
    runRepairAgent,
    ROOT_DIR
} = require("./ai-repair-agent");

const TEST_SANDBOX = path.resolve(ROOT_DIR, "test-results/.test-maintainer-sandbox");

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
    console.log("=== Running Maintainer AI Test Repair (Phase 3B.4A) Safeguard Tests ===\n");
    setupSandbox();

    try {
        // =========================================================================
        // SUITE 1: Input Validation & Sanitization
        // =========================================================================
        console.log("[Suite 1] Input Validation & Shell Injection Prevention");

        await runTest("Rejects non-numeric ciRunId", () => {
            const res = verifyCiMetadata({
                ciRunId: "run-123",
                sourceCommit: "0123456789abcdef0123456789abcdef01234567",
                contextPath: "foo.json",
                evidencePath: "bar.json"
            });
            assert.strictEqual(res.valid, false);
            assert.strictEqual(res.error, "INVALID_INPUT");
            assert(res.message.includes("ci_run_id must contain digits only"));
        });

        await runTest("Rejects invalid sourceCommit SHA format", () => {
            const res = verifyCiMetadata({
                ciRunId: "123456",
                sourceCommit: "not-a-sha; rm -rf /",
                contextPath: "foo.json",
                evidencePath: "bar.json"
            });
            assert.strictEqual(res.valid, false);
            assert.strictEqual(res.error, "INVALID_INPUT");
            assert(res.message.includes("source_commit must be a 40-character hexadecimal SHA"));
        });

        await runTest("Rejects non-numeric prNumber", () => {
            const res = verifyCiMetadata({
                ciRunId: "123456",
                sourceCommit: "0123456789abcdef0123456789abcdef01234567",
                prNumber: "pr#42",
                contextPath: "foo.json",
                evidencePath: "bar.json"
            });
            assert.strictEqual(res.valid, false);
            assert.strictEqual(res.error, "INVALID_INPUT");
            assert(res.message.includes("pr_number must contain digits only"));
        });

        await runTest("Rejects invalid baseBranch with path traversal or metacharacters", () => {
            const res = verifyCiMetadata({
                ciRunId: "123456",
                sourceCommit: "0123456789abcdef0123456789abcdef01234567",
                baseBranch: "main..dev",
                contextPath: "foo.json",
                evidencePath: "bar.json"
            });
            assert.strictEqual(res.valid, false);
            assert.strictEqual(res.error, "INVALID_INPUT");
            assert(res.message.includes("base_branch is not a valid git reference"));
        });

        await runTest("Rejects missing contextPath or evidencePath (no workspace fallback)", () => {
            const resNoContext = verifyCiMetadata({
                ciRunId: "123456",
                sourceCommit: "0123456789abcdef0123456789abcdef01234567",
                evidencePath: "evidence.json"
            });
            assert.strictEqual(resNoContext.valid, false);
            assert.strictEqual(resNoContext.error, "INVALID_INPUT");
            assert(resNoContext.message.includes("Explicit contextPath must be provided"));

            const resNoEvidence = verifyCiMetadata({
                ciRunId: "123456",
                sourceCommit: "0123456789abcdef0123456789abcdef01234567",
                contextPath: "context.json"
            });
            assert.strictEqual(resNoEvidence.valid, false);
            assert.strictEqual(resNoEvidence.error, "INVALID_INPUT");
            assert(resNoEvidence.message.includes("Explicit evidencePath must be provided"));
        });

        await runTest("Rejects test spec path outside tests/ui/*.spec.(js|ts) or containing traversal", () => {
            assert.throws(() => {
                validateTestSpecPath("backend/server.js");
            }, /Tier 1 UI test spec must reside directly under 'tests\/ui\/\*\.spec\.\(js\|ts\)'/);

            assert.throws(() => {
                validateTestSpecPath("tests/api/products.spec.js");
            }, /Tier 1 UI test spec must reside directly under 'tests\/ui\/\*\.spec\.\(js\|ts\)'/);

            assert.throws(() => {
                validateTestSpecPath("tests/ui/../etc/passwd.spec.js");
            }, /Path traversal rejected/);

            assert.strictEqual(validateTestSpecPath("tests/ui/product-list.spec.js"), "tests/ui/product-list.spec.js");
        });

        // =========================================================================
        // SUITE 2: GitHub API Run & PR Metadata Verification
        // =========================================================================
        console.log("\n[Suite 2] GitHub API CI Run & PR Metadata Verification");

        const validSha = "0123456789abcdef0123456789abcdef01234567";

        await runTest("Rejects CI run when conclusion is 'success' instead of 'failure'", () => {
            const mockApi = ({ command, args }) => {
                if (command === "run") {
                    return { status: "completed", conclusion: "success", headSha: validSha, event: "pull_request" };
                }
                throw new Error("Unexpected command");
            };

            const res = verifyCiMetadata({
                ciRunId: "123456",
                sourceCommit: validSha,
                contextPath: "c.json",
                evidencePath: "e.json",
                apiClient: mockApi
            });
            assert.strictEqual(res.valid, false);
            assert.strictEqual(res.error, "RUN_NOT_FAILED");
            assert(res.message.includes("conclusion is 'success', expected 'failure'"));
        });

        await runTest("Rejects CI run when status is not 'completed'", () => {
            const mockApi = ({ command, args }) => {
                if (command === "run") {
                    return { status: "in_progress", conclusion: "failure", headSha: validSha, event: "pull_request" };
                }
                throw new Error("Unexpected command");
            };

            const res = verifyCiMetadata({
                ciRunId: "123456",
                sourceCommit: validSha,
                contextPath: "c.json",
                evidencePath: "e.json",
                apiClient: mockApi
            });
            assert.strictEqual(res.valid, false);
            assert.strictEqual(res.error, "RUN_NOT_COMPLETED");
        });

        await runTest("Rejects CI run when headSha does not match sourceCommit", () => {
            const mockApi = ({ command, args }) => {
                if (command === "run") {
                    return { status: "completed", conclusion: "failure", headSha: "fedcba9876543210fedcba9876543210fedcba98", event: "pull_request" };
                }
                throw new Error("Unexpected command");
            };

            const res = verifyCiMetadata({
                ciRunId: "123456",
                sourceCommit: validSha,
                contextPath: "c.json",
                evidencePath: "e.json",
                apiClient: mockApi
            });
            assert.strictEqual(res.valid, false);
            assert.strictEqual(res.error, "COMMIT_SHA_MISMATCH");
        });

        await runTest("Rejects PR when state is not 'OPEN'", () => {
            const mockApi = ({ command, args }) => {
                if (command === "run") {
                    return { status: "completed", conclusion: "failure", headSha: validSha, event: "pull_request" };
                }
                if (command === "pr") {
                    return { state: "MERGED", headRefOid: validSha, baseRefName: "main" };
                }
                throw new Error("Unexpected command");
            };

            const res = verifyCiMetadata({
                ciRunId: "123456",
                sourceCommit: validSha,
                prNumber: "42",
                contextPath: "c.json",
                evidencePath: "e.json",
                apiClient: mockApi
            });
            assert.strictEqual(res.valid, false);
            assert.strictEqual(res.error, "PR_NOT_OPEN");
            assert(res.message.includes("state is 'MERGED', expected 'OPEN'"));
        });

        await runTest("Rejects PR when headRefOid has mutated (PR_HEAD_MUTATED)", () => {
            const mockApi = ({ command, args }) => {
                if (command === "run") {
                    return { status: "completed", conclusion: "failure", headSha: validSha, event: "pull_request" };
                }
                if (command === "pr") {
                    return { state: "OPEN", headRefOid: "aaaa0000bbbb1111cccc2222dddd3333eeee4444", baseRefName: "main" };
                }
                throw new Error("Unexpected command");
            };

            const res = verifyCiMetadata({
                ciRunId: "123456",
                sourceCommit: validSha,
                prNumber: "42",
                contextPath: "c.json",
                evidencePath: "e.json",
                apiClient: mockApi
            });
            assert.strictEqual(res.valid, false);
            assert.strictEqual(res.error, "PR_HEAD_MUTATED");
            assert(res.message.includes("PR #42 head has mutated"));
        });

        await runTest("Rejects PR when base branch does not match expected base_branch", () => {
            const mockApi = ({ command, args }) => {
                if (command === "run") {
                    return { status: "completed", conclusion: "failure", headSha: validSha, event: "pull_request" };
                }
                if (command === "pr") {
                    return { state: "OPEN", headRefOid: validSha, baseRefName: "develop" };
                }
                throw new Error("Unexpected command");
            };

            const res = verifyCiMetadata({
                ciRunId: "123456",
                sourceCommit: validSha,
                prNumber: "42",
                baseBranch: "main",
                contextPath: "c.json",
                evidencePath: "e.json",
                apiClient: mockApi
            });
            assert.strictEqual(res.valid, false);
            assert.strictEqual(res.error, "PR_BASE_MISMATCH");
            assert(res.message.includes("base branch is 'develop', expected 'main'"));
        });

        await runTest("Rejects when CI run repository does not match expected repository (REPOSITORY_MISMATCH)", () => {
            const mockApi = ({ command, args }) => {
                if (command === "run") {
                    return {
                        status: "completed",
                        conclusion: "failure",
                        headSha: validSha,
                        event: "pull_request",
                        headRepository: { nameWithOwner: "attacker/malicious-repo" }
                    };
                }
                throw new Error("Unexpected command");
            };

            const res = verifyCiMetadata({
                ciRunId: "123456",
                sourceCommit: validSha,
                expectedRepo: "myorg/ecommerce-sdet-platform",
                contextPath: "c.json",
                evidencePath: "e.json",
                apiClient: mockApi
            });
            assert.strictEqual(res.valid, false);
            assert.strictEqual(res.error, "REPOSITORY_MISMATCH");
            assert(res.message.includes("does not match expected repository"));
        });

        await runTest("Rejects when CI run repository from canonical URL does not match expected repository (REPOSITORY_MISMATCH)", () => {
            const mockApi = ({ command, args }) => {
                if (command === "run") {
                    return {
                        status: "completed",
                        conclusion: "failure",
                        headSha: validSha,
                        event: "pull_request",
                        url: "https://github.com/attacker/malicious-repo/actions/runs/123456"
                    };
                }
                throw new Error("Unexpected command");
            };

            const res = verifyCiMetadata({
                ciRunId: "123456",
                sourceCommit: validSha,
                expectedRepo: "123bharath/ecommerce-sdet-platform",
                contextPath: "c.json",
                evidencePath: "e.json",
                apiClient: mockApi
            });
            assert.strictEqual(res.valid, false);
            assert.strictEqual(res.error, "REPOSITORY_MISMATCH");
            assert(res.message.includes("attacker/malicious-repo"));
        });

        await runTest("Approves when CI run repository from canonical URL matches expected repository", () => {
            const mockApi = ({ command, args }) => {
                if (command === "run") {
                    return {
                        status: "completed",
                        conclusion: "failure",
                        headSha: validSha,
                        event: "pull_request",
                        attempt: 1,
                        url: "https://github.com/123bharath/ecommerce-sdet-platform/actions/runs/123456"
                    };
                }
                if (command === "pr") {
                    return {
                        state: "OPEN",
                        headRefOid: validSha,
                        headRefName: "test-branch",
                        baseRefName: "main",
                        url: "https://github.com/123bharath/ecommerce-sdet-platform/pull/2"
                    };
                }
                throw new Error("Unexpected command");
            };

            const repoMatchContextPath = path.resolve(TEST_SANDBOX, "repo-match-context.json");
            fs.writeFileSync(repoMatchContextPath, JSON.stringify({
                timestamp: new Date().toISOString(),
                commitSha: validSha,
                headSha: validSha,
                runId: "123456",
                runAttempt: 1,
                repository: "123bharath/ecommerce-sdet-platform",
                failures: [{
                    targetFile: "tests/pages/ProductListPage.js",
                    specFile: "tests/ui/product-list.spec.js"
                }]
            }));

            const sampleEvidencePath = path.resolve(TEST_SANDBOX, "repo-sample-evidence.json");
            fs.writeFileSync(sampleEvidencePath, JSON.stringify({
                hasEvidence: true,
                domSnapshot: "<h1>Products</h1>",
                accessibilitySnapshot: "heading 'Products'"
            }));

            const res = verifyCiMetadata({
                ciRunId: "123456",
                sourceCommit: validSha,
                prNumber: "2",
                expectedRepo: "123bharath/ecommerce-sdet-platform",
                contextPath: repoMatchContextPath,
                evidencePath: sampleEvidencePath,
                apiClient: mockApi,
                gitRunner: () => true
            });
            assert.strictEqual(res.valid, true);
        });

        await runTest("Rejects when PR repository does not match expected repository (REPOSITORY_MISMATCH)", () => {
            const mockApi = ({ command, args }) => {
                if (command === "run") {
                    return {
                        status: "completed",
                        conclusion: "failure",
                        headSha: validSha,
                        event: "pull_request",
                        attempt: 1,
                        url: "https://github.com/123bharath/ecommerce-sdet-platform/actions/runs/123456"
                    };
                }
                if (command === "pr") {
                    return {
                        state: "OPEN",
                        headRefOid: validSha,
                        headRefName: "test-branch",
                        baseRefName: "main",
                        headRepository: { nameWithOwner: "external/untrusted-fork" }
                    };
                }
                throw new Error("Unexpected command");
            };

            const prRepoContextPath = path.resolve(TEST_SANDBOX, "pr-repo-context.json");
            fs.writeFileSync(prRepoContextPath, JSON.stringify({
                timestamp: new Date().toISOString(),
                commitSha: validSha,
                headSha: validSha,
                runId: "123456",
                runAttempt: 1,
                repository: "123bharath/ecommerce-sdet-platform",
                failures: [{ targetFile: "tests/pages/ProductListPage.js" }]
            }));

            const sampleEvidencePath = path.resolve(TEST_SANDBOX, "repo-sample-evidence.json");
            const res = verifyCiMetadata({
                ciRunId: "123456",
                sourceCommit: validSha,
                prNumber: "2",
                expectedRepo: "123bharath/ecommerce-sdet-platform",
                contextPath: prRepoContextPath,
                evidencePath: sampleEvidencePath,
                apiClient: mockApi
            });
            assert.strictEqual(res.valid, false);
            assert.strictEqual(res.error, "REPOSITORY_MISMATCH");
            assert(res.message.includes("external/untrusted-fork"));
        });

        await runTest("extractRepoFromRunUrl and resolveRunRepository handle various formats correctly", () => {
            assert.strictEqual(extractRepoFromRunUrl("https://github.com/foo/bar/actions/runs/123"), "foo/bar");
            assert.strictEqual(extractRepoFromRunUrl("http://github.com/foo/bar/actions/runs/99999999"), "foo/bar");
            assert.strictEqual(extractRepoFromRunUrl("invalid-url"), null);
            assert.strictEqual(extractRepoFromRunUrl(null), null);

            assert.strictEqual(resolveRunRepository({ url: "https://github.com/my-org/my-repo/actions/runs/42" }), "my-org/my-repo");
            assert.strictEqual(resolveRunRepository({ headRepository: { nameWithOwner: "custom/repo" } }), "custom/repo");
            assert.strictEqual(resolveRunRepository({ repository: "string/repo" }), "string/repo");
            assert.strictEqual(resolveRunRepository({ repository: { full_name: "obj/repo" } }), "obj/repo");
            assert.strictEqual(resolveRunRepository({}), null);
        });

        // =========================================================================
        // SUITE 3: Artifact Lineage, Freshness & Evidence Verification
        // =========================================================================
        console.log("\n[Suite 3] Artifact Lineage, Freshness & Evidence Verification");

        const mockApiSuccess = ({ command, args }) => {
            if (command === "run") {
                return { status: "completed", conclusion: "failure", headSha: validSha, event: "pull_request" };
            }
            if (command === "pr") {
                return { state: "OPEN", headRefOid: validSha, baseRefName: "main" };
            }
            throw new Error("Unexpected command");
        };

        const sampleContextPath = path.resolve(TEST_SANDBOX, "fresh-context.json");
        const sampleEvidencePath = path.resolve(TEST_SANDBOX, "fresh-evidence.json");

        fs.writeFileSync(sampleContextPath, JSON.stringify({
            timestamp: new Date().toISOString(),
            commitSha: validSha,
            headSha: validSha,
            runId: "123456",
            status: "FAILED",
            failures: [{
                testTitle: "Catalog page heading",
                specFile: "tests/ui/product-list.spec.js",
                targetFile: "tests/pages/ProductListPage.js",
                targetLocator: "page.getByRole(\"heading\", { level: 1, name: \"Products\" })",
                errorMessage: "Error: Timed out waiting for locator: page.getByRole(\"heading\", { level: 1, name: \"Products\" })",
                observedSymptom: "LOCATOR_LOOKUP_TIMEOUT"
            }]
        }, null, 2));

        fs.writeFileSync(sampleEvidencePath, JSON.stringify({
            hasEvidence: true,
            domSnapshot: "<h1>Products Catalog</h1>",
            accessibilitySnapshot: "heading 'Products Catalog' [level=1]"
        }, null, 2));

        await runTest("Rejects missing context file at specified path", () => {
            const res = verifyCiMetadata({
                ciRunId: "123456",
                sourceCommit: validSha,
                contextPath: path.resolve(TEST_SANDBOX, "nonexistent-context.json"),
                evidencePath: sampleEvidencePath,
                apiClient: mockApiSuccess
            });
            assert.strictEqual(res.valid, false);
            assert.strictEqual(res.error, "MISSING_ARTIFACTS");
        });

        await runTest("Rejects missing evidence file at specified path", () => {
            const res = verifyCiMetadata({
                ciRunId: "123456",
                sourceCommit: validSha,
                contextPath: sampleContextPath,
                evidencePath: path.resolve(TEST_SANDBOX, "nonexistent-evidence.json"),
                apiClient: mockApiSuccess
            });
            assert.strictEqual(res.valid, false);
            assert.strictEqual(res.error, "MISSING_ARTIFACTS");
        });

        await runTest("Rejects stale artifact older than 24 hours (STALE_ARTIFACT)", () => {
            const staleContextPath = path.resolve(TEST_SANDBOX, "stale-context.json");
            const oldDate = new Date(Date.now() - 25 * 3600 * 1000).toISOString(); // 25 hours ago
            fs.writeFileSync(staleContextPath, JSON.stringify({
                timestamp: oldDate,
                commitSha: validSha,
                runId: "123456",
                failures: [{ targetFile: "tests/pages/ProductListPage.js" }]
            }));

            const res = verifyCiMetadata({
                ciRunId: "123456",
                sourceCommit: validSha,
                contextPath: staleContextPath,
                evidencePath: sampleEvidencePath,
                apiClient: mockApiSuccess
            });
            assert.strictEqual(res.valid, false);
            assert.strictEqual(res.error, "STALE_ARTIFACT");
            assert(res.message.includes("Failure context is stale"));
        });

        await runTest("Rejects context when stamped commitSha mismatches requested source_commit", () => {
            const mismatchedContextPath = path.resolve(TEST_SANDBOX, "mismatched-sha.json");
            fs.writeFileSync(mismatchedContextPath, JSON.stringify({
                timestamp: new Date().toISOString(),
                commitSha: "9999888877776666555544443333222211110000",
                headSha: validSha,
                runId: "123456",
                failures: [{ targetFile: "tests/pages/ProductListPage.js" }]
            }));

            const res = verifyCiMetadata({
                ciRunId: "123456",
                sourceCommit: validSha,
                contextPath: mismatchedContextPath,
                evidencePath: sampleEvidencePath,
                apiClient: mockApiSuccess
            });
            assert.strictEqual(res.valid, false);
            assert.strictEqual(res.error, "CONTEXT_SHA_MISMATCH");
        });

        await runTest("Rejects evidence when hasEvidence is false or snapshots missing", () => {
            const emptyEvidencePath = path.resolve(TEST_SANDBOX, "empty-evidence.json");
            fs.writeFileSync(emptyEvidencePath, JSON.stringify({
                hasEvidence: false
            }));

            const res = verifyCiMetadata({
                ciRunId: "123456",
                sourceCommit: validSha,
                contextPath: sampleContextPath,
                evidencePath: emptyEvidencePath,
                apiClient: mockApiSuccess
            });
            assert.strictEqual(res.valid, false);
            assert.strictEqual(res.error, "INSUFFICIENT_EVIDENCE");
        });

        await runTest("Rejects when CI run attempt does not match context run attempt (RUN_ATTEMPT_MISMATCH)", () => {
            let capturedArgs = null;
            const mockApi = ({ command, args }) => {
                if (command === "run") {
                    capturedArgs = args;
                    return {
                        status: "completed",
                        conclusion: "failure",
                        headSha: validSha,
                        event: "pull_request",
                        attempt: 2 // Real GitHub CLI field name
                    };
                }
                throw new Error("Unexpected command");
            };

            const attemptContextPath = path.resolve(TEST_SANDBOX, "attempt-context.json");
            fs.writeFileSync(attemptContextPath, JSON.stringify({
                timestamp: new Date().toISOString(),
                commitSha: validSha,
                runId: "123456",
                runAttempt: 1,
                failures: [{ targetFile: "tests/pages/ProductListPage.js" }]
            }));

            const res = verifyCiMetadata({
                ciRunId: "123456",
                sourceCommit: validSha,
                contextPath: attemptContextPath,
                evidencePath: sampleEvidencePath,
                apiClient: mockApi
            });
            assert.strictEqual(res.valid, false);
            assert.strictEqual(res.error, "RUN_ATTEMPT_MISMATCH");
            assert(res.message.includes("run attempt #1, but CI run is currently on attempt #2"));

            // Verify CLI arguments strictly use supported fields and omit unsupported fields
            assert(capturedArgs, "API client should have been invoked with args");
            const jsonIdx = capturedArgs.indexOf("--json");
            assert(jsonIdx !== -1, "gh run view must specify --json");
            const jsonFields = capturedArgs[jsonIdx + 1];
            assert(jsonFields.includes("attempt"), "gh run view --json must request supported 'attempt' field");
            assert(jsonFields.includes("url"), "gh run view --json must request supported 'url' field for repo resolution");
            assert(!jsonFields.includes("runAttempt"), "gh run view --json must NOT request unsupported 'runAttempt' field");
            assert(!jsonFields.includes("headRepository"), "gh run view --json must NOT request unsupported 'headRepository' field");
        });

        await runTest("Approves when CI run attempt (via supported CLI field 'attempt') matches context runAttempt", () => {
            const mockApi = ({ command, args }) => {
                if (command === "run") {
                    return {
                        status: "completed",
                        conclusion: "failure",
                        headSha: validSha,
                        event: "pull_request",
                        attempt: 1 // Real GitHub CLI field name
                    };
                }
                if (command === "pr") {
                    return { state: "OPEN", headRefOid: validSha, headRefName: "feature", baseRefName: "main" };
                }
                throw new Error("Unexpected command");
            };

            const matchAttemptContextPath = path.resolve(TEST_SANDBOX, "match-attempt-context.json");
            fs.writeFileSync(matchAttemptContextPath, JSON.stringify({
                timestamp: new Date().toISOString(),
                commitSha: validSha,
                headSha: validSha,
                runId: "123456",
                runAttempt: 1,
                failures: [{
                    targetFile: "tests/pages/ProductListPage.js",
                    specFile: "tests/ui/product-list.spec.js"
                }]
            }));

            const res = verifyCiMetadata({
                ciRunId: "123456",
                sourceCommit: validSha,
                prNumber: "2",
                contextPath: matchAttemptContextPath,
                evidencePath: sampleEvidencePath,
                apiClient: mockApi,
                gitRunner: () => true
            });
            assert.strictEqual(res.valid, true);
            assert.strictEqual(res.runAttempt, 1);
        });

        await runTest("Supports backwards-compatible 'runAttempt' if provided by mock client", () => {
            const mockApi = ({ command, args }) => {
                if (command === "run") {
                    return {
                        status: "completed",
                        conclusion: "failure",
                        headSha: validSha,
                        event: "pull_request",
                        runAttempt: 3
                    };
                }
                throw new Error("Unexpected command");
            };

            const legacyAttemptContextPath = path.resolve(TEST_SANDBOX, "legacy-attempt-context.json");
            fs.writeFileSync(legacyAttemptContextPath, JSON.stringify({
                timestamp: new Date().toISOString(),
                commitSha: validSha,
                runId: "123456",
                runAttempt: 1,
                failures: [{ targetFile: "tests/pages/ProductListPage.js" }]
            }));

            const res = verifyCiMetadata({
                ciRunId: "123456",
                sourceCommit: validSha,
                contextPath: legacyAttemptContextPath,
                evidencePath: sampleEvidencePath,
                apiClient: mockApi
            });
            assert.strictEqual(res.valid, false);
            assert.strictEqual(res.error, "RUN_ATTEMPT_MISMATCH");
            assert(res.message.includes("run attempt #1, but CI run is currently on attempt #3"));
        });

        await runTest("Rejects when requested source_commit is the transient PR merge commit (MERGE_SHA_REJECTED)", () => {
            const mergeCommitSha = "aaaa111122223333444455556666777788889999";
            const headCommitSha = validSha;

            const mockApi = ({ command, args }) => {
                if (command === "run") {
                    return {
                        status: "completed",
                        conclusion: "failure",
                        headSha: mergeCommitSha,
                        event: "pull_request"
                    };
                }
                throw new Error("Unexpected command");
            };

            const mergeContextPath = path.resolve(TEST_SANDBOX, "merge-context.json");
            fs.writeFileSync(mergeContextPath, JSON.stringify({
                timestamp: new Date().toISOString(),
                commitSha: mergeCommitSha,
                headSha: headCommitSha,
                mergeSha: mergeCommitSha,
                runId: "123456",
                failures: [{ targetFile: "tests/pages/ProductListPage.js" }]
            }));

            const res = verifyCiMetadata({
                ciRunId: "123456",
                sourceCommit: mergeCommitSha,
                contextPath: mergeContextPath,
                evidencePath: sampleEvidencePath,
                apiClient: mockApi
            });
            assert.strictEqual(res.valid, false);
            assert.strictEqual(res.error, "MERGE_SHA_REJECTED");
            assert(res.message.includes("transient PR merge commit"));
        });

        await runTest("Approves PR run where tested commitSha is synthetic merge commit and headSha is requested source_commit", () => {
            const mergeCommitSha = "aaaa111122223333444455556666777788889999";
            const headCommitSha = validSha;

            const mockApi = ({ command, args }) => {
                if (command === "run") {
                    return {
                        status: "completed",
                        conclusion: "failure",
                        headSha: headCommitSha,
                        event: "pull_request"
                    };
                }
                if (command === "pr") {
                    return {
                        state: "OPEN",
                        headRefOid: headCommitSha,
                        baseRefName: "main"
                    };
                }
                throw new Error("Unexpected command");
            };

            const validPrContextPath = path.resolve(TEST_SANDBOX, "valid-pr-lineage-context.json");
            fs.writeFileSync(validPrContextPath, JSON.stringify({
                timestamp: new Date().toISOString(),
                commitSha: mergeCommitSha,
                headSha: headCommitSha,
                mergeSha: mergeCommitSha,
                runId: "123456",
                failures: [{
                    targetFile: "tests/pages/ProductListPage.js",
                    specFile: "tests/ui/product-list.spec.js"
                }]
            }));

            const res = verifyCiMetadata({
                ciRunId: "123456",
                sourceCommit: headCommitSha,
                prNumber: "42",
                baseBranch: "main",
                contextPath: validPrContextPath,
                evidencePath: sampleEvidencePath,
                apiClient: mockApi,
                gitRunner: () => true
            });
            assert.strictEqual(res.valid, true);
            assert.strictEqual(res.sourceCommit, headCommitSha);
        });

        await runTest("Rejects PR run when context headSha mismatches requested source_commit (PR_HEAD_MISMATCH)", () => {
            const mergeCommitSha = "aaaa111122223333444455556666777788889999";
            const headCommitSha = validSha;
            const alienHeadSha = "1234567890abcdef1234567890abcdef12345678";

            const mockApi = ({ command, args }) => {
                if (command === "run") {
                    return {
                        status: "completed",
                        conclusion: "failure",
                        headSha: headCommitSha,
                        event: "pull_request"
                    };
                }
                throw new Error("Unexpected command");
            };

            const mismatchedHeadContextPath = path.resolve(TEST_SANDBOX, "mismatched-head-context.json");
            fs.writeFileSync(mismatchedHeadContextPath, JSON.stringify({
                timestamp: new Date().toISOString(),
                commitSha: mergeCommitSha,
                headSha: alienHeadSha,
                mergeSha: mergeCommitSha,
                runId: "123456",
                failures: [{ targetFile: "tests/pages/ProductListPage.js" }]
            }));

            const res = verifyCiMetadata({
                ciRunId: "123456",
                sourceCommit: headCommitSha,
                contextPath: mismatchedHeadContextPath,
                evidencePath: sampleEvidencePath,
                apiClient: mockApi
            });
            assert.strictEqual(res.valid, false);
            assert.strictEqual(res.error, "PR_HEAD_MISMATCH");
        });

        await runTest("Approves valid merge-run/head-commit combination where run reports merge commit and PR API reports head commit", () => {
            const mergeCommitSha = "aaaa111122223333444455556666777788889999";
            const headCommitSha = validSha;

            const mockApi = ({ command, args }) => {
                if (command === "run") {
                    return {
                        status: "completed",
                        conclusion: "failure",
                        headSha: mergeCommitSha, // Run API reports synthetic merge commit!
                        event: "pull_request"
                    };
                }
                if (command === "pr") {
                    return {
                        state: "OPEN",
                        headRefOid: headCommitSha, // PR API reports PR head commit!
                        baseRefName: "main"
                    };
                }
                throw new Error("Unexpected command");
            };

            const validMergeRunContextPath = path.resolve(TEST_SANDBOX, "valid-merge-run-context.json");
            fs.writeFileSync(validMergeRunContextPath, JSON.stringify({
                timestamp: new Date().toISOString(),
                commitSha: mergeCommitSha,
                headSha: headCommitSha,
                mergeSha: mergeCommitSha,
                runId: "123456",
                failures: [{
                    targetFile: "tests/pages/ProductListPage.js",
                    specFile: "tests/ui/product-list.spec.js"
                }]
            }));

            const res = verifyCiMetadata({
                ciRunId: "123456",
                sourceCommit: headCommitSha,
                prNumber: "42",
                baseBranch: "main",
                contextPath: validMergeRunContextPath,
                evidencePath: sampleEvidencePath,
                apiClient: mockApi,
                gitRunner: () => true
            });
            assert.strictEqual(res.valid, true);
            assert.strictEqual(res.sourceCommit, headCommitSha);
        });

        await runTest("Rejects when workflow run headSha is an alien commit (COMMIT_SHA_MISMATCH)", () => {
            const mergeCommitSha = "aaaa111122223333444455556666777788889999";
            const headCommitSha = validSha;
            const alienRunSha = "5555666677778888999900001111222233334444";

            const mockApi = ({ command, args }) => {
                if (command === "run") {
                    return {
                        status: "completed",
                        conclusion: "failure",
                        headSha: alienRunSha,
                        event: "pull_request"
                    };
                }
                if (command === "pr") {
                    return {
                        state: "OPEN",
                        headRefOid: headCommitSha,
                        baseRefName: "main"
                    };
                }
                throw new Error("Unexpected command");
            };

            const alienRunContextPath = path.resolve(TEST_SANDBOX, "alien-run-context.json");
            fs.writeFileSync(alienRunContextPath, JSON.stringify({
                timestamp: new Date().toISOString(),
                commitSha: mergeCommitSha,
                headSha: headCommitSha,
                mergeSha: mergeCommitSha,
                runId: "123456",
                failures: [{ targetFile: "tests/pages/ProductListPage.js" }]
            }));

            const res = verifyCiMetadata({
                ciRunId: "123456",
                sourceCommit: headCommitSha,
                prNumber: "42",
                baseBranch: "main",
                contextPath: alienRunContextPath,
                evidencePath: sampleEvidencePath,
                apiClient: mockApi
            });
            assert.strictEqual(res.valid, false);
            assert.strictEqual(res.error, "COMMIT_SHA_MISMATCH");
        });

        await runTest("Rejects when PR API headRefOid has mutated away from source_commit (PR_HEAD_MUTATED)", () => {
            const mergeCommitSha = "aaaa111122223333444455556666777788889999";
            const headCommitSha = validSha;
            const mutatedPrHead = "7777888899990000111122223333444455556666";

            const mockApi = ({ command, args }) => {
                if (command === "run") {
                    return {
                        status: "completed",
                        conclusion: "failure",
                        headSha: mergeCommitSha,
                        event: "pull_request"
                    };
                }
                if (command === "pr") {
                    return {
                        state: "OPEN",
                        headRefOid: mutatedPrHead,
                        baseRefName: "main"
                    };
                }
                throw new Error("Unexpected command");
            };

            const validMergeRunContextPath = path.resolve(TEST_SANDBOX, "valid-merge-run-context.json");
            const res = verifyCiMetadata({
                ciRunId: "123456",
                sourceCommit: headCommitSha,
                prNumber: "42",
                baseBranch: "main",
                contextPath: validMergeRunContextPath,
                evidencePath: sampleEvidencePath,
                apiClient: mockApi
            });
            assert.strictEqual(res.valid, false);
            assert.strictEqual(res.error, "PR_HEAD_MUTATED");
        });

        await runTest("Approves valid non-PR run (workflow_dispatch) when headSha and context commitSha strictly match source_commit", () => {
            const mockApi = ({ command, args }) => {
                if (command === "run") {
                    return {
                        status: "completed",
                        conclusion: "failure",
                        headSha: validSha,
                        event: "workflow_dispatch",
                        databaseId: 123456,
                        attempt: 1
                    };
                }
                throw new Error("Unexpected command");
            };

            const validDispatchContextPath = path.resolve(TEST_SANDBOX, "valid-dispatch-context.json");
            fs.writeFileSync(validDispatchContextPath, JSON.stringify({
                timestamp: new Date().toISOString(),
                commitSha: validSha,
                headSha: null,
                mergeSha: null,
                runId: "123456",
                runAttempt: 1,
                failures: [{
                    targetFile: "tests/pages/ProductListPage.js",
                    specFile: "tests/ui/product-list.spec.js"
                }]
            }));

            const res = verifyCiMetadata({
                ciRunId: "123456",
                sourceCommit: validSha,
                contextPath: validDispatchContextPath,
                evidencePath: sampleEvidencePath,
                apiClient: mockApi,
                gitRunner: () => true
            });
            assert.strictEqual(res.valid, true);
            assert.strictEqual(res.sourceCommit, validSha);
        });

        await runTest("Rejects non-PR run when pr_number is erroneously provided (EVENT_MISMATCH)", () => {
            const mockApi = ({ command, args }) => {
                if (command === "run") {
                    return {
                        status: "completed",
                        conclusion: "failure",
                        headSha: validSha,
                        event: "workflow_dispatch",
                        databaseId: 123456,
                        attempt: 1
                    };
                }
                if (command === "pr") {
                    return { state: "OPEN", headRefOid: validSha, baseRefName: "main" };
                }
                throw new Error("Unexpected command");
            };

            const validDispatchContextPath = path.resolve(TEST_SANDBOX, "valid-dispatch-context.json");
            const res = verifyCiMetadata({
                ciRunId: "123456",
                sourceCommit: validSha,
                prNumber: "42",
                contextPath: validDispatchContextPath,
                evidencePath: sampleEvidencePath,
                apiClient: mockApi
            });
            assert.strictEqual(res.valid, false);
            assert.strictEqual(res.error, "EVENT_MISMATCH");
            assert(res.message.includes("Cannot specify pr_number (#42) for a non-PR run"));
        });

        await runTest("Rejects non-PR run when context records an inconsistent synthetic mergeSha (CONTEXT_SHA_MISMATCH)", () => {
            const mockApi = ({ command, args }) => {
                if (command === "run") {
                    return {
                        status: "completed",
                        conclusion: "failure",
                        headSha: validSha,
                        event: "workflow_dispatch",
                        databaseId: 123456,
                        attempt: 1
                    };
                }
                throw new Error("Unexpected command");
            };

            const inconsistentDispatchContextPath = path.resolve(TEST_SANDBOX, "inconsistent-dispatch-context.json");
            fs.writeFileSync(inconsistentDispatchContextPath, JSON.stringify({
                timestamp: new Date().toISOString(),
                commitSha: validSha,
                headSha: null,
                mergeSha: "aaaa111122223333444455556666777788889999",
                runId: "123456",
                runAttempt: 1,
                failures: [{ targetFile: "tests/pages/ProductListPage.js" }]
            }));

            const res = verifyCiMetadata({
                ciRunId: "123456",
                sourceCommit: validSha,
                contextPath: inconsistentDispatchContextPath,
                evidencePath: sampleEvidencePath,
                apiClient: mockApi
            });
            assert.strictEqual(res.valid, false);
            assert.strictEqual(res.error, "CONTEXT_SHA_MISMATCH");
            assert(res.message.includes("must not record a synthetic mergeSha"));
        });

        await runTest("Rejects PR merge run when tested commitSha mismatches recorded mergeSha (CONTEXT_SHA_MISMATCH)", () => {
            const mergeCommitSha = "aaaa111122223333444455556666777788889999";
            const headCommitSha = validSha;
            const alienTestedSha = "7777888899990000111122223333444455556666";

            const mockApi = ({ command, args }) => {
                if (command === "run") {
                    return {
                        status: "completed",
                        conclusion: "failure",
                        headSha: headCommitSha,
                        event: "pull_request"
                    };
                }
                if (command === "pr") {
                    return { state: "OPEN", headRefOid: headCommitSha, baseRefName: "main" };
                }
                throw new Error("Unexpected command");
            };

            const inconsistentTestedContextPath = path.resolve(TEST_SANDBOX, "inconsistent-tested-context.json");
            fs.writeFileSync(inconsistentTestedContextPath, JSON.stringify({
                timestamp: new Date().toISOString(),
                commitSha: alienTestedSha, // does not match mergeSha
                headSha: headCommitSha,
                mergeSha: mergeCommitSha,
                runId: "123456",
                failures: [{ targetFile: "tests/pages/ProductListPage.js" }]
            }));

            const res = verifyCiMetadata({
                ciRunId: "123456",
                sourceCommit: headCommitSha,
                prNumber: "42",
                contextPath: inconsistentTestedContextPath,
                evidencePath: sampleEvidencePath,
                apiClient: mockApi
            });
            assert.strictEqual(res.valid, false);
            assert.strictEqual(res.error, "CONTEXT_SHA_MISMATCH");
            assert(res.message.includes("must match recorded mergeSha"));
        });

        await runTest("Rejects PR run when context headSha is missing (PR_HEAD_MISMATCH)", () => {
            const mergeCommitSha = "aaaa111122223333444455556666777788889999";
            const headCommitSha = validSha;

            const mockApi = ({ command, args }) => {
                if (command === "run") {
                    return {
                        status: "completed",
                        conclusion: "failure",
                        headSha: headCommitSha,
                        event: "pull_request"
                    };
                }
                if (command === "pr") {
                    return { state: "OPEN", headRefOid: headCommitSha, baseRefName: "main" };
                }
                throw new Error("Unexpected command");
            };

            const missingHeadContextPath = path.resolve(TEST_SANDBOX, "missing-head-context.json");
            fs.writeFileSync(missingHeadContextPath, JSON.stringify({
                timestamp: new Date().toISOString(),
                commitSha: mergeCommitSha,
                headSha: null, // missing headSha
                mergeSha: mergeCommitSha,
                runId: "123456",
                failures: [{ targetFile: "tests/pages/ProductListPage.js" }]
            }));

            const res = verifyCiMetadata({
                ciRunId: "123456",
                sourceCommit: headCommitSha,
                prNumber: "42",
                contextPath: missingHeadContextPath,
                evidencePath: sampleEvidencePath,
                apiClient: mockApi
            });
            assert.strictEqual(res.valid, false);
            assert.strictEqual(res.error, "PR_HEAD_MISMATCH");
            assert(res.message.includes("must record headSha, but headSha was missing"));
        });

        // =========================================================================
        // SUITE 4: Dynamic Target POM Derivation & Existence
        // =========================================================================
        console.log("\n[Suite 4] Dynamic Target POM Derivation & Git Existence");

        await runTest("Rejects target POM path outside tests/pages/*.js", () => {
            assert.throws(() => {
                validateTargetPomPath("backend/server.js");
            }, /Target POM must reside in tests\/pages\/\*\.js/);

            assert.throws(() => {
                validateTargetPomPath("tests/pages/../../etc/passwd");
            }, /Path traversal rejected/);
        });

        await runTest("Rejects target POM when it does not physically exist at source_commit", () => {
            const mockGitRunner = (commit, file) => false; // file does not exist at commit

            const res = verifyCiMetadata({
                ciRunId: "123456",
                sourceCommit: validSha,
                contextPath: sampleContextPath,
                evidencePath: sampleEvidencePath,
                apiClient: mockApiSuccess,
                gitRunner: mockGitRunner
            });
            assert.strictEqual(res.valid, false);
            assert.strictEqual(res.error, "TARGET_NOT_AT_SOURCE_COMMIT");
            assert(res.message.includes("does not physically exist at source_commit"));
        });

        await runTest("Rejects primary UI test spec when it does not physically exist at source_commit", () => {
            const mockGitRunner = (commit, file) => {
                if (file.includes("ProductListPage.js")) return true;
                return false; // test spec does not exist at commit
            };

            const res = verifyCiMetadata({
                ciRunId: "123456",
                sourceCommit: validSha,
                contextPath: sampleContextPath,
                evidencePath: sampleEvidencePath,
                apiClient: mockApiSuccess,
                gitRunner: mockGitRunner
            });
            assert.strictEqual(res.valid, false);
            assert.strictEqual(res.error, "TEST_SPEC_NOT_AT_SOURCE_COMMIT");
            assert(res.message.includes("does not physically exist at source_commit"));
        });

        await runTest("Approves valid matching CI run, PR, fresh artifacts, and existing target POM", () => {
            const mockGitRunner = (commit, file) => true; // exists at commit

            const res = verifyCiMetadata({
                ciRunId: "123456",
                sourceCommit: validSha,
                prNumber: "42",
                baseBranch: "main",
                contextPath: sampleContextPath,
                evidencePath: sampleEvidencePath,
                apiClient: mockApiSuccess,
                gitRunner: mockGitRunner
            });
            assert.strictEqual(res.valid, true);
            assert.strictEqual(res.targetFile, "tests/pages/ProductListPage.js");
            assert.strictEqual(res.testFile, "tests/ui/product-list.spec.js");
        });

        // =========================================================================
        // SUITE 5: Patch Syntax, Structural Whitelist & AST Enforcement
        // =========================================================================
        console.log("\n[Suite 5] Patch Syntax & Structural Whitelist Enforcement");

        await runTest("checkSyntaxIntegrity approves valid JS code and rejects syntax errors", () => {
            checkSyntaxIntegrity("class Foo { bar() { return 1; } }");

            assert.throws(() => {
                checkSyntaxIntegrity("class Foo { bar() { return 1;"); // Missing closing brace
            }, /Syntax Error: Patched code is not valid JavaScript/);
        });

        await runTest("checkPermittedLocatorChanges approves locator modifications and rejects arbitrary statements", () => {
            checkPermittedLocatorChanges([
                "    this.heading = this.page.getByRole('heading', { name: 'Products' });",
                "    return this.page.locator('.items');"
            ]);

            assert.throws(() => {
                checkPermittedLocatorChanges([
                    "    for (let i = 0; i < 100; i++) { doSomething(); }"
                ]);
            }, /Security Violation: Unapproved non-locator change in POM/);
        });

        await runTest("validatePatchAst enforces single-file target matching", () => {
            const currentPom = fs.readFileSync(path.resolve(ROOT_DIR, "tests/pages/ProductListPage.js"), "utf8");
            const headingLine = currentPom.split("\n").find(l => l.includes("this.heading = page.getByRole(")) || '        this.heading = page.getByRole("heading", { level: 1, name: "Products" });';
            const validDiff = [
                "--- a/tests/pages/ProductListPage.js",
                "+++ b/tests/pages/ProductListPage.js",
                "@@ -13,1 +13,1 @@",
                "-" + headingLine,
                "+        this.heading = page.getByRole(\"heading\", { level: 1, name: \"Products Catalog\" });",
                ""
            ].join("\n");

            // Successful validation when target matches
            const result = validatePatchAst(validDiff, "tests/pages/ProductListPage.js");
            assert.strictEqual(result.targetFile, "tests/pages/ProductListPage.js");

            // Mismatched expected target
            assert.throws(() => {
                validatePatchAst(validDiff, "tests/pages/CartPage.js");
            }, /Patch target file 'tests\/pages\/ProductListPage\.js' does not match expected target 'tests\/pages\/CartPage\.js'/);
        });

        await runTest("validatePatchAst rejects multi-file patches", () => {
            const multiFileDiff = [
                "--- a/tests/pages/ProductListPage.js",
                "+++ b/tests/pages/ProductListPage.js",
                "@@ -15,1 +15,1 @@",
                "-        this.heading = 1;",
                "+        this.heading = 2;",
                "--- a/backend/routes/products.js",
                "+++ b/backend/routes/products.js",
                "@@ -1,1 +1,1 @@",
                "-const x = 1;",
                "+const x = 2;",
                ""
            ].join("\n");

            assert.throws(() => {
                validatePatchAst(multiFileDiff, "tests/pages/ProductListPage.js");
            }, /Multiple files targeted in patch/);
        });

        await runTest("validateAstIntegrity approves legitimate POM locator modifications", () => {
            const origCode = fs.readFileSync(path.resolve(ROOT_DIR, "tests/pages/ProductListPage.js"), "utf8");
            const patchedCode = origCode.replace(
                /this\.heading\s*=\s*page\.getByRole\("heading",\s*\{[^}]+\}\);/,
                'this.heading = page.getByRole("heading", { level: 1, name: "Products Catalog" });'
            );
            assert.strictEqual(validateAstIntegrity(origCode, patchedCode), true);
        });

        await runTest("validateAstIntegrity rejects loop injections (ForStatement, WhileStatement)", () => {
            const origCode = fs.readFileSync(path.resolve(ROOT_DIR, "tests/pages/ProductListPage.js"), "utf8");
            const loopCode = origCode.replace(
                'await this.page.goto("/");',
                'for (let i = 0; i < 10; i++) { await this.page.goto("/"); }'
            );
            assert.throws(() => {
                validateAstIntegrity(origCode, loopCode);
            }, /Security Violation: Forbidden AST node 'ForStatement'/);
        });

        await runTest("validateAstIntegrity rejects assertion injections (expect/assert)", () => {
            const origCode = fs.readFileSync(path.resolve(ROOT_DIR, "tests/pages/ProductListPage.js"), "utf8");
            const assertCode = origCode.replace(
                'await this.page.goto("/");',
                'expect(true).toBe(true); await this.page.goto("/");'
            );
            assert.throws(() => {
                validateAstIntegrity(origCode, assertCode);
            }, /Security Violation: Forbidden function call 'expect\(\)' detected in AST/);
        });

        await runTest("validateAstIntegrity rejects dynamic code execution (eval/Function)", () => {
            const origCode = fs.readFileSync(path.resolve(ROOT_DIR, "tests/pages/ProductListPage.js"), "utf8");
            const evalCode = origCode.replace(
                'await this.page.goto("/");',
                'eval("console.log(1)"); await this.page.goto("/");'
            );
            assert.throws(() => {
                validateAstIntegrity(origCode, evalCode);
            }, /Security Violation: Forbidden function call 'eval\(\)' detected in AST/);
        });

        await runTest("validateAstIntegrity rejects method renaming, removal, or param modifications", () => {
            const origCode = fs.readFileSync(path.resolve(ROOT_DIR, "tests/pages/ProductListPage.js"), "utf8");
            const renamedMethod = origCode.replace("getProductNameHeading(productName)", "getProductHeading(productName)");
            assert.throws(() => {
                validateAstIntegrity(origCode, renamedMethod);
            }, /Security Violation: Method #3 renamed/);

            const modifiedParams = origCode.replace("getProductNameHeading(productName)", "getProductNameHeading(productName, extraParam)");
            assert.throws(() => {
                validateAstIntegrity(origCode, modifiedParams);
            }, /Security Violation: Method 'getProductNameHeading' parameter count modified/);
        });

        await runTest("validateAstIntegrity rejects unapproved non-locator statements inside methods", () => {
            const origCode = fs.readFileSync(path.resolve(ROOT_DIR, "tests/pages/ProductListPage.js"), "utf8");
            const rogueStmt = origCode.replace(
                /this\.heading\s*=\s*page\.getByRole\("heading",\s*\{[^}]+\}\);/,
                'this.heading = "not a locator call";'
            );
            assert.throws(() => {
                validateAstIntegrity(origCode, rogueStmt);
            }, /Security Violation: Expected a Playwright locator CallExpression|Security Violation: Unapproved non-locator assignment/);
        });

        await runTest("Adversarial AST: Rejects nested callbacks in locator argument", () => {
            const origCode = fs.readFileSync(path.resolve(ROOT_DIR, "tests/pages/ProductListPage.js"), "utf8");
            const callbackAttack = origCode.replace(
                /this\.heading\s*=\s*page\.getByRole\("heading",\s*\{[^}]+\}\);/,
                'this.heading = page.locator(".card", () => { process.exit(1); });'
            );
            assert.throws(() => {
                validateAstIntegrity(origCode, callbackAttack);
            }, /Security Violation/);
        });

        await runTest("Adversarial AST: Rejects computed property expressions in locator options", () => {
            const origCode = fs.readFileSync(path.resolve(ROOT_DIR, "tests/pages/ProductListPage.js"), "utf8");
            const computedAttack = origCode.replace(
                /this\.heading\s*=\s*page\.getByRole\("heading",\s*\{[^}]+\}\);/,
                'this.heading = page.getByRole("heading", { ["na" + "me"]: "Products" });'
            );
            assert.throws(() => {
                validateAstIntegrity(origCode, computedAttack);
            }, /Security Violation: Computed property keys in locator options are strictly prohibited/);
        });

        await runTest("Adversarial AST: Rejects unexpected property access in locator argument", () => {
            const origCode = fs.readFileSync(path.resolve(ROOT_DIR, "tests/pages/ProductListPage.js"), "utf8");
            const propAttack = origCode.replace(
                /this\.heading\s*=\s*page\.getByRole\("heading",\s*\{[^}]+\}\);/,
                'this.heading = page.locator(process.env.SECRET);'
            );
            assert.throws(() => {
                validateAstIntegrity(origCode, propAttack);
            }, /Security Violation: Forbidden expression type 'MemberExpression'/);
        });

        await runTest("Adversarial AST: Rejects computed locator receiver access", () => {
            const origCode = fs.readFileSync(path.resolve(ROOT_DIR, "tests/pages/ProductListPage.js"), "utf8");
            const receiverAttack = origCode.replace(
                /this\.heading\s*=\s*page\.getByRole\("heading",\s*\{[^}]+\}\);/,
                'this.heading = page["getByRole"]("heading", { name: "Products" });'
            );
            assert.throws(() => {
                validateAstIntegrity(origCode, receiverAttack);
            }, /Security Violation: Computed property access on locator callee is strictly prohibited/);
        });

        await runTest("Adversarial AST: Rejects executable side effects within locator arguments", () => {
            const origCode = fs.readFileSync(path.resolve(ROOT_DIR, "tests/pages/ProductListPage.js"), "utf8");
            const execAttack = origCode.replace(
                /this\.heading\s*=\s*page\.getByRole\("heading",\s*\{[^}]+\}\);/,
                'this.heading = page.locator(evilFunction());'
            );
            assert.throws(() => {
                validateAstIntegrity(origCode, execAttack);
            }, /Security Violation: Locator call must be invoked on page, this.page, or a chained locator/);
        });

        await runTest("Adversarial AST: Rejects executable side effects within locator options", () => {
            const origCode = fs.readFileSync(path.resolve(ROOT_DIR, "tests/pages/ProductListPage.js"), "utf8");
            const optionExecAttack = origCode.replace(
                /this\.heading\s*=\s*page\.getByRole\("heading",\s*\{[^}]+\}\);/,
                'this.heading = page.getByRole("heading", { name: evilFunction() });'
            );
            assert.throws(() => {
                validateAstIntegrity(origCode, optionExecAttack);
            }, /Security Violation: Locator call must be invoked on page, this.page, or a chained locator/);
        });

        await runTest("Adversarial AST: Rejects sequence and assignment expressions in locator arguments", () => {
            const origCode = fs.readFileSync(path.resolve(ROOT_DIR, "tests/pages/ProductListPage.js"), "utf8");
            const seqAttack = origCode.replace(
                /this\.heading\s*=\s*page\.getByRole\("heading",\s*\{[^}]+\}\);/,
                'this.heading = page.locator((1, ".card"));'
            );
            assert.throws(() => {
                validateAstIntegrity(origCode, seqAttack);
            }, /Security Violation:.*SequenceExpression/);
        });

        await runTest("Adversarial AST: Rejects unauthorized identifiers in locator options", () => {
            const origCode = fs.readFileSync(path.resolve(ROOT_DIR, "tests/pages/ProductListPage.js"), "utf8");
            const identAttack = origCode.replace(
                /this\.heading\s*=\s*page\.getByRole\("heading",\s*\{[^}]+\}\);/,
                'this.heading = page.getByRole("heading", { name: unauthorizedGlobalVar });'
            );
            assert.throws(() => {
                validateAstIntegrity(origCode, identAttack);
            }, /Security Violation: Unauthorized identifier 'unauthorizedGlobalVar'/);
        });

        await runTest("Positive AST: Approves CSS selectors with attribute brackets and combinators", () => {
            const origCode = fs.readFileSync(path.resolve(ROOT_DIR, "tests/pages/ProductListPage.js"), "utf8");
            const cssPatch = origCode.replace(
                /this\.heading\s*=\s*page\.getByRole\("heading",\s*\{[^}]+\}\);/,
                'this.heading = page.locator("h1.catalog-title[data-qa=\'products-heading\']");'
            );
            assert.doesNotThrow(() => {
                validateAstIntegrity(origCode, cssPatch);
            });
        });

        await runTest("Positive AST: Approves accessible role with role names, levels, accessible names, regex, and exact flags", () => {
            const origCode = fs.readFileSync(path.resolve(ROOT_DIR, "tests/pages/ProductListPage.js"), "utf8");
            const rolePatch = origCode.replace(
                /this\.heading\s*=\s*page\.getByRole\("heading",\s*\{[^}]+\}\);/,
                'this.heading = page.getByRole("heading", { level: 1, name: /products catalog/i, exact: true });'
            );
            assert.doesNotThrow(() => {
                validateAstIntegrity(origCode, rolePatch);
            });
        });

        await runTest("Positive AST: Approves getByTestId locators", () => {
            const origCode = fs.readFileSync(path.resolve(ROOT_DIR, "tests/pages/ProductListPage.js"), "utf8");
            const testIdPatch = origCode.replace(
                /this\.heading\s*=\s*page\.getByRole\("heading",\s*\{[^}]+\}\);/,
                'this.heading = page.getByTestId("catalog-page-header");'
            );
            assert.doesNotThrow(() => {
                validateAstIntegrity(origCode, testIdPatch);
            });
        });

        await runTest("Positive AST: Approves getByPlaceholder locators", () => {
            const origCode = fs.readFileSync(path.resolve(ROOT_DIR, "tests/pages/ProductListPage.js"), "utf8");
            const placeholderPatch = origCode.replace(
                /this\.heading\s*=\s*page\.getByRole\("heading",\s*\{[^}]+\}\);/,
                'this.heading = page.getByPlaceholder("Search catalog products...");'
            );
            assert.doesNotThrow(() => {
                validateAstIntegrity(origCode, placeholderPatch);
            });
        });

        await runTest("Positive AST: Approves getByLabel, getByTitle, and getByAltText locators", () => {
            const origCode = fs.readFileSync(path.resolve(ROOT_DIR, "tests/pages/ProductListPage.js"), "utf8");
            const labelPatch = origCode.replace(
                /this\.heading\s*=\s*page\.getByRole\("heading",\s*\{[^}]+\}\);/,
                'this.heading = page.getByLabel("Catalog Header Section");'
            );
            assert.doesNotThrow(() => {
                validateAstIntegrity(origCode, labelPatch);
            });
        });

        await runTest("Positive AST: Approves supported locator chaining (.filter, .first, .last, .nth)", () => {
            const origCode = fs.readFileSync(path.resolve(ROOT_DIR, "tests/pages/ProductListPage.js"), "utf8");
            const chainPatch = origCode.replace(
                /this\.heading\s*=\s*page\.getByRole\("heading",\s*\{[^}]+\}\);/,
                'this.heading = page.locator(".card-container").filter({ hasText: "Catalog" }).first();'
            );
            assert.doesNotThrow(() => {
                validateAstIntegrity(origCode, chainPatch);
            });
        });

        await runTest("Positive AST: Approves supported nested locator filter", () => {
            const origCode = fs.readFileSync(path.resolve(ROOT_DIR, "tests/pages/ProductListPage.js"), "utf8");
            const nestedPatch = origCode.replace(
                /this\.heading\s*=\s*page\.getByRole\("heading",\s*\{[^}]+\}\);/,
                'this.heading = page.locator(".product-item").filter({ has: page.getByRole("heading", { name: "Featured" }) });'
            );
            assert.doesNotThrow(() => {
                validateAstIntegrity(origCode, nestedPatch);
            });
        });

        await runTest("Positive AST: Approves method returning parameterized locator", () => {
            const origCode = fs.readFileSync(path.resolve(ROOT_DIR, "tests/pages/ProductListPage.js"), "utf8");
            const paramPatch = origCode.replace(
                'return this.page.locator(`text=${productName}`);',
                'return this.page.locator(".product-card").filter({ hasText: productName });'
            );
            assert.doesNotThrow(() => {
                validateAstIntegrity(origCode, paramPatch);
            });
        });

        // =========================================================================
        // SUITE 6: Generate-Only & Validation Flow Guards
        // =========================================================================
        console.log("\n[Suite 6] Generate-Only Mode & Validation Flow Guards");

        await runTest("runRepairAgent in generate-only mode writes patch without executing tests", async () => {
            const mockModel = {
                async generateContent() {
                    const pomOnDisk = fs.readFileSync(path.resolve(ROOT_DIR, "tests/pages/ProductListPage.js"), "utf8");
                    const locMatch = pomOnDisk.match(/this\.heading\s*=\s*(page\.getByRole\([^;]+\));/);
                    const origLoc = locMatch ? locMatch[1] : 'page.getByRole("heading", { level: 1, name: "Products" })';
                    return {
                        canHeal: true,
                        rootCause: "STALE_LOCATOR",
                        diagnosis: "Products heading renamed",
                        targetFile: "tests/pages/ProductListPage.js",
                        originalLocator: origLoc,
                        healedLocator: "page.getByRole(\"heading\", { level: 1, name: \"Products Catalog\" })"
                    };
                }
            };

            const outputSandbox = path.resolve(TEST_SANDBOX, "generate-out");
            const res = await runRepairAgent({
                contextPath: sampleContextPath,
                evidencePath: sampleEvidencePath,
                generateOnly: true,
                repairDir: outputSandbox,
                modelClient: mockModel,
                requireEvidence: true
            });

            assert.strictEqual(res.status, "GENERATED");
            assert.strictEqual(res.canHeal, true);
            assert.strictEqual(res.targetFile, "tests/pages/ProductListPage.js");
            assert(fs.existsSync(path.resolve(outputSandbox, "repair.patch")));
            assert(fs.existsSync(path.resolve(outputSandbox, "repair-summary.json")));
        });

        await runTest("runRepairAgent sets canHeal=false when model abstains or detects application defect", async () => {
            const mockDefectModel = {
                async generateContent() {
                    return {
                        canHeal: false,
                        rootCause: "APPLICATION_DEFECT",
                        diagnosis: "Missing products in catalog API",
                        evidenceObserved: "EMPTY_DOM"
                    };
                }
            };

            const outputSandbox = path.resolve(TEST_SANDBOX, "abstain-out");
            const res = await runRepairAgent({
                contextPath: sampleContextPath,
                evidencePath: sampleEvidencePath,
                generateOnly: true,
                repairDir: outputSandbox,
                modelClient: mockDefectModel,
                requireEvidence: true
            });

            assert.strictEqual(res.status, "ABSTAINED");
            assert.strictEqual(res.rootCause, "APPLICATION_DEFECT");
            assert(!fs.existsSync(path.resolve(outputSandbox, "repair.patch")));
        });

        await runTest("Generation gate: Rejects validation if AST check fails after model generation", async () => {
            const maliciousModel = {
                async generateContent() {
                    return {
                        canHeal: true,
                        rootCause: "STALE_LOCATOR",
                        diagnosis: "Products heading renamed",
                        targetFile: "tests/pages/ProductListPage.js",
                        originalLocator: "page.getByRole(\"heading\", { level: 1, name: \"Products\" })",
                        healedLocator: "eval(\"exploit()\")"
                    };
                }
            };

            const outputSandbox = path.resolve(TEST_SANDBOX, "malicious-out");
            const res = await runRepairAgent({
                contextPath: sampleContextPath,
                evidencePath: sampleEvidencePath,
                generateOnly: true,
                repairDir: outputSandbox,
                modelClient: maliciousModel,
                requireEvidence: true
            });

            assert.strictEqual(res.status, "REJECTED");
            assert.strictEqual(res.reason, "SECURITY_VIOLATION");
            assert(!fs.existsSync(path.resolve(outputSandbox, "repair.patch")));
        });

        await runTest("Validation report correctly flags skipped, cancelled, or failed tiers and never marks them as passed", () => {
            const formatTier = (status) => {
                if (status === "success") return "✅ PASSED";
                if (status === "failure") return "❌ FAILED";
                if (status === "cancelled") return "⏹️ CANCELLED";
                return "⚠️ " + (status || "SKIPPED").toUpperCase();
            };

            assert.strictEqual(formatTier("success"), "✅ PASSED");
            assert.strictEqual(formatTier("failure"), "❌ FAILED");
            assert.strictEqual(formatTier("cancelled"), "⏹️ CANCELLED");
            assert.strictEqual(formatTier("skipped"), "⚠️ SKIPPED");
            assert.strictEqual(formatTier(undefined), "⚠️ SKIPPED");

            const isSuccess = (t1, t2, t3, job) => t1 === "success" && t2 === "success" && t3 === "success" && job === "success";
            assert.strictEqual(isSuccess("success", "success", "success", "success"), true);
            assert.strictEqual(isSuccess("failure", "skipped", "skipped", "failure"), false);
            assert.strictEqual(isSuccess("success", "failure", "skipped", "failure"), false);
            assert.strictEqual(isSuccess("success", "success", "skipped", "failure"), false);
            assert.strictEqual(isSuccess("success", "success", "success", "failure"), false);
        });

        // Artifact layout & missing-patch resolution tests
        await runTest("resolveCandidatePatch resolves valid flat layout with repair.patch and repair-summary.json", () => {
            const flatDir = path.resolve(TEST_SANDBOX, "flat-artifact");
            fs.mkdirSync(flatDir, { recursive: true });
            fs.writeFileSync(path.resolve(flatDir, "repair.patch"), "--- a/pom.js\n+++ b/pom.js\n@@ -1 +1 @@\n-old\n+new\n", "utf8");
            fs.writeFileSync(path.resolve(flatDir, "repair-summary.json"), JSON.stringify({ status: "GENERATED" }), "utf8");

            const res = resolveCandidatePatch(flatDir);
            assert.strictEqual(res.patchPath, path.resolve(flatDir, "repair.patch"));
            assert.strictEqual(res.summaryPath, path.resolve(flatDir, "repair-summary.json"));
            assert.ok(res.size > 0);
        });

        await runTest("resolveCandidatePatch normalizes nested candidate-output artifact layout to candidateDir root", () => {
            const nestedDir = path.resolve(TEST_SANDBOX, "nested-artifact");
            const subDir = path.resolve(nestedDir, "candidate-output");
            fs.mkdirSync(subDir, { recursive: true });
            fs.writeFileSync(path.resolve(subDir, "repair.patch"), "--- a/pom.js\n+++ b/pom.js\n@@ -1 +1 @@\n-old\n+new\n", "utf8");
            fs.writeFileSync(path.resolve(subDir, "repair-summary.json"), JSON.stringify({ status: "GENERATED" }), "utf8");

            const res = resolveCandidatePatch(nestedDir);
            assert.strictEqual(res.patchPath, path.resolve(nestedDir, "repair.patch"));
            assert.ok(fs.existsSync(path.resolve(nestedDir, "repair.patch")), "Patch must be normalized to root");
            assert.ok(fs.existsSync(path.resolve(nestedDir, "repair-summary.json")), "Summary must be normalized to root");
            assert.ok(res.size > 0);
        });

        await runTest("resolveCandidatePatch fails clearly when repair.patch is missing (PATCH_MISSING)", () => {
            const missingDir = path.resolve(TEST_SANDBOX, "missing-artifact");
            fs.mkdirSync(missingDir, { recursive: true });

            assert.throws(() => {
                resolveCandidatePatch(missingDir);
            }, /Candidate patch missing: Expected patch file at/);
        });

        await runTest("resolveCandidatePatch fails clearly when repair.patch is empty (0 bytes) (PATCH_EMPTY)", () => {
            const emptyDir = path.resolve(TEST_SANDBOX, "empty-artifact");
            fs.mkdirSync(emptyDir, { recursive: true });
            fs.writeFileSync(path.resolve(emptyDir, "repair.patch"), "", "utf8");

            assert.throws(() => {
                resolveCandidatePatch(emptyDir);
            }, /Candidate patch is empty \(0 bytes\)/);
        });

        await runTest("resolveCandidatePatch fails clearly when candidate directory does not exist", () => {
            assert.throws(() => {
                resolveCandidatePatch(path.resolve(TEST_SANDBOX, "non-existent-candidate-dir"));
            }, /Candidate directory does not exist/);
        });

        console.log(`\n============================================================`);
        console.log(`All Phase 3B.4A Maintainer Repair Tests Passed! (${passed}/${total} tests passed)`);
        console.log(`============================================================\n`);

    } finally {
        teardownSandbox();
    }
}

if (require.main === module) {
    runAll().catch((err) => {
        console.error("Test execution terminated with error:", err);
        process.exit(1);
    });
}

module.exports = { runAll };

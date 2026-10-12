/**
 * @file verify-ci-metadata.js
 * @description Verifies GitHub CI run metadata, PR integrity, artifact lineage, and target POM existence.
 *
 * Enforces mandatory safeguards for Maintainer AI Repair (Phase 3B.4A):
 * 1. Validates inputs before usage (avoids shell interpolation).
 * 2. Queries GitHub API (via gh CLI or pluggable client) to confirm run conclusion is 'failure',
 *    head SHA matches source_commit, and event is permitted.
 * 3. Confirms PR integrity: open status, target base branch, and verifies PR head has not mutated.
 * 4. Verifies artifact lineage and freshness (<24h), rejecting mismatched or stale context.
 * 5. Dynamically derives target POM and verifies its physical existence at source_commit.
 */

const fs = require("fs");
const path = require("path");
const { execFileSync } = require("child_process");

const ROOT_DIR = path.resolve(__dirname, "..");
const APPROVED_TARGET_DIR = path.resolve(ROOT_DIR, "tests/pages");

/**
 * Validates git ref name syntax.
 */
function isValidGitRef(ref) {
    if (!ref || typeof ref !== "string") return false;
    const trimmed = ref.trim();
    if (trimmed.length === 0 || trimmed.length > 255) return false;
    if (!/^[a-zA-Z0-9_\-\./]+$/.test(trimmed)) return false;
    if (trimmed.startsWith("/") || trimmed.endsWith("/") || trimmed.startsWith("-") || trimmed.startsWith(".")) return false;
    if (trimmed.endsWith(".lock")) return false;
    if (trimmed === "HEAD") return false;
    if (/\.\./.test(trimmed)) return false;
    if (/\/\//.test(trimmed)) return false;
    if (/@\{/.test(trimmed)) return false;
    return true;
}

/**
 * Validates target POM path and confines it to tests/pages/*.js.
 */
function validateTargetPomPath(targetRel) {
    if (!targetRel || typeof targetRel !== "string") {
        throw new Error("Target POM path must be a non-empty string.");
    }
    if (targetRel.includes("..") || path.isAbsolute(targetRel)) {
        throw new Error(`Path traversal rejected: '${targetRel}'.`);
    }
    const normalized = path.normalize(targetRel).replace(/\\/g, "/");
    if (!normalized.startsWith("tests/pages/") || !normalized.endsWith(".js")) {
        throw new Error(`Target POM must reside in tests/pages/*.js. Rejected: '${targetRel}'.`);
    }
    return normalized;
}

/**
 * Validates test spec path and confines it strictly to tests/ui/*.spec.(js|ts).
 */
function validateTestSpecPath(testRel) {
    if (!testRel || typeof testRel !== "string") {
        throw new Error("Test spec path must be a non-empty string.");
    }
    if (testRel.includes("..") || path.isAbsolute(testRel)) {
        throw new Error(`Path traversal rejected: '${testRel}'.`);
    }
    const normalized = path.normalize(testRel).replace(/\\/g, "/");
    if (!/^tests\/ui\/[a-zA-Z0-9_\-]+\.spec\.(js|ts)$/.test(normalized)) {
        throw new Error(`Tier 1 UI test spec must reside directly under 'tests/ui/*.spec.(js|ts)'. Rejected: '${testRel}'.`);
    }
    return normalized;
}

/**
 * Default GitHub API runner via gh CLI with argument array (no shell interpolation).
 */
function defaultGhClient({ command, args = [] }) {
    try {
        const stdout = execFileSync("gh", [command, ...args], {
            cwd: ROOT_DIR,
            encoding: "utf8",
            stdio: ["ignore", "pipe", "pipe"]
        });
        return JSON.parse(stdout);
    } catch (err) {
        throw new Error(`GitHub CLI error (${command} ${args.join(" ")}): ${err.stderr || err.message}`);
    }
}

/**
 * Verifies CI run metadata, PR integrity, and failure artifacts.
 */
function verifyCiMetadata(options = {}) {
    const {
        ciRunId,
        sourceCommit,
        prNumber,
        baseBranch = "main",
        expectedRepo = process.env.GITHUB_REPOSITORY,
        contextPath,
        evidencePath,
        rootDir = ROOT_DIR,
        maxAgeHours = 24,
        apiClient = defaultGhClient,
        gitRunner = null
    } = options;

    // 1. Strict Input Validation
    if (!ciRunId || !/^\d+$/.test(String(ciRunId).trim())) {
        return {
            valid: false,
            error: "INVALID_INPUT",
            message: `ci_run_id must contain digits only. Received: '${ciRunId}'.`
        };
    }
    const cleanRunId = String(ciRunId).trim();

    if (!sourceCommit || !/^[0-9a-fA-F]{40}$/.test(String(sourceCommit).trim())) {
        return {
            valid: false,
            error: "INVALID_INPUT",
            message: `source_commit must be a 40-character hexadecimal SHA. Received: '${sourceCommit}'.`
        };
    }
    const cleanCommitSha = String(sourceCommit).trim().toLowerCase();

    if (prNumber !== undefined && prNumber !== null && String(prNumber).trim() !== "") {
        if (!/^\d+$/.test(String(prNumber).trim())) {
            return {
                valid: false,
                error: "INVALID_INPUT",
                message: `pr_number must contain digits only. Received: '${prNumber}'.`
            };
        }
    }
    const cleanPrNumber = prNumber ? String(prNumber).trim() : null;

    if (!isValidGitRef(baseBranch)) {
        return {
            valid: false,
            error: "INVALID_INPUT",
            message: `base_branch is not a valid git reference name: '${baseBranch}'.`
        };
    }

    if (!contextPath || typeof contextPath !== "string") {
        return {
            valid: false,
            error: "INVALID_INPUT",
            message: "Explicit contextPath must be provided. Falling back to workspace defaults is prohibited."
        };
    }

    if (!evidencePath || typeof evidencePath !== "string") {
        return {
            valid: false,
            error: "INVALID_INPUT",
            message: "Explicit evidencePath must be provided. Falling back to workspace defaults is prohibited."
        };
    }

    // 2. Verify GitHub API CI Run Metadata
    let runMetadata;
    try {
        runMetadata = apiClient({
            command: "run",
            args: ["view", cleanRunId, "--json", "headSha,status,conclusion,event,databaseId,attempt,headRepository"]
        });
    } catch (err) {
        return {
            valid: false,
            error: "CI_RUN_QUERY_ERROR",
            message: `Failed to query CI run #${cleanRunId} from GitHub API: ${err.message}`
        };
    }

    if (!runMetadata || typeof runMetadata !== "object") {
        return {
            valid: false,
            error: "CI_RUN_NOT_FOUND",
            message: `CI run #${cleanRunId} was not found on GitHub.`
        };
    }

    // Run conclusion check
    if (runMetadata.conclusion !== "failure") {
        return {
            valid: false,
            error: "RUN_NOT_FAILED",
            message: `CI run #${cleanRunId} conclusion is '${runMetadata.conclusion}', expected 'failure'. AI repair is only permitted for failed runs.`
        };
    }

    // Run status check
    if (runMetadata.status !== "completed") {
        return {
            valid: false,
            error: "RUN_NOT_COMPLETED",
            message: `CI run #${cleanRunId} status is '${runMetadata.status}', expected 'completed'.`
        };
    }

    // Repository check against GitHub API run metadata
    if (expectedRepo && runMetadata.headRepository && runMetadata.headRepository.nameWithOwner) {
        const cleanExpectedRepo = expectedRepo.trim().toLowerCase();
        const runRepo = runMetadata.headRepository.nameWithOwner.trim().toLowerCase();
        if (runRepo !== cleanExpectedRepo) {
            return {
                valid: false,
                error: "REPOSITORY_MISMATCH",
                message: `CI run repository (${runMetadata.headRepository.nameWithOwner}) does not match expected repository (${expectedRepo}).`
            };
        }
    }

    // Source commit matching against CI run (Event-Specific)
    const runEvent = (runMetadata.event || "").toLowerCase();
    const isPrEvent = runEvent === "pull_request" || runEvent === "pull_request_target";
    const runHeadSha = (runMetadata.headSha || "").toLowerCase();

    if (!isPrEvent) {
        // For non-PR runs (workflow_dispatch, push): run headSha must strictly match source_commit
        if (runHeadSha !== cleanCommitSha) {
            return {
                valid: false,
                error: "COMMIT_SHA_MISMATCH",
                message: `For non-PR run (event: '${runEvent}'), CI run head SHA (${runHeadSha}) must strictly match source_commit (${cleanCommitSha}).`
            };
        }
    } else {
        // For pull_request runs:
        // In GitHub API, run headSha is the PR head SHA (cleanCommitSha) or the tested merge commit.
        let isPrRunShaValid = (runHeadSha === cleanCommitSha);
        if (!isPrRunShaValid && contextPath) {
            const resolvedContext = path.isAbsolute(contextPath) ? contextPath : path.resolve(rootDir, contextPath);
            if (fs.existsSync(resolvedContext)) {
                try {
                    const ctx = JSON.parse(fs.readFileSync(resolvedContext, "utf8"));
                    const ctxMerge = (ctx.mergeSha || "").toLowerCase();
                    const ctxTested = (ctx.commitSha || "").toLowerCase();
                    const ctxHead = (ctx.headSha || "").toLowerCase();
                    // A merge run is valid only if runHeadSha matches the recorded merge commit,
                    // and the context headSha matches source_commit
                    if (ctxMerge && (runHeadSha === ctxMerge || runHeadSha === ctxTested) && ctxHead === cleanCommitSha) {
                        isPrRunShaValid = true;
                    }
                } catch {
                    // Ignore parse error here; subsequent artifact checks will catch it
                }
            }
        }

        if (!isPrRunShaValid) {
            return {
                valid: false,
                error: "COMMIT_SHA_MISMATCH",
                message: `CI run head SHA (${runHeadSha}) does not match PR head (${cleanCommitSha}) or tested merge commit.`
            };
        }
    }

    // Permitted event check
    const permittedEvents = new Set(["pull_request", "pull_request_target", "workflow_dispatch", "push"]);
    if (runMetadata.event && !permittedEvents.has(runMetadata.event)) {
        return {
            valid: false,
            error: "UNSUPPORTED_EVENT",
            message: `CI run triggered by unsupported event '${runMetadata.event}'. Permitted events: ${Array.from(permittedEvents).join(", ")}.`
        };
    }

    // 3. Verify PR Integrity (when prNumber provided)
    let prMetadata = null;
    if (cleanPrNumber) {
        try {
            prMetadata = apiClient({
                command: "pr",
                args: ["view", cleanPrNumber, "--json", "headRefOid,headRefName,baseRefName,state"]
            });
        } catch (err) {
            return {
                valid: false,
                error: "PR_QUERY_ERROR",
                message: `Failed to query PR #${cleanPrNumber} from GitHub API: ${err.message}`
            };
        }

        if (prMetadata.state !== "OPEN") {
            return {
                valid: false,
                error: "PR_NOT_OPEN",
                message: `PR #${cleanPrNumber} state is '${prMetadata.state}', expected 'OPEN'. Cannot repair closed or merged PRs.`
            };
        }

        const prHeadSha = (prMetadata.headRefOid || "").toLowerCase();
        if (prHeadSha !== cleanCommitSha) {
            return {
                valid: false,
                error: "PR_HEAD_MUTATED",
                message: `PR #${cleanPrNumber} head has mutated! Current head is ${prHeadSha}, but failure occurred at ${cleanCommitSha}. Evidence is obsolete.`
            };
        }

        if (prMetadata.baseRefName !== baseBranch) {
            return {
                valid: false,
                error: "PR_BASE_MISMATCH",
                message: `PR #${cleanPrNumber} base branch is '${prMetadata.baseRefName}', expected '${baseBranch}'.`
            };
        }
    }

    // 4. Verify Failure Context & Evidence Artifacts
    const resolvedContextPath = path.isAbsolute(contextPath) ? contextPath : path.resolve(rootDir, contextPath);
    if (!fs.existsSync(resolvedContextPath)) {
        return {
            valid: false,
            error: "MISSING_ARTIFACTS",
            message: `Failure context file does not exist at '${resolvedContextPath}'. Workspace fallbacks are prohibited.`
        };
    }

    const resolvedEvidencePath = path.isAbsolute(evidencePath) ? evidencePath : path.resolve(rootDir, evidencePath);
    if (!fs.existsSync(resolvedEvidencePath)) {
        return {
            valid: false,
            error: "MISSING_ARTIFACTS",
            message: `Live evidence file does not exist at '${resolvedEvidencePath}'. Workspace fallbacks are prohibited.`
        };
    }

    let contextData;
    try {
        contextData = JSON.parse(fs.readFileSync(resolvedContextPath, "utf8"));
    } catch (err) {
        return {
            valid: false,
            error: "MALFORMED_ARTIFACT",
            message: `Failed to parse failure context JSON: ${err.message}`
        };
    }

    let evidenceData;
    try {
        evidenceData = JSON.parse(fs.readFileSync(resolvedEvidencePath, "utf8"));
    } catch (err) {
        return {
            valid: false,
            error: "MALFORMED_ARTIFACT",
            message: `Failed to parse live evidence JSON: ${err.message}`
        };
    }

    // Evidence completeness
    if (!evidenceData.hasEvidence || (!evidenceData.domSnapshot && !evidenceData.accessibilitySnapshot)) {
        return {
            valid: false,
            error: "INSUFFICIENT_EVIDENCE",
            message: "Live browser evidence snapshot is empty or marked hasEvidence=false. Anti-guessing rule applies."
        };
    }

    // Freshness check (<24h)
    const timestampStr = contextData.timestamp;
    if (!timestampStr || isNaN(new Date(timestampStr).getTime())) {
        return {
            valid: false,
            error: "INVALID_ARTIFACT_TIMESTAMP",
            message: "Failure context lacks a valid ISO timestamp."
        };
    }
    const ageMs = Date.now() - new Date(timestampStr).getTime();
    if (ageMs > maxAgeHours * 3600 * 1000) {
        return {
            valid: false,
            error: "STALE_ARTIFACT",
            message: `Failure context is stale (${Math.round(ageMs / 3600000)}h old, limit is ${maxAgeHours}h). Repair aborted.`
        };
    }

    // Repository check against failure context
    if (expectedRepo && contextData.repository) {
        const cleanExpectedRepo = expectedRepo.trim().toLowerCase();
        if (contextData.repository.trim().toLowerCase() !== cleanExpectedRepo) {
            return {
                valid: false,
                error: "REPOSITORY_MISMATCH",
                message: `Failure context repository (${contextData.repository}) does not match expected repository (${expectedRepo}).`
            };
        }
    }

    // Run attempt check (GitHub CLI exposes 'attempt', whereas contextData records 'runAttempt')
    const currentAttempt = runMetadata.attempt !== undefined ? runMetadata.attempt : runMetadata.runAttempt;
    const contextAttempt = contextData.runAttempt !== undefined ? contextData.runAttempt : contextData.attempt;
    if (currentAttempt !== undefined && contextAttempt !== undefined) {
        if (String(currentAttempt) !== String(contextAttempt)) {
            return {
                valid: false,
                error: "RUN_ATTEMPT_MISMATCH",
                message: `Failure context was generated by run attempt #${contextAttempt}, but CI run is currently on attempt #${currentAttempt}.`
            };
        }
    }

    // 5. Independent Lineage, Revision & Provenance Reconciliation
    if (isPrEvent) {
        // --- INDEPENDENT CHECKS FOR PULL_REQUEST ---
        // Check 1: source_commit equals current PR head SHA in PR API
        if (cleanPrNumber && prMetadata) {
            const currentPrHead = (prMetadata.headRefOid || "").toLowerCase();
            if (currentPrHead !== cleanCommitSha) {
                return {
                    valid: false,
                    error: "PR_HEAD_MUTATED",
                    message: `PR #${cleanPrNumber} head has mutated! Current head is ${currentPrHead}, but failure occurred at ${cleanCommitSha}. Evidence is obsolete.`
                };
            }
        }

        // Check 2: Transient merge guard (source_commit cannot be the merge commit)
        if (contextData.mergeSha && cleanCommitSha === contextData.mergeSha.toLowerCase()) {
            return {
                valid: false,
                error: "MERGE_SHA_REJECTED",
                message: `Requested source_commit matches the transient PR merge commit (${cleanCommitSha}) rather than the PR head commit (${contextData.headSha || "unknown"}). AI repair must target the PR head commit.`
            };
        }

        // Check 3: contextData.headSha equals that same PR head SHA (source_commit)
        if (!contextData.headSha) {
            return {
                valid: false,
                error: "PR_HEAD_MISMATCH",
                message: "Failure context for pull-request run must record headSha, but headSha was missing."
            };
        }
        const contextHead = contextData.headSha.toLowerCase();
        if (contextHead !== cleanCommitSha) {
            return {
                valid: false,
                error: "PR_HEAD_MISMATCH",
                message: `Failure context head SHA (${contextHead}) does not match requested source_commit (${cleanCommitSha}).`
            };
        }

        // Check 4: contextData.commitSha equals actual tested revision recorded by diagnostic workflow
        if (!contextData.commitSha) {
            return {
                valid: false,
                error: "CONTEXT_SHA_MISMATCH",
                message: "Failure context must record tested commitSha."
            };
        }
        const contextTested = contextData.commitSha.toLowerCase();

        // Check 5: For a pull-request merge run, contextData.mergeSha equals the tested merge revision
        if (contextData.mergeSha) {
            const expectedMerge = contextData.mergeSha.toLowerCase();
            if (contextTested !== expectedMerge) {
                return {
                    valid: false,
                    error: "CONTEXT_SHA_MISMATCH",
                    message: `For a PR merge run, tested commitSha (${contextTested}) must match recorded mergeSha (${expectedMerge}).`
                };
            }
        } else {
            // Non-merge PR run (tested head directly): tested commit must equal PR head
            if (contextTested !== cleanCommitSha) {
                return {
                    valid: false,
                    error: "CONTEXT_SHA_MISMATCH",
                    message: `Failure context tested commit (${contextTested}) does not match PR head (${cleanCommitSha}).`
                };
            }
        }
    } else {
        // --- INDEPENDENT CHECKS FOR WORKFLOW_DISPATCH / PUSH (NON-PR) ---
        // Check 1: No PR number allowed on non-PR runs
        if (cleanPrNumber) {
            return {
                valid: false,
                error: "EVENT_MISMATCH",
                message: `Cannot specify pr_number (#${cleanPrNumber}) for a non-PR run (event: '${runEvent}').`
            };
        }

        // Check 2: contextData.commitSha must equal source_commit
        if (!contextData.commitSha || contextData.commitSha.toLowerCase() !== cleanCommitSha) {
            return {
                valid: false,
                error: "CONTEXT_SHA_MISMATCH",
                message: `For non-PR run, context commitSha (${contextData.commitSha}) must strictly match source_commit (${cleanCommitSha}).`
            };
        }

        // Check 3: Non-PR run must not record a synthetic mergeSha
        if (contextData.mergeSha) {
            return {
                valid: false,
                error: "CONTEXT_SHA_MISMATCH",
                message: `Non-PR run (${runEvent}) must not record a synthetic mergeSha (${contextData.mergeSha}).`
            };
        }
    }

    // Check stamped runId in context (if present)
    if (contextData.runId && String(contextData.runId) !== cleanRunId) {
        return {
            valid: false,
            error: "CONTEXT_RUN_MISMATCH",
            message: `Failure context was generated by run #${contextData.runId}, but requested ci_run_id is #${cleanRunId}.`
        };
    }

    // 5. Dynamic Target POM Derivation & Physical Existence at source_commit
    const primaryFailure = (contextData.failures && contextData.failures[0]) || {};
    let targetPomRel = primaryFailure.targetFile || null;

    if (!targetPomRel && primaryFailure.specFile) {
        const specRel = primaryFailure.specFile;
        const specAbs = path.isAbsolute(specRel) ? specRel : path.resolve(rootDir, specRel);
        if (fs.existsSync(specAbs)) {
            try {
                const specCode = fs.readFileSync(specAbs, "utf8");
                const match = specCode.match(/(?:require\(|from\s+)["'][^"']*\/pages\/([a-zA-Z0-9_\-]+Page)(?:\.js)?["']/);
                if (match) targetPomRel = `tests/pages/${match[1]}.js`;
            } catch { /* ignore */ }
        }
    }

    if (!targetPomRel) {
        targetPomRel = "tests/pages/ProductListPage.js";
    }

    let sanitizedTargetPom;
    try {
        sanitizedTargetPom = validateTargetPomPath(targetPomRel);
    } catch (err) {
        return {
            valid: false,
            error: "INVALID_TARGET_POM",
            message: err.message
        };
    }

    // Verify target POM physically exists at source_commit
    const checkGitExists = gitRunner || ((commit, file) => {
        try {
            execFileSync("git", ["cat-file", "-e", `${commit}:${file}`], {
                cwd: rootDir,
                stdio: ["ignore", "ignore", "ignore"]
            });
            return true;
        } catch {
            return false;
        }
    });

    if (!checkGitExists(cleanCommitSha, sanitizedTargetPom)) {
        return {
            valid: false,
            error: "TARGET_NOT_AT_SOURCE_COMMIT",
            message: `Derived target POM '${sanitizedTargetPom}' does not physically exist at source_commit ${cleanCommitSha}.`
        };
    }

    const rawTestSpec = primaryFailure.specFile || primaryFailure.testFile || "tests/ui/product-list.spec.js";
    let sanitizedTestSpec;
    try {
        sanitizedTestSpec = validateTestSpecPath(rawTestSpec);
    } catch (err) {
        return {
            valid: false,
            error: "INVALID_TEST_SPEC",
            message: err.message
        };
    }

    // Verify Tier 1 UI test spec physically exists at source_commit
    if (!checkGitExists(cleanCommitSha, sanitizedTestSpec)) {
        return {
            valid: false,
            error: "TEST_SPEC_NOT_AT_SOURCE_COMMIT",
            message: `Primary UI test spec '${sanitizedTestSpec}' does not physically exist at source_commit ${cleanCommitSha}.`
        };
    }

    return {
        valid: true,
        ciRunId: cleanRunId,
        sourceCommit: cleanCommitSha,
        prNumber: cleanPrNumber,
        headRefName: prMetadata ? prMetadata.headRefName : null,
        baseBranch,
        targetFile: sanitizedTargetPom,
        testFile: sanitizedTestSpec,
        failingLocator: primaryFailure.targetLocator || null,
        testTitle: primaryFailure.testTitle || "Unknown Test",
        runAttempt: currentAttempt !== undefined ? Number(currentAttempt) : undefined,
        context: contextData,
        evidence: evidenceData
    };
}

// CLI Execution Entry Point
if (require.main === module) {
    const args = process.argv.slice(2);
    const getArg = (flag) => {
        const idx = args.indexOf(flag);
        return idx !== -1 && args[idx + 1] ? args[idx + 1] : undefined;
    };

    const ciRunId = getArg("--run-id") || process.env.CI_RUN_ID;
    const sourceCommit = getArg("--commit") || process.env.SOURCE_COMMIT;
    const prNumber = getArg("--pr") || process.env.PR_NUMBER;
    const baseBranch = getArg("--base-branch") || process.env.BASE_BRANCH || "main";
    const contextPath = getArg("--context") || process.env.CONTEXT_PATH;
    const evidencePath = getArg("--evidence") || process.env.EVIDENCE_PATH;

    console.log("=== Verifying CI Run Metadata, PR Integrity & Artifact Lineage ===");
    console.log(`Run ID:        ${ciRunId}`);
    console.log(`Source Commit: ${sourceCommit}`);
    console.log(`PR Number:     ${prNumber || "N/A"}`);
    console.log(`Base Branch:   ${baseBranch}`);
    console.log(`Context:       ${contextPath}`);
    console.log(`Evidence:      ${evidencePath}\n`);

    const result = verifyCiMetadata({
        ciRunId,
        sourceCommit,
        prNumber,
        baseBranch,
        contextPath,
        evidencePath
    });

    if (!result.valid) {
        console.error(`::error::Metadata Verification Failed [${result.error}]: ${result.message}`);
        if (process.env.GITHUB_OUTPUT) {
            try {
                fs.appendFileSync(process.env.GITHUB_OUTPUT, `valid=false\nerror=${result.error}\n`, "utf8");
            } catch { /* ignore */ }
        }
        process.exit(1);
    }

    console.log("✓ CI Run Metadata Verified (Conclusion: failure, SHA matches)");
    if (result.prNumber) {
        console.log(`✓ PR #${result.prNumber} Integrity Verified (OPEN, Head matches source_commit)`);
    }
    console.log(`✓ Artifact Lineage & Freshness Verified (<24h, DOM/A11y attached)`);
    console.log(`✓ Target POM Verified at source_commit: ${result.targetFile}`);
    console.log(`✓ Primary Test Spec: ${result.testFile}`);

    if (process.env.GITHUB_OUTPUT) {
        const outputs = [
            `valid=true`,
            `ci_run_id=${result.ciRunId}`,
            `source_commit=${result.sourceCommit}`,
            `pr_number=${result.prNumber || ""}`,
            `head_branch=${result.headRefName || ""}`,
            `target_file=${result.targetFile}`,
            `test_file=${result.testFile}`,
            `failing_locator=${(result.failingLocator || "").replace(/[\r\n]+/g, " ")}`
        ];
        try {
            fs.appendFileSync(process.env.GITHUB_OUTPUT, outputs.join("\n") + "\n", "utf8");
        } catch { /* ignore */ }
    }

    process.exit(0);
}

module.exports = {
    isValidGitRef,
    validateTargetPomPath,
    validateTestSpecPath,
    verifyCiMetadata
};

const fs = require("fs");
const path = require("path");
const { validateContext, classifyPreFilter, validateTargetFile } = require("./ai-repair-agent");

const ROOT_DIR = path.resolve(__dirname, "..");
const DEFAULT_CANDIDATE_PATHS = [
    path.resolve(ROOT_DIR, "test-results-artifacts/test-results/healing-context.json"),
    path.resolve(ROOT_DIR, "test-results-artifacts/healing-context.json"),
    path.resolve(ROOT_DIR, "test-results/healing-context.json")
];
const OUTPUT_SUMMARY_PATH = path.resolve(ROOT_DIR, "test-results/ai-repair-eligibility.json");

/**
 * Checks whether a branch name indicates a recursive repair execution.
 */
function isRecursiveRepairBranch(branchName) {
    if (!branchName || typeof branchName !== "string") return false;
    const cleanBranch = branchName.replace(/^refs\/heads\//, "");
    return cleanBranch.startsWith("ai-repair/") || cleanBranch.startsWith("repair/");
}

/**
 * Evaluates failure context for AI repair eligibility.
 */
function evaluateEligibility(customPath = null, options = {}) {
    const rootDir = options.rootDir || ROOT_DIR;
    let contextFilePath = customPath ? path.resolve(rootDir, customPath) : null;

    if (!contextFilePath) {
        for (const candidate of DEFAULT_CANDIDATE_PATHS) {
            if (fs.existsSync(candidate)) {
                contextFilePath = candidate;
                break;
            }
        }
    }

    if (!contextFilePath || !fs.existsSync(contextFilePath)) {
        return {
            eligible: false,
            status: "MISSING_CONTEXT",
            classification: "UNKNOWN",
            reason: `Failure context file was not found at specified or default artifact locations.`
        };
    }

    let rawContext;
    try {
        rawContext = fs.readFileSync(contextFilePath, "utf8");
    } catch (err) {
        return {
            eligible: false,
            status: "READ_ERROR",
            classification: "UNKNOWN",
            reason: `Failed to read failure context: ${err.message}`,
            contextPath: contextFilePath
        };
    }

    let contextData;
    try {
        contextData = JSON.parse(rawContext);
    } catch (err) {
        return {
            eligible: false,
            status: "MALFORMED_JSON",
            classification: "UNKNOWN",
            reason: `Context file contains invalid JSON syntax: ${err.message}`,
            contextPath: contextFilePath
        };
    }

    // 1. Validate context schema & freshness
    const validation = validateContext(contextData);
    if (!validation.valid) {
        return {
            eligible: false,
            status: "INVALID_CONTEXT",
            classification: "UNKNOWN",
            reason: `Context schema validation failed: ${validation.reason}`,
            contextPath: contextFilePath
        };
    }

    // 2. Classify symptom & check GEMINI.md pre-filter
    const preFilter = classifyPreFilter(contextData);
    if (!preFilter.canProceed) {
        return {
            eligible: false,
            status: "INELIGIBLE",
            classification: preFilter.classification,
            reason: preFilter.reason,
            contextPath: contextFilePath
        };
    }

    // 3. Verify failing spec is a UI test, not an API test
    const candidate = preFilter.candidate;
    if (candidate.specFile && (candidate.specFile.includes("api/") || candidate.specFile.startsWith("api/"))) {
        return {
            eligible: false,
            status: "INELIGIBLE",
            classification: "APPLICATION_DEFECT",
            reason: `Failing spec '${candidate.specFile}' is an API test. API assertions represent application/backend behavior, not UI Page Object locators.`,
            testTitle: candidate.testTitle,
            contextPath: contextFilePath
        };
    }

    // 4. Dynamically derive target Page Object file
    let targetPomRel = candidate.targetFile || options.targetPomRel || null;
    if (!targetPomRel && candidate.specFile) {
        const specAbs = path.isAbsolute(candidate.specFile) ? candidate.specFile : path.resolve(rootDir, candidate.specFile);
        if (fs.existsSync(specAbs)) {
            try {
                const specContent = fs.readFileSync(specAbs, "utf8");
                const importMatch = specContent.match(/(?:require\(|from\s+)["'][^"']*\/pages\/([a-zA-Z0-9_\-]+Page)(?:\.js)?["']/);
                if (importMatch) {
                    targetPomRel = `tests/pages/${importMatch[1]}.js`;
                }
            } catch { /* ignore */ }
        }
    }

    if (!targetPomRel) {
        const defaultPom = "tests/pages/ProductListPage.js";
        if (fs.existsSync(path.resolve(rootDir, defaultPom))) {
            targetPomRel = defaultPom;
        } else {
            return {
                eligible: false,
                status: "INELIGIBLE",
                classification: "NO_APPROVED_POM",
                reason: "Could not derive an approved Page Object Model (tests/pages/*.js) from failure context or spec.",
                contextPath: contextFilePath
            };
        }
    }

    try {
        validateTargetFile(targetPomRel, rootDir);
    } catch (err) {
        return {
            eligible: false,
            status: "INELIGIBLE",
            classification: "SECURITY_VIOLATION",
            reason: `Target file validation failed: ${err.message}`,
            contextPath: contextFilePath
        };
    }

    const hasEvidence = Boolean(
        contextData.summary?.hasBrowserEvidence ||
        candidate.domSnapshot ||
        candidate.accessibilitySnapshot ||
        candidate.evidence?.hasEvidence
    );

    return {
        eligible: true,
        status: "ELIGIBLE",
        classification: "STALE_LOCATOR_CANDIDATE",
        reason: "Failure exhibits locator lookup timeout on approved Page Object. Eligible for AI investigation.",
        testTitle: candidate.testTitle,
        targetLocator: candidate.targetLocator || "N/A",
        observedSymptom: candidate.observedSymptom,
        targetFile: targetPomRel,
        hasEvidence,
        contextPath: contextFilePath
    };
}

/**
 * Writes markdown summary to GitHub Step Summary if running in GitHub Actions.
 */
function writeStepSummary(result) {
    const summaryFile = process.env.GITHUB_STEP_SUMMARY;
    if (!summaryFile) return;

    const badge = result.eligible ? "🟢 **ELIGIBLE FOR AI INVESTIGATION**" : "🔴 **INELIGIBLE FOR AI REPAIR**";
    const icon = result.eligible ? "✅" : "❌";

    const markdown = [
        `### ${icon} Antigravity AI Repair Preparation & Eligibility Report`,
        "",
        "| Parameter | Details |",
        "|:---|:---|",
        `| **Verdict** | ${badge} |`,
        `| **Status** | \`${result.status}\` |`,
        `| **Classification** | \`${result.classification}\` |`,
        `| **Reason** | ${result.reason} |`,
        result.testTitle ? `| **Failing Test** | ${result.testTitle} |` : null,
        result.targetLocator ? `| **Target Locator** | \`${result.targetLocator}\` |` : null,
        result.targetFile ? `| **Target POM File** | \`${result.targetFile}\` |` : null,
        `| **Browser Evidence** | ${result.hasEvidence ? "🟢 Available" : "🟡 Not Attached"} |`,
        `| **AI Investigation** | *Phase 3: Model invocation gated on eligibility outputs* |`,
        ""
    ].filter(Boolean).join("\n");

    try {
        fs.appendFileSync(summaryFile, markdown + "\n", "utf8");
    } catch (err) {
        console.error(`[Eligibility] Warning: Failed to write GITHUB_STEP_SUMMARY: ${err.message}`);
    }
}

/**
 * Sets step outputs for downstream steps in GitHub Actions.
 */
function setGithubOutputs(result) {
    const outputFile = process.env.GITHUB_OUTPUT;
    if (!outputFile) return;

    const sanitizedReason = (result.reason || "").replace(/[\r\n]+/g, " ");

    const lines = [
        `eligible=${Boolean(result.eligible)}`,
        `status=${result.status || "UNKNOWN"}`,
        `classification=${result.classification || "UNKNOWN"}`,
        `target_file=${result.targetFile || ""}`,
        `failing_test=${(result.testTitle || "").replace(/[\r\n]+/g, " ")}`,
        `target_locator=${(result.targetLocator || "").replace(/[\r\n]+/g, " ")}`,
        `has_evidence=${Boolean(result.hasEvidence)}`,
        `reason=${sanitizedReason}`
    ];

    try {
        fs.appendFileSync(outputFile, lines.join("\n") + "\n", "utf8");
    } catch (err) {
        console.error(`[Eligibility] Warning: Failed to write GITHUB_OUTPUT: ${err.message}`);
    }
}

/**
 * Main execution function.
 */
function run() {
    const targetPath = process.argv[2] || null;

    console.log("=== Antigravity AI Repair Eligibility Evaluation (Phase 3A) ===\n");

    const result = evaluateEligibility(targetPath);

    console.log(`[Eligibility] Verdict:        ${result.eligible ? "ELIGIBLE" : "INELIGIBLE"}`);
    console.log(`[Eligibility] Status:         ${result.status}`);
    console.log(`[Eligibility] Classification: ${result.classification}`);
    console.log(`[Eligibility] Reason:         ${result.reason}`);
    if (result.testTitle) {
        console.log(`[Eligibility] Failing Test:   "${result.testTitle}"`);
    }
    if (result.targetLocator) {
        console.log(`[Eligibility] Target Locator: ${result.targetLocator}`);
    }
    if (result.targetFile) {
        console.log(`[Eligibility] Target File:    ${result.targetFile}`);
    }

    // Save eligibility metadata artifact
    try {
        const outDir = path.dirname(OUTPUT_SUMMARY_PATH);
        if (!fs.existsSync(outDir)) {
            fs.mkdirSync(outDir, { recursive: true });
        }
        const fullPayload = {
            timestamp: new Date().toISOString(),
            phase: "3A_POST_FAILURE_PREPARATION",
            ...result
        };
        fs.writeFileSync(OUTPUT_SUMMARY_PATH, JSON.stringify(fullPayload, null, 2), "utf8");
        console.log(`\n[Eligibility] Summary saved to: ${OUTPUT_SUMMARY_PATH}`);
    } catch (err) {
        console.error(`[Eligibility] Warning: Failed to save summary file: ${err.message}`);
    }

    writeStepSummary(result);
    setGithubOutputs(result);

    console.log("\n[Eligibility] Phase 3A preparation complete. Autonomous repository writes and model invocations remain disabled.\n");
    return result;
}

if (require.main === module) {
    run();
}

module.exports = {
    evaluateEligibility,
    isRecursiveRepairBranch,
    writeStepSummary,
    setGithubOutputs,
    OUTPUT_SUMMARY_PATH,
    DEFAULT_CANDIDATE_PATHS
};

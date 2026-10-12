const { spawn } = require("child_process");
const fs = require("fs");
const path = require("path");

const RESULTS_PATH = path.resolve(__dirname, "../test-results/results.json");
const BACKUP_PATH = path.resolve(__dirname, "../test-results/results.json.bak");
const CONTEXT_PATH = path.resolve(__dirname, "../test-results/healing-context.json");
const ROOT_DIR = path.resolve(__dirname, "..");

function getGitShaSafe() {
    try {
        const { execSync } = require("child_process");
        return execSync("git rev-parse HEAD", { encoding: "utf8", stdio: ["ignore", "pipe", "ignore"] }).trim();
    } catch {
        return null;
    }
}


/**
 * Strips ANSI color codes from terminal error messages.
 */
function stripAnsi(text) {
    if (!text) return "";
    return text.replace(/\u001b\[\d+m/g, "");
}

/**
 * Attempts to extract a failing locator string from error messages or logs.
 * Returns null if no explicit locator pattern is recognized (never guesses).
 */
function extractFailedLocator(errorMessage) {
    if (!errorMessage) return null;
    const cleanMsg = stripAnsi(errorMessage);

    // Pattern 1: Playwright's standard "Locator: <expression>" line in error block
    // Matches lines like:
    //   Locator: locator('.my-class')
    //   Locator: getByRole('heading', { name: 'Products' })
    //   Locator: getByTestId('product-card')
    //   Locator: locator('.container').getByRole('button')
    const locatorHeaderMatch = cleanMsg.match(/^\s*Locator:\s+(.+)$/m);
    if (locatorHeaderMatch) {
        const raw = locatorHeaderMatch[1].trim();
        // If it's a simple locator('...'), unwrap to clean selector string
        const unwrapSimple = raw.match(/^locator\(['"]([^'"]+)['"]\)$/);
        return unwrapSimple ? unwrapSimple[1] : raw;
    }

    // Pattern 2: Call log "waiting for <locator>"
    // Matches lines like:
    //   - waiting for locator('.my-class')
    //   - waiting for getByRole('button', { name: 'Submit' })
    //   - waiting for getByText('Submit')
    const waitingMatch = cleanMsg.match(/waiting for\s+(locator\(['"]([^'"]+)['"]\)|getBy[a-zA-Z]+\([^)]*\))/i);
    if (waitingMatch) {
        if (waitingMatch[2]) {
            return waitingMatch[2].trim();
        }
        if (waitingMatch[1]) {
            const inner = waitingMatch[1].match(/^locator\(['"]([^'"]+)['"]\)$/i);
            return inner ? inner[1] : waitingMatch[1].trim();
        }
    }

    return null;
}

/**
 * Classifies the observed symptom from the error message and locator presence.
 * IMPORTANT: This represents the OBSERVED SYMPTOM, NOT a confirmed root cause.
 * A locator timeout alone does NOT prove a stale locator (it could be an application defect,
 * missing DOM element, test data mismatch, or environment latency).
 */
function classifyFailureSymptom(cleanMessage, failedLocator) {
    if (!cleanMessage) return "UNKNOWN";

    if (/ECONNREFUSED|ERR_CONNECTION_REFUSED|ENOTFOUND/i.test(cleanMessage)) {
        return "ENVIRONMENT_CONNECTION_ERROR";
    }

    if (/ReferenceError|TypeError|SyntaxError/i.test(cleanMessage)) {
        return "CODE_EXCEPTION";
    }

    if (failedLocator) {
        // Element lookup timed out before finding any matching DOM nodes
        if (/resolved to 0 elements/i.test(cleanMessage) ||
            (/waiting for/i.test(cleanMessage) && /timeout|timed\s*out/i.test(cleanMessage))) {
            return "LOCATOR_LOOKUP_TIMEOUT";
        }
        // Element resolved in DOM, but value/text/state assertion failed
        if (/locator resolved to <|resolved to [1-9]\d* elements|unexpected value/i.test(cleanMessage)) {
            return "ASSERTION_MISMATCH";
        }
        return "LOCATOR_ISSUE";
    }

    if (/expect\([^)]+\)\.to|Expected:.*\n.*Received:/i.test(cleanMessage)) {
        return "ASSERTION_MISMATCH";
    }

    if (/timeout\s*\d*ms\s*exceeded/i.test(cleanMessage)) {
        return "TEST_TIMEOUT";
    }

    return "GENERAL_FAILURE";
}

/**
 * Recursively walks Playwright suites tree to collect failed test results.
 */
function collectFailedSpecs(suite, list = []) {
    if (suite.specs) {
        for (const spec of suite.specs) {
            for (const testItem of spec.tests || []) {
                for (const result of testItem.results || []) {
                    if (result.status === "failed" || result.status === "timedOut") {
                        const error = result.error || (result.errors && result.errors[0]) || {};
                        const rawMessage = error.message || "";
                        const cleanMessage = stripAnsi(rawMessage);
                        const locator = extractFailedLocator(rawMessage);
                        const symptom = classifyFailureSymptom(cleanMessage, locator);

                        const screenshotAttachment = (result.attachments || []).find(
                            (att) => att.name === "screenshot" || (att.contentType && att.contentType.startsWith("image/"))
                        );

                        const traceAttachment = (result.attachments || []).find(
                            (att) => att.name === "trace" || (att.path && att.path.endsWith(".zip"))
                        );

                        let targetPom = null;
                        const stack = error.stack || rawMessage;
                        const pomStackMatch = stack.match(/tests[/\\]pages[/\\]([a-zA-Z0-9_\-]+Page)\.js/);
                        if (pomStackMatch) {
                            targetPom = `tests/pages/${pomStackMatch[1]}.js`;
                        } else if (spec.file) {
                            let specAbs = path.isAbsolute(spec.file) ? spec.file : path.resolve(ROOT_DIR, spec.file);
                            if (!fs.existsSync(specAbs)) {
                                specAbs = path.resolve(ROOT_DIR, "tests", spec.file);
                            }
                            if (fs.existsSync(specAbs)) {
                                try {
                                    const specCode = fs.readFileSync(specAbs, "utf8");
                                    const importMatch = specCode.match(/(?:require\(|from\s+)["'][^"']*\/pages\/([a-zA-Z0-9_\-]+Page)(?:\.js)?["']/);
                                    if (importMatch) {
                                        targetPom = `tests/pages/${importMatch[1]}.js`;
                                    }
                                } catch { /* ignore */ }
                            }
                        }

                        let rawSpecPath = spec.file || error.location?.file || null;
                        if (rawSpecPath && !rawSpecPath.replace(/\\/g, "/").startsWith("tests/") && !path.isAbsolute(rawSpecPath)) {
                            rawSpecPath = `tests/${rawSpecPath}`;
                        }
                        const specFilePath = rawSpecPath ? rawSpecPath.replace(/\\/g, "/") : null;
                        list.push({
                            testTitle: spec.title || testItem.title || "Unknown Test",
                            specFile: specFilePath,
                            testFile: specFilePath,
                            targetFile: targetPom,
                            lineNumber: error.location?.line || spec.line || null,
                            columnNumber: error.location?.column || spec.column || null,
                            observedSymptom: symptom,
                            targetLocator: locator,
                            rootCauseClassification: "UNCONFIRMED_PENDING_INVESTIGATION",
                            errorMessage: cleanMessage,
                            screenshotPath: screenshotAttachment ? screenshotAttachment.path : null,
                            tracePath: traceAttachment ? traceAttachment.path : null
                        });
                    }
                }
            }
        }
    }

    if (suite.suites) {
        for (const childSuite of suite.suites) {
            collectFailedSpecs(childSuite, list);
        }
    }

    return list;
}

/**
 * Standard Antigravity AI Repair Handoff banner.
 */
function printHandoffBanner() {
    console.log("\n" + "=".repeat(78));
    console.log("[Antigravity AI Repair Handoff]");
    console.log("Context file: test-results/healing-context.json");
    console.log("\nSuggested Antigravity Prompt:");
    console.log("  Investigate and repair the Playwright failure documented in test-results/healing-context.json. Follow GEMINI.md, use Playwright MCP when useful, verify the repair with tests, show the complete diff, and stop for my review.");
    console.log("=".repeat(78) + "\n");
}

/**
 * Writes an explicit diagnostic context when the test report is missing, stale, invalid, or process failed.
 */
function generateDiagnosticContext({ exitCode, errorType, diagnostic, rawError, terminationType, previousReportPreserved }) {
    const outputDir = path.dirname(CONTEXT_PATH);
    if (!fs.existsSync(outputDir)) {
        fs.mkdirSync(outputDir, { recursive: true });
    }

    const testedCommit = process.env.TESTED_COMMIT_SHA || getGitShaSafe() || process.env.GITHUB_SHA;
    const isPrEvent = process.env.EVENT_NAME === "pull_request" || process.env.GITHUB_EVENT_NAME === "pull_request" || Boolean(process.env.PR_HEAD_SHA);
    const headSha = process.env.PR_HEAD_SHA || null;
    const mergeSha = process.env.PR_MERGE_SHA || (isPrEvent ? testedCommit : null);

    const context = {
        timestamp: new Date().toISOString(),
        commitSha: testedCommit,
        headSha,
        mergeSha,
        runId: process.env.GITHUB_RUN_ID ? String(process.env.GITHUB_RUN_ID) : null,
        runAttempt: process.env.GITHUB_RUN_ATTEMPT ? parseInt(process.env.GITHUB_RUN_ATTEMPT, 10) : 1,
        repository: process.env.GITHUB_REPOSITORY || null,
        status: "ERROR",
        isOrchestrationError: true,
        terminationType: terminationType || "ORCHESTRATOR_ERROR",
        exitCode: exitCode !== undefined ? exitCode : 1,
        errorType: errorType || "ORCHESTRATOR_ERROR",
        diagnostic: diagnostic || "An orchestration error occurred.",
        previousReportPreserved: Boolean(previousReportPreserved),
        rawError: rawError ? stripAnsi(rawError) : null,
        summary: {
            totalFailures: 0,
            hasLocatorFailures: false,
            hasReport: false,
            rootCauseStatus: "N/A - Execution aborted before test completion"
        },
        failures: []
    };

    fs.writeFileSync(CONTEXT_PATH, JSON.stringify(context, null, 2), "utf8");
    console.log(`\n[Orchestrator] Diagnostic context generated at: ${CONTEXT_PATH}`);
    console.log(`[Orchestrator] Diagnostic: ${diagnostic}`);

    printHandoffBanner();
}

/**
 * Parses valid test-results/results.json and writes test-results/healing-context.json.
 */
function generateHealingContext(exitCode, reportData, runStartTime) {
    const outputDir = path.dirname(CONTEXT_PATH);
    if (!fs.existsSync(outputDir)) {
        fs.mkdirSync(outputDir, { recursive: true });
    }

    let failures = [];
    if (reportData && Array.isArray(reportData.suites)) {
        for (const suite of reportData.suites) {
            collectFailedSpecs(suite, failures);
        }
    }

    const locatorTimeouts = failures.filter((f) => f.observedSymptom === "LOCATOR_LOOKUP_TIMEOUT");
    const assertionMismatches = failures.filter((f) => f.observedSymptom === "ASSERTION_MISMATCH");
    const environmentErrors = failures.filter((f) => f.observedSymptom === "ENVIRONMENT_CONNECTION_ERROR");
    const codeExceptions = failures.filter((f) => f.observedSymptom === "CODE_EXCEPTION");
    const otherFailures = failures.filter(
        (f) => !["LOCATOR_LOOKUP_TIMEOUT", "ASSERTION_MISMATCH", "ENVIRONMENT_CONNECTION_ERROR", "CODE_EXCEPTION"].includes(f.observedSymptom)
    );

    const liveEvidencePath = path.resolve(__dirname, "../test-results/live-evidence.json");
    let hasLiveEvidence = false;
    if (fs.existsSync(liveEvidencePath)) {
        try {
            const parsedEvidence = JSON.parse(fs.readFileSync(liveEvidencePath, "utf8"));
            if (failures.length > 0 && parsedEvidence.hasEvidence) {
                failures[0].domSnapshot = parsedEvidence.domSnapshot;
                failures[0].accessibilitySnapshot = parsedEvidence.accessibilitySnapshot;
                failures[0].evidence = parsedEvidence;
                hasLiveEvidence = true;
            }
        } catch {
            // Ignore evidence read error
        }
    }

    const commitSha = process.env.TESTED_COMMIT_SHA || getGitShaSafe() || process.env.GITHUB_SHA;
    const isPrEvent = process.env.EVENT_NAME === "pull_request" || process.env.GITHUB_EVENT_NAME === "pull_request" || Boolean(process.env.PR_HEAD_SHA);
    const headSha = process.env.PR_HEAD_SHA || null;
    const mergeSha = process.env.PR_MERGE_SHA || (isPrEvent ? commitSha : null);
    const runId = process.env.GITHUB_RUN_ID ? String(process.env.GITHUB_RUN_ID) : null;
    const runAttempt = process.env.GITHUB_RUN_ATTEMPT ? parseInt(process.env.GITHUB_RUN_ATTEMPT, 10) : 1;
    const repository = process.env.GITHUB_REPOSITORY || null;

    const healingContext = {
        timestamp: new Date().toISOString(),
        commitSha,
        headSha,
        mergeSha,
        runId,
        runAttempt,
        repository,
        status: "FAILED",
        isOrchestrationError: false,
        terminationType: "NORMAL_EXIT",
        exitCode,
        reportSource: RESULTS_PATH,
        summary: {
            totalFailures: failures.length,
            observedSymptoms: {
                locatorLookupTimeouts: locatorTimeouts.length,
                assertionMismatches: assertionMismatches.length,
                environmentErrors: environmentErrors.length,
                codeExceptions: codeExceptions.length,
                otherFailures: otherFailures.length
            },
            hasLocatorTimeouts: locatorTimeouts.length > 0,
            hasBrowserEvidence: hasLiveEvidence,
            rootCauseStatus: hasLiveEvidence
                ? "EVIDENCE_ATTACHED - Browser DOM and accessibility snapshots captured headlessly"
                : "UNCONFIRMED - Requires Playwright MCP DOM/Network inspection per GEMINI.md"
        },
        failures
    };

    fs.writeFileSync(CONTEXT_PATH, JSON.stringify(healingContext, null, 2), "utf8");
    console.log(`\n[Orchestrator] Failure context generated at: ${CONTEXT_PATH}`);
    if (hasLiveEvidence) {
        console.log(`[Orchestrator] Headless browser evidence attached to failure context.`);
    }
    console.log(`[Orchestrator] Failures detected: ${failures.length} (Observed: ${locatorTimeouts.length} locator lookup timeouts, ${assertionMismatches.length} assertion mismatches, ${environmentErrors.length} environment errors)`);
    console.log(`[Orchestrator] Note: Root cause is unconfirmed. Multi-vector inspection is required.`);

    printHandoffBanner();
}

/**
 * Main execution entry point.
 */
function run() {
    const userArgs = process.argv.slice(2);
    const playwrightArgs = userArgs.length > 0 ? userArgs : ["--project=ui"];

    console.log(`[Orchestrator] Starting Playwright test execution...`);
    console.log(`[Orchestrator] Arguments: ${playwrightArgs.join(" ")}\n`);

    const runStartTime = Date.now();

    // 1. Safe report isolation: Back up existing results.json instead of destroying it
    let hadPreviousReport = false;
    if (fs.existsSync(RESULTS_PATH)) {
        try {
            fs.copyFileSync(RESULTS_PATH, BACKUP_PATH);
            fs.unlinkSync(RESULTS_PATH);
            hadPreviousReport = true;
        } catch (err) {
            console.warn(`[Orchestrator] Warning: Could not create backup of previous report: ${err.message}`);
        }
    }

    // 2. Clear any prior healing context and live evidence
    if (fs.existsSync(CONTEXT_PATH)) {
        try {
            fs.unlinkSync(CONTEXT_PATH);
        } catch {
            // Ignore
        }
    }
    const priorEvidencePath = path.resolve(__dirname, "../test-results/live-evidence.json");
    if (fs.existsSync(priorEvidencePath)) {
        try {
            fs.unlinkSync(priorEvidencePath);
        } catch {
            // Ignore
        }
    }

    const isWindows = process.platform === "win32";
    const defaultCommand = isWindows ? "npx.cmd" : "npx";
    const command = process.env.PLAYWRIGHT_CMD_OVERRIDE || defaultCommand;

    let child;
    try {
        child = spawn(command, ["playwright", "test", ...playwrightArgs], {
            stdio: "inherit",
            shell: isWindows
        });
    } catch (err) {
        console.error(`\n[Orchestrator] Process launch failure: ${err.message}`);
        // Restore backup if present
        if (hadPreviousReport && fs.existsSync(BACKUP_PATH)) {
            try {
                fs.copyFileSync(BACKUP_PATH, RESULTS_PATH);
            } catch { /* ignore */ }
        }
        generateDiagnosticContext({
            exitCode: 1,
            terminationType: "LAUNCH_FAILURE",
            errorType: "PROCESS_LAUNCH_FAILURE",
            diagnostic: `Failed to launch Playwright child process: ${err.message}`,
            previousReportPreserved: hadPreviousReport
        });
        process.exit(1);
    }

    child.on("error", (err) => {
        console.error(`\n[Orchestrator] Process launch failure: ${err.message}`);
        // Restore backup if present
        if (hadPreviousReport && fs.existsSync(BACKUP_PATH)) {
            try {
                fs.copyFileSync(BACKUP_PATH, RESULTS_PATH);
            } catch { /* ignore */ }
        }
        generateDiagnosticContext({
            exitCode: 1,
            terminationType: "LAUNCH_FAILURE",
            errorType: "PROCESS_LAUNCH_FAILURE",
            diagnostic: `Failed to launch Playwright child process: ${err.message}`,
            previousReportPreserved: hadPreviousReport
        });
        process.exit(1);
    });

    child.on("close", (exitCode, signal) => {
        // Handle signal termination explicitly (e.g. SIGINT, SIGTERM)
        if (signal !== null) {
            console.log(`\n[Orchestrator] Test process terminated by signal: ${signal}`);
            if (hadPreviousReport && fs.existsSync(BACKUP_PATH)) {
                try {
                    fs.copyFileSync(BACKUP_PATH, RESULTS_PATH);
                } catch { /* ignore */ }
            }
            generateDiagnosticContext({
                exitCode: 130,
                terminationType: "SIGNAL_TERMINATION",
                errorType: "SIGNAL_TERMINATION",
                diagnostic: `Playwright process was terminated by signal: ${signal}`,
                previousReportPreserved: hadPreviousReport
            });
            process.exit(130);
        }

        const resolvedExitCode = exitCode !== null ? exitCode : 1;

        if (resolvedExitCode === 0) {
            // Clean up backup and previous context
            if (fs.existsSync(BACKUP_PATH)) {
                try { fs.unlinkSync(BACKUP_PATH); } catch { /* ignore */ }
            }
            if (fs.existsSync(CONTEXT_PATH)) {
                try { fs.unlinkSync(CONTEXT_PATH); } catch { /* ignore */ }
            }
            console.log(`\n[Orchestrator] All tests passed cleanly (Exit Code: 0).`);
            process.exit(0);
        }

        console.log(`\n[Orchestrator] Test execution failed (Exit Code: ${resolvedExitCode}).`);

        // Check if report exists
        if (!fs.existsSync(RESULTS_PATH)) {
            // Restore previous report if available
            if (hadPreviousReport && fs.existsSync(BACKUP_PATH)) {
                try {
                    fs.copyFileSync(BACKUP_PATH, RESULTS_PATH);
                } catch { /* ignore */ }
            }
            generateDiagnosticContext({
                exitCode: resolvedExitCode,
                terminationType: "NORMAL_EXIT",
                errorType: "MISSING_REPORT",
                diagnostic: `Test report not found at ${RESULTS_PATH}. Playwright may have exited before producing results.`,
                previousReportPreserved: hadPreviousReport
            });
            process.exit(resolvedExitCode);
        }

        // Verify report is fresh (mtime after run start)
        try {
            const stat = fs.statSync(RESULTS_PATH);
            if (stat.mtimeMs < runStartTime - 1000) {
                if (hadPreviousReport && fs.existsSync(BACKUP_PATH)) {
                    try {
                        fs.copyFileSync(BACKUP_PATH, RESULTS_PATH);
                    } catch { /* ignore */ }
                }
                generateDiagnosticContext({
                    exitCode: resolvedExitCode,
                    terminationType: "NORMAL_EXIT",
                    errorType: "STALE_REPORT",
                    diagnostic: `Test report at ${RESULTS_PATH} is stale (modified before current run started at ${new Date(runStartTime).toISOString()}).`,
                    previousReportPreserved: hadPreviousReport
                });
                process.exit(resolvedExitCode);
            }
        } catch (err) {
            generateDiagnosticContext({
                exitCode: resolvedExitCode,
                terminationType: "NORMAL_EXIT",
                errorType: "REPORT_STAT_ERROR",
                diagnostic: `Failed to verify report timestamp: ${err.message}`,
                previousReportPreserved: hadPreviousReport
            });
            process.exit(resolvedExitCode);
        }

        // Read and parse report
        let reportData = null;
        try {
            const rawContent = fs.readFileSync(RESULTS_PATH, "utf8");
            reportData = JSON.parse(rawContent);
        } catch (err) {
            generateDiagnosticContext({
                exitCode: resolvedExitCode,
                terminationType: "NORMAL_EXIT",
                errorType: "INVALID_JSON_REPORT",
                diagnostic: `Failed to parse test report as valid JSON: ${err.message}`,
                previousReportPreserved: hadPreviousReport
            });
            process.exit(resolvedExitCode);
        }

        // Validate structure
        if (!reportData || typeof reportData !== "object" || !Array.isArray(reportData.suites)) {
            generateDiagnosticContext({
                exitCode: resolvedExitCode,
                terminationType: "NORMAL_EXIT",
                errorType: "UNEXPECTED_REPORT_STRUCTURE",
                diagnostic: `Test report has unexpected structure (missing or non-array 'suites' property).`,
                previousReportPreserved: hadPreviousReport
            });
            process.exit(resolvedExitCode);
        }

        // Fresh report generated successfully: clean up backup
        if (fs.existsSync(BACKUP_PATH)) {
            try { fs.unlinkSync(BACKUP_PATH); } catch { /* ignore */ }
        }

        // Generate full failure context from valid fresh report
        generateHealingContext(resolvedExitCode, reportData, runStartTime);
        process.exit(resolvedExitCode);
    });
}

if (require.main === module) {
    run();
}

module.exports = {
    stripAnsi,
    extractFailedLocator,
    classifyFailureSymptom,
    collectFailedSpecs,
    generateHealingContext,
    generateDiagnosticContext,
    run
};

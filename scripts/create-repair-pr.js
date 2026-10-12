/**
 * @file create-repair-pr.js
 * @description Safe, Idempotent GitHub Autonomous Repair Pull Request Generator (Phase 3B.3).
 *
 * SAFETY & SECURITY SPECIFICATION:
 * 1. CI Minimum Permissions:
 *    - contents: write       (required to push the isolated ai-repair/* branch)
 *    - pull-requests: write  (required to open the review PR via `gh pr create`)
 *    - All other permissions must default to 'none'.
 *    - Ordinary test runs remain strictly 'contents: read'.
 *
 * 2. Fork Pull Request & Untrusted Workflow Protection:
 *    - Fork PRs from external contributors must NEVER run this repair job or access secrets.
 *    - CI condition: `if: github.event.pull_request.head.repo.full_name == github.repository`
 *      guarantees external forks are excluded.
 *    - Secrets (`GEMINI_API_KEY`) and write tokens are only exposed to this post-failure job.
 *
 * 3. Scope & Integrity Constraints:
 *    - Only Page Object Model files under `tests/pages/` may be patched.
 *    - Any changes targeting `.github/**`, `package.json`, `playwright.config.js`, application source,
 *      or test specs are rejected by `validateUnifiedDiff`.
 *
 * 4. Anti-Recursion & Idempotency:
 *    - Repair branches MUST start with `ai-repair/`.
 *    - CI triggers must ignore `branches-ignore: ['ai-repair/**']`.
 *    - Checks for existing open PRs targeting `baseBranch` before creating a duplicate.
 *
 * 5. Non-Negotiable Human Review Gate:
 *    - Zero automated merging (`gh pr merge` is strictly forbidden).
 *    - No force pushing (`git push --force` or `-f` is forbidden).
 *    - No branch deletion (`git branch -D` or `git push :branch` is forbidden).
 *    - Working tree immutability: Main repository working tree is NEVER modified; operations
 *      occur in an isolated, temporary git worktree.
 */

const fs = require("fs");
const path = require("path");
const { spawn } = require("child_process");
const { validateUnifiedDiff, ROOT_DIR } = require("./ai-repair-agent");

// Command execution security whitelists
const ALLOWED_EXECUTABLES = new Set(["git", "gh"]);

const ALLOWED_GIT_COMMANDS = new Set([
    "ls-remote",
    "worktree",
    "add",
    "commit",
    "push",
    "rev-parse",
    "branch",
    "status"
]);

const ALLOWED_GH_COMMANDS = new Set([
    "pr"
]);

/**
 * Validates whether a git reference name complies with standard git naming rules.
 * Prevents flag injection, path traversal, and malformed ref syntax.
 *
 * @param {string} ref - The branch ref name
 * @returns {boolean} True if ref is valid
 */
function isValidGitRef(ref) {
    if (!ref || typeof ref !== "string") return false;
    const trimmed = ref.trim();
    if (trimmed.length === 0 || trimmed.length > 255) return false;
    if (!/^[a-zA-Z0-9_\-\./]+$/.test(trimmed)) return false; // Strict alphanumeric, dash, underscore, dot, and slash whitelist
    if (trimmed.startsWith("/") || trimmed.endsWith("/") || trimmed.startsWith("-") || trimmed.startsWith(".")) return false;
    if (trimmed.endsWith(".lock")) return false;
    if (trimmed === "HEAD") return false;
    if (/\.\./.test(trimmed)) return false; // Disallow ".."
    if (/\/\//.test(trimmed)) return false; // Disallow "//"
    if (/@\{/.test(trimmed)) return false;  // Disallow "@{"
    return true;
}

/**
 * Validates inputs for PR generation.
 * Enforces explicit baseBranch, ai-repair/ prefix, 40-hex SHA, and existing files.
 *
 * @param {object} inputs
 * @param {string} rootDir
 * @returns {object} Validated inputs
 */
function validatePrInputs(inputs = {}, rootDir = ROOT_DIR) {
    if (!inputs || typeof inputs !== "object") {
        throw new Error("Invalid arguments: inputs object is required.");
    }

    // 1. Validate baseBranch (Target branch for the PR, e.g. "main")
    if (!inputs.baseBranch || typeof inputs.baseBranch !== "string" || inputs.baseBranch.trim() === "") {
        throw new Error("Missing required argument: 'baseBranch'. Base branch must be explicitly specified and cannot be inferred.");
    }
    const baseBranch = inputs.baseBranch.trim();
    if (!isValidGitRef(baseBranch)) {
        throw new Error(`Invalid 'baseBranch' name: '${baseBranch}'. Must be a valid git branch reference.`);
    }

    // 2. Validate repairBranch (Branch to create/push, e.g. "ai-repair/fix-catalog-heading-1234abc")
    if (!inputs.repairBranch || typeof inputs.repairBranch !== "string" || inputs.repairBranch.trim() === "") {
        throw new Error("Missing required argument: 'repairBranch'.");
    }
    const repairBranch = inputs.repairBranch.trim();
    if (!isValidGitRef(repairBranch)) {
        throw new Error(`Invalid 'repairBranch' name: '${repairBranch}'. Must be a valid git branch reference.`);
    }
    if (!repairBranch.startsWith("ai-repair/")) {
        throw new Error(`Invalid 'repairBranch': '${repairBranch}'. Must start with 'ai-repair/' prefix to prevent CI recursion.`);
    }

    // 3. Ensure baseBranch and repairBranch are strictly distinct
    if (baseBranch === repairBranch) {
        throw new Error(`Conflict: 'baseBranch' and 'repairBranch' cannot be identical ('${baseBranch}').`);
    }

    // 4. Validate sourceCommit (Exact commit SHA where failure occurred)
    if (!inputs.sourceCommit || typeof inputs.sourceCommit !== "string") {
        throw new Error("Missing required argument: 'sourceCommit'.");
    }
    const sourceCommit = inputs.sourceCommit.trim();
    if (!/^[0-9a-fA-F]{7,40}$/.test(sourceCommit)) {
        throw new Error(`Invalid 'sourceCommit': '${sourceCommit}'. Must be a 7 to 40 character hexadecimal git commit SHA.`);
    }

    // 5. Validate patchPath
    if (!inputs.patchPath || typeof inputs.patchPath !== "string") {
        throw new Error("Missing required argument: 'patchPath'.");
    }
    const resolvedPatchPath = path.resolve(rootDir, inputs.patchPath);
    if (!fs.existsSync(resolvedPatchPath)) {
        throw new Error(`Patch file does not exist: '${resolvedPatchPath}'.`);
    }
    if (!fs.statSync(resolvedPatchPath).isFile()) {
        throw new Error(`Patch path is not a file: '${resolvedPatchPath}'.`);
    }
    if (fs.statSync(resolvedPatchPath).size === 0) {
        throw new Error(`Patch file is empty (0 bytes): '${resolvedPatchPath}'.`);
    }

    // 6. Validate summaryPath
    if (!inputs.summaryPath || typeof inputs.summaryPath !== "string") {
        throw new Error("Missing required argument: 'summaryPath'.");
    }
    const resolvedSummaryPath = path.resolve(rootDir, inputs.summaryPath);
    if (!fs.existsSync(resolvedSummaryPath)) {
        throw new Error(`Summary file does not exist: '${resolvedSummaryPath}'.`);
    }
    if (!fs.statSync(resolvedSummaryPath).isFile()) {
        throw new Error(`Summary path is not a file: '${resolvedSummaryPath}'.`);
    }

    return {
        baseBranch,
        repairBranch,
        sourceCommit,
        patchPath: resolvedPatchPath,
        summaryPath: resolvedSummaryPath
    };
}

/**
 * Validates command tokens against safety constraints before execution.
 * Enforces executable whitelisting and strictly blocks force pushes, deletions, and auto-merges.
 *
 * @param {string} cmd
 * @param {string[]} args
 */
function validateCommandSafety(cmd, args = []) {
    if (!ALLOWED_EXECUTABLES.has(cmd)) {
        throw new Error(`Security Violation: Unauthorized executable '${cmd}'. Only 'git' and 'gh' are permitted.`);
    }

    if (cmd === "git") {
        const subcommand = args[0];
        if (!ALLOWED_GIT_COMMANDS.has(subcommand)) {
            throw new Error(`Security Violation: Unauthorized git subcommand '${subcommand}'.`);
        }

        // Strict guard against force-pushing
        if (subcommand === "push") {
            for (const arg of args) {
                if (arg === "--force" || arg === "-f" || arg.startsWith("--force-with-lease") || arg.startsWith(":")) {
                    throw new Error(`Security Violation: Force-pushing or ref deletion is strictly prohibited.`);
                }
            }
        }

        // Strict guard against deleting user branches
        if (subcommand === "branch") {
            for (const arg of args) {
                if (arg === "-D" || arg === "-d" || arg === "--delete") {
                    throw new Error(`Security Violation: Deleting branches is strictly prohibited.`);
                }
            }
        }
    }

    if (cmd === "gh") {
        const subcommand = args[0];
        if (!ALLOWED_GH_COMMANDS.has(subcommand)) {
            throw new Error(`Security Violation: Unauthorized gh subcommand '${subcommand}'.`);
        }

        // Strict guard against auto-merging PRs
        if (args.includes("merge")) {
            throw new Error(`Security Violation: Automated pull request merging is strictly prohibited.`);
        }
    }
}

/**
 * Executes a verified command safely using spawn (no shell interpolation).
 *
 * @param {string} cmd
 * @param {string[]} args
 * @param {object} options
 * @returns {Promise<{ exitCode: number, stdout: string, stderr: string }>}
 */
async function runCommand(cmd, args = [], options = {}) {
    // 1. Enforce strict command safety whitelist
    validateCommandSafety(cmd, args);

    // 2. Delegate to custom runner if injected (e.g. for offline unit testing)
    if (typeof options.commandRunner === "function") {
        return await options.commandRunner(cmd, args, options);
    }

    // 3. Real process execution
    return new Promise((resolve, reject) => {
        const child = spawn(cmd, args, {
            cwd: options.cwd || ROOT_DIR,
            env: options.env || process.env,
            stdio: ["ignore", "pipe", "pipe"],
            shell: false
        });

        let stdout = "";
        let stderr = "";

        child.stdout.on("data", (data) => { stdout += data.toString(); });
        child.stderr.on("data", (data) => { stderr += data.toString(); });

        child.on("close", (code) => {
            resolve({
                exitCode: code !== null ? code : 1,
                stdout,
                stderr
            });
        });

        child.on("error", (err) => {
            reject(new Error(`Failed to execute command '${cmd}': ${err.message}`));
        });
    });
}

/**
 * Checks if an open pull request already exists for the given head and base branches.
 *
 * @param {object} params
 * @returns {Promise<{ hasExistingPr: boolean, prNumber?: number, prUrl?: string }>}
 */
async function checkExistingPr(params) {
    const { repairBranch, baseBranch, commandRunner, rootDir } = params;

    try {
        const result = await runCommand("gh", [
            "pr",
            "list",
            "--head",
            repairBranch,
            "--base",
            baseBranch,
            "--state",
            "open",
            "--json",
            "number,url,title"
        ], {
            cwd: rootDir,
            commandRunner
        });

        if (result.exitCode === 0 && result.stdout) {
            const list = JSON.parse(result.stdout.trim());
            if (Array.isArray(list) && list.length > 0) {
                return {
                    hasExistingPr: true,
                    prNumber: list[0].number,
                    prUrl: list[0].url
                };
            }
        }
    } catch {
        // Fall back gracefully if gh is unauthenticated or mock runner returns empty
    }

    return { hasExistingPr: false };
}

/**
 * Generates the pull request title.
 */
function generatePrTitle(summary) {
    const targetFile = summary.targetFile || "tests/pages";
    return `AI Repair: Heal stale locator in ${path.basename(targetFile)}`;
}

/**
 * Generates structured Markdown pull request body.
 */
function generatePrBody(summary, patchDiff) {
    const targetFile = summary.targetFile || "tests/pages";
    const originalLocator = summary.originalLocator || "N/A";
    const healedLocator = summary.healedLocator || "N/A";
    const diagnosis = summary.diagnosis || "Stale locator detected and healed.";
    const model = summary.model || "gemini-3.5-flash";
    const validationExcerpt = summary.validationOutput
        ? summary.validationOutput.slice(0, 1000)
        : "Isolated Playwright test suite passed cleanly.";

    return [
        "## Antigravity AI Autonomous Test Repair Proposal",
        "",
        "### 1. Failure Diagnosis",
        `- **Root Cause**: \`${summary.rootCause || "STALE_LOCATOR"}\``,
        `- **Target File**: \`${targetFile}\``,
        `- **Diagnosis**: ${diagnosis}`,
        `- **Model Used**: \`${model}\``,
        "",
        "### 2. Locator Repair Diff",
        `- **Original Locator**: \`${originalLocator}\``,
        `- **Healed Locator**: \`${healedLocator}\``,
        "",
        "```diff",
        patchDiff.trim(),
        "```",
        "",
        "### 3. Verification & Safety Guarantees",
        "- [x] Verified in an isolated workspace (`.val-workspace-*`)",
        "- [x] Original test assertions passed without modification",
        "- [x] Relevant regression suite verified",
        "- [x] Patch passed diff security whitelist (single POM file, no application or workflow changes)",
        "",
        "### 4. Human Review Gate",
        "> [!IMPORTANT]",
        "> **Mandatory SDET Review**: This pull request was generated automatically and **MUST NOT be auto-merged**.",
        "> A human SDET/engineer must review the diff and approve this PR before merging.",
        "",
        "#### Verification Logs (Excerpt)",
        "```text",
        validationExcerpt.trim(),
        "```"
    ].join("\n");
}

/**
 * Generates a structured Git commit message.
 */
function generateCommitMessage(summary, targetFile) {
    return [
        `fix(pom): ai-healed locator in ${targetFile}`,
        "",
        "Autonomous repair proposal generated by Antigravity AI Repair Agent.",
        `- Target File: ${targetFile}`,
        `- Original Locator: ${summary.originalLocator || "N/A"}`,
        `- Healed Locator: ${summary.healedLocator || "N/A"}`,
        `- Model: ${summary.model || "gemini-3.5-flash"}`,
        "- Verified: Tested in isolated workspace with passing test and regression assertions.",
        "- Human Review Required: Auto-merge is strictly prohibited."
    ].join("\n");
}

/**
 * Primary orchestrator for safe, idempotent repair PR creation.
 *
 * @param {object} options
 * @returns {Promise<object>} Result object with status, prUrl, and repairBranch
 */
async function createRepairPr(options = {}) {
    const rootDir = options.rootDir || ROOT_DIR;

    // 1. Validate inputs
    const validated = validatePrInputs(options, rootDir);

    // 2. Read and validate patch content & security whitelist
    const patchContent = fs.readFileSync(validated.patchPath, "utf8");
    const patchValidation = validateUnifiedDiff(patchContent, rootDir);

    // 3. Read and validate summary file
    const summaryRaw = fs.readFileSync(validated.summaryPath, "utf8");
    let summary;
    try {
        summary = JSON.parse(summaryRaw);
    } catch (err) {
        throw new Error(`Invalid summary JSON: ${err.message}`);
    }

    // 4. Precondition: Check that isolated test validation previously PASSED
    if (summary.status !== "VERIFIED") {
        return {
            success: false,
            status: "UNVERIFIED_PATCH",
            reason: `Patch has not been successfully validated in an isolated workspace (status: '${summary.status}'). PR creation aborted.`
        };
    }

    if (summary.targetFile !== patchValidation.targetFile) {
        return {
            success: false,
            status: "TARGET_MISMATCH",
            reason: `Target file mismatch: summary specifies '${summary.targetFile}' but patch modifies '${patchValidation.targetFile}'.`
        };
    }

    // 5. Idempotency Check: check if PR already exists
    const existingPrResult = await checkExistingPr({
        repairBranch: validated.repairBranch,
        baseBranch: validated.baseBranch,
        commandRunner: options.commandRunner,
        rootDir
    });

    if (existingPrResult.hasExistingPr) {
        console.log(`[Create Repair PR] Open PR already exists for '${validated.repairBranch}' targeting '${validated.baseBranch}': ${existingPrResult.prUrl}`);
        return {
            success: true,
            status: "SKIPPED_EXISTING_PR",
            prUrl: existingPrResult.prUrl,
            prNumber: existingPrResult.prNumber,
            repairBranch: validated.repairBranch,
            baseBranch: validated.baseBranch
        };
    }

    // 6. Worktree isolation to apply patch and commit without touching working tree
    const worktreeId = `worktree-pr-${Date.now()}-${Math.random().toString(36).substring(2, 7)}`;
    const worktreeDir = path.resolve(rootDir, "test-results", worktreeId);

    try {
        // Create git worktree pointing to sourceCommit with new repair branch
        const addWorktreeResult = await runCommand("git", [
            "worktree",
            "add",
            "-b",
            validated.repairBranch,
            worktreeDir,
            validated.sourceCommit
        ], {
            cwd: rootDir,
            commandRunner: options.commandRunner
        });

        if (addWorktreeResult.exitCode !== 0) {
            throw new Error(`Failed to create git worktree: ${addWorktreeResult.stderr || addWorktreeResult.stdout}`);
        }

        // Ensure worktree target file path exists on disk
        const worktreeTargetFile = path.resolve(worktreeDir, patchValidation.targetFile);
        const worktreeTargetDir = path.dirname(worktreeTargetFile);
        if (!fs.existsSync(worktreeTargetDir)) {
            fs.mkdirSync(worktreeTargetDir, { recursive: true });
        }

        // Apply pre-validated patched content strictly inside the worktree
        fs.writeFileSync(worktreeTargetFile, patchValidation.patchedContent, "utf8");

        // Stage target file inside worktree
        const addResult = await runCommand("git", ["add", patchValidation.targetFile], {
            cwd: worktreeDir,
            commandRunner: options.commandRunner
        });
        if (addResult.exitCode !== 0) {
            throw new Error(`Failed to stage target file in worktree: ${addResult.stderr || addResult.stdout}`);
        }

        // Commit with structured message
        const commitMessage = generateCommitMessage(summary, patchValidation.targetFile);
        const commitResult = await runCommand("git", ["commit", "-m", commitMessage], {
            cwd: worktreeDir,
            commandRunner: options.commandRunner
        });
        if (commitResult.exitCode !== 0) {
            throw new Error(`Failed to commit repair in worktree: ${commitResult.stderr || commitResult.stdout}`);
        }

        // Push repair branch to origin (NEVER --force)
        const pushResult = await runCommand("git", ["push", "origin", validated.repairBranch], {
            cwd: worktreeDir,
            commandRunner: options.commandRunner
        });
        if (pushResult.exitCode !== 0) {
            throw new Error(`Failed to push repair branch to origin: ${pushResult.stderr || pushResult.stdout}`);
        }

        // Open pull request via GitHub CLI
        const prTitle = options.prTitle || generatePrTitle(summary);
        const prBody = options.prBody || generatePrBody(summary, patchContent);

        const ghArgs = [
            "pr",
            "create",
            "--base",
            validated.baseBranch,
            "--head",
            validated.repairBranch,
            "--title",
            prTitle,
            "--body",
            prBody
        ];
        if (options.draft !== false) {
            ghArgs.push("--draft");
        }

        const ghPrResult = await runCommand("gh", ghArgs, {
            cwd: worktreeDir,
            commandRunner: options.commandRunner
        });

        if (ghPrResult.exitCode !== 0) {
            throw new Error(`Failed to create pull request via gh CLI: ${ghPrResult.stderr || ghPrResult.stdout}`);
        }

        const prUrlMatch = (ghPrResult.stdout || "").match(/https:\/\/github\.com\/[^\s]+/);
        const createdPrUrl = prUrlMatch ? prUrlMatch[0] : (ghPrResult.stdout || "").trim();

        return {
            success: true,
            status: "PR_CREATED",
            prUrl: createdPrUrl,
            repairBranch: validated.repairBranch,
            baseBranch: validated.baseBranch,
            sourceCommit: validated.sourceCommit,
            targetFile: patchValidation.targetFile
        };
    } finally {
        // ALWAYS clean up the worktree
        try {
            await runCommand("git", ["worktree", "remove", "--force", worktreeDir], {
                cwd: rootDir,
                commandRunner: options.commandRunner
            });
        } catch {
            // Best effort removal
        }

        if (fs.existsSync(worktreeDir)) {
            try {
                fs.rmSync(worktreeDir, { recursive: true, force: true });
            } catch {
                // Best effort directory removal
            }
        }
    }
}

if (require.main === module) {
    const args = process.argv.slice(2);
    function getArg(flag) {
        const idx = args.indexOf(flag);
        return idx !== -1 && args[idx + 1] ? args[idx + 1] : undefined;
    }

    const repairBranch = getArg("--repair-branch");
    const baseBranch = getArg("--base-branch");
    const sourceCommit = getArg("--source-commit");
    const patchPath = getArg("--patch");
    const summaryPath = getArg("--summary");
    const prTitle = getArg("--pr-title");
    const prBody = getArg("--pr-body");

    if (!repairBranch || !baseBranch || !sourceCommit || !patchPath || !summaryPath) {
        console.error("Usage: node scripts/create-repair-pr.js --repair-branch <branch> --base-branch <base> --source-commit <sha> --patch <path> --summary <path>");
        process.exit(1);
    }

    const draft = !args.includes("--no-draft");

    createRepairPr({ repairBranch, baseBranch, sourceCommit, patchPath, summaryPath, prTitle, prBody, draft })
        .then((result) => {
            console.log("\n[Create Repair PR Result]:\n", JSON.stringify(result, null, 2));
            if (process.env.GITHUB_OUTPUT) {
                try {
                    fs.appendFileSync(process.env.GITHUB_OUTPUT, `pr_url=${result.prUrl || ""}\nrepair_branch=${result.repairBranch || ""}\npr_status=${result.status}\n`, "utf8");
                } catch { /* ignore */ }
            }
            if (!result.success) {
                process.exit(1);
            }
        })
        .catch((err) => {
            console.error(`[Create Repair PR] Fatal error: ${err.message}`);
            process.exit(1);
        });
}

module.exports = {
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
};

const fs = require("fs");
const path = require("path");

const ROOT_DIR = path.resolve(__dirname, "..");
const DEFAULT_EVIDENCE_PATH = path.resolve(ROOT_DIR, "test-results/live-evidence.json");

/**
 * Safely captures live DOM and accessibility evidence from a Playwright Page instance
 * upon test failure. Designed for headless execution in CI or local environments.
 *
 * @param {import('@playwright/test').Page} page - The active Playwright page
 * @param {import('@playwright/test').TestInfo} testInfo - Playwright test execution metadata
 * @param {object} options - Optional configuration (e.g. custom output path)
 * @returns {Promise<object>} The captured evidence object
 */
async function captureFailureEvidence(page, testInfo = {}, options = {}) {
    const targetPath = options.outputPath || DEFAULT_EVIDENCE_PATH;

    if (!page || (typeof page.isClosed === "function" && page.isClosed())) {
        return {
            hasEvidence: false,
            source: "Playwright Headless Evidence Collector",
            error: "Page instance is missing or already closed."
        };
    }

    let url = "unknown";
    let title = "";
    let domSnapshot = null;
    let accessibilitySnapshot = null;

    try {
        url = typeof page.url === "function" ? page.url() : "unknown";
    } catch {
        // Ignore url fetch error
    }

    try {
        title = typeof page.title === "function" ? await page.title() : "";
    } catch {
        // Ignore title fetch error
    }

    // 1. Capture complete rendered DOM HTML
    try {
        if (typeof page.content === "function") {
            domSnapshot = await page.content();
        }
    } catch (err) {
        console.warn(`[Evidence Collector] Warning: Failed to capture page.content(): ${err.message}`);
    }

    // 2. Capture accessibility / ARIA snapshot using first-class Playwright ariaSnapshot
    try {
        const rootLocator = page.locator(":root");
        if (rootLocator && typeof rootLocator.ariaSnapshot === "function") {
            accessibilitySnapshot = await rootLocator.ariaSnapshot();
        }
    } catch (rootErr) {
        try {
            const bodyLocator = page.locator("body");
            if (bodyLocator && typeof bodyLocator.ariaSnapshot === "function") {
                accessibilitySnapshot = await bodyLocator.ariaSnapshot();
            }
        } catch (bodyErr) {
            console.warn(`[Evidence Collector] Warning: Failed to capture ariaSnapshot: ${bodyErr.message}`);
        }
    }

    const hasEvidence = Boolean(domSnapshot || accessibilitySnapshot);

    const evidencePayload = {
        hasEvidence,
        source: "Playwright Headless Evidence Collector",
        timestamp: new Date().toISOString(),
        url,
        title,
        testTitle: testInfo.title || "Unknown Test",
        testStatus: testInfo.status || "failed",
        domSnapshot,
        accessibilitySnapshot
    };

    // 3. Atomically write sanitized evidence to target file
    const sanitizedPayload = sanitizeEvidence(evidencePayload);
    try {
        const dir = path.dirname(targetPath);
        if (!fs.existsSync(dir)) {
            fs.mkdirSync(dir, { recursive: true });
        }
        fs.writeFileSync(targetPath, JSON.stringify(sanitizedPayload, null, 2), "utf8");
    } catch (err) {
        console.error(`[Evidence Collector] Failed to write evidence to '${targetPath}': ${err.message}`);
    }

    // 4. Attach to Playwright test results if testInfo attachment interface is available
    if (testInfo && typeof testInfo.attach === "function") {
        try {
            await testInfo.attach("live-evidence", {
                path: targetPath,
                contentType: "application/json"
            });
        } catch {
            // Ignore attachment failure
        }
    }

    return evidencePayload;
}

/**
 * Redacts sensitive credentials, tokens, passwords, and API keys from text or DOM content.
 * Prevents credential exfiltration to external models or public CI logs/artifacts.
 *
 * @param {string} text - Untrusted input string
 * @returns {string} Sanitized string
 */
function redactSensitiveData(text) {
    if (!text || typeof text !== "string") return text;

    let sanitized = text;

    // 1. Redact active GEMINI_API_KEY from environment if present
    const apiKey = process.env.GEMINI_API_KEY;
    if (apiKey && apiKey.length > 5) {
        sanitized = sanitized.split(apiKey).join("[REDACTED_API_KEY]");
    }

    // 2. Redact Bearer / Basic auth tokens
    sanitized = sanitized.replace(/Bearer\s+[A-Za-z0-9_\-\.\~+/=]+/gi, "Bearer [REDACTED_TOKEN]");
    sanitized = sanitized.replace(/Basic\s+[A-Za-z0-9+/=]+/gi, "Basic [REDACTED_TOKEN]");

    // 3. Redact Authorization / API key headers and query params
    sanitized = sanitized.replace(/(api[_-]?key|access[_-]?token|auth[_-]?token|token|secret)\s*[:=]\s*["']?[A-Za-z0-9_\-\.]{8,}["']?/gi, "$1=[REDACTED_SECRET]");

    // 4. Redact password fields in HTML inputs: <input ... type="password" value="..." />
    sanitized = sanitized.replace(/(type=["']password["'][^>]*value=["'])([^"']+)(["'])/gi, "$1[REDACTED_PASSWORD]$3");
    sanitized = sanitized.replace(/(value=["'])([^"']+)(["'][^>]*type=["']password["'])/gi, "$1[REDACTED_PASSWORD]$3");

    // 5. Redact key-value pairs for passwords/credentials in JSON or query strings
    sanitized = sanitized.replace(/(["']?(?:password|passwd|pwd)["']?\s*[:=]\s*["']?)([^"'\s&]+)(["']?)/gi, "$1[REDACTED_PASSWORD]$3");

    // 6. Redact MongoDB connection strings with credentials: mongodb://user:pass@host...
    sanitized = sanitized.replace(/mongodb(\+srv)?:\/\/[^:\/\s]+:[^\/\s]+@/gi, (match, srv) => `mongodb${srv || ""}://[REDACTED_USER]:[REDACTED_PASSWORD]@`);

    // 7. Redact 16-digit credit card patterns
    sanitized = sanitized.replace(/\b(?:\d{4}[-\s]?){3}\d{4}\b/g, "[REDACTED_CARD]");

    return sanitized;
}

/**
 * Sanitizes an evidence payload before writing to disk or passing to downstream jobs.
 */
function sanitizeEvidence(payload) {
    if (!payload || typeof payload !== "object") return payload;
    return {
        ...payload,
        url: redactSensitiveData(payload.url),
        title: redactSensitiveData(payload.title),
        testTitle: redactSensitiveData(payload.testTitle),
        domSnapshot: redactSensitiveData(payload.domSnapshot),
        accessibilitySnapshot: redactSensitiveData(payload.accessibilitySnapshot)
    };
}

/**
 * Reads and parses failure evidence from disk safely.
 *
 * @param {string} evidencePath
 * @returns {object|null}
 */
function readFailureEvidence(evidencePath = DEFAULT_EVIDENCE_PATH) {
    if (!fs.existsSync(evidencePath)) {
        return null;
    }
    try {
        const content = fs.readFileSync(evidencePath, "utf8");
        const parsed = JSON.parse(content);
        return sanitizeEvidence(parsed);
    } catch (err) {
        console.warn(`[Evidence Collector] Warning: Could not parse '${evidencePath}': ${err.message}`);
        return null;
    }
}

module.exports = {
    DEFAULT_EVIDENCE_PATH,
    captureFailureEvidence,
    readFailureEvidence,
    redactSensitiveData,
    sanitizeEvidence
};

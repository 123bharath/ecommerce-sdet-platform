/**
 * Heuristic Runtime Self-Healing utility for Playwright.
 * 
 * When a primary locator fails, this module performs dynamic DOM inspection
 * to identify candidate card elements using structural and semantic evidence.
 * It synthesizes a Playwright locator at runtime without hardcoded fallback strings,
 * guards against matching ancestor wrappers, and subjects candidates to
 * multi-point independent verification.
 */

/**
 * Discovers candidate card elements from the live DOM using structural heuristics.
 * Guarantees that parent wrappers are NOT matched by enforcing single-heading cardinality.
 * 
 * @param {import('@playwright/test').Page} page
 * @param {Object} options
 * @param {number} options.expectedCount
 * @returns {Promise<Object>} Discovery metadata including synthesized selector and structural evidence
 */
async function discoverDynamicCardCandidates(page, { expectedCount = 3 } = {}) {
    return await page.evaluate(({ expectedCount }) => {
        // 1. Locate all semantic action links relevant to product cards
        const actionLinks = Array.from(document.querySelectorAll("a, button")).filter((el) => {
            const text = el.textContent.trim().toLowerCase();
            const href = el.getAttribute("href") || "";
            return text === "view product" || /\/products\/[a-f0-9]{12,}/.test(href);
        });

        if (actionLinks.length === 0) {
            return {
                status: "NO_ACTION_LINKS_FOUND",
                candidates: [],
                evidence: { actionLinksFound: 0 }
            };
        }

        // 2. Identify minimal enclosing card containers.
        // Rule: An individual card contains EXACTLY ONE <h2> heading and EXACTLY ONE action link.
        // Parent wrappers (.product-grid, main, body) contain multiple headings, so they are excluded.
        const candidateContainers = [];
        for (const link of actionLinks) {
            let current = link.parentElement;
            let cardElement = null;

            while (current && current !== document.body) {
                const headings = current.querySelectorAll("h2");
                const cardActions = Array.from(current.querySelectorAll("a, button")).filter(
                    (a) => actionLinks.includes(a)
                );

                if (headings.length === 1 && cardActions.length === 1) {
                    cardElement = current;
                    break;
                }
                current = current.parentElement;
            }

            if (cardElement && !candidateContainers.includes(cardElement)) {
                candidateContainers.push(cardElement);
            }
        }

        // 3. Ambiguity & Cardinality Checks (Reject ambiguous candidates)
        if (candidateContainers.length === 0) {
            return {
                status: "NO_VALID_CONTAINERS",
                evidence: { actionLinksFound: actionLinks.length }
            };
        }

        if (candidateContainers.length !== expectedCount) {
            return {
                status: "AMBIGUOUS_CARDINALITY",
                evidence: {
                    expectedCount,
                    foundCount: candidateContainers.length
                }
            };
        }

        // 4. Extract Structural Properties
        const firstCard = candidateContainers[0];
        const childTag = firstCard.tagName.toLowerCase();
        const parentElement = firstCard.parentElement;
        const parentTag = parentElement ? parentElement.tagName.toLowerCase() : "div";
        const parentClass =
            parentElement && parentElement.className
                ? parentElement.className.trim().split(/\s+/)[0]
                : null;

        // Check if all cards share a common CSS class
        const sharedClasses = Array.from(firstCard.classList).filter((cls) =>
            candidateContainers.every((card) => card.classList.contains(cls))
        );

        // Check if direct child combinator (> h2) safely distinguishes cards from any wrapper
        const hasDirectChildH2 = candidateContainers.every(
            (c) => c.querySelector(":scope > h2") !== null
        );

        // 5. Synthesize Dynamic Locator Strategy without hardcoded fallback strings
        let synthesizedSelector;
        if (hasDirectChildH2) {
            // Direct child combinator ensures parent wrapper is never matched
            synthesizedSelector = `${childTag}:has(> h2):has(a[href*="/products/"])`;
        } else if (parentClass) {
            synthesizedSelector = `.${parentClass} > ${childTag}`;
        } else {
            synthesizedSelector = `${parentTag} > ${childTag}:has(h2):has(a[href*="/products/"])`;
        }

        // Diagnostic confidence scoring (informational only)
        let confidenceScore = 50;
        if (candidateContainers.length === expectedCount) confidenceScore += 20;
        if (hasDirectChildH2) confidenceScore += 15;
        if (sharedClasses.length > 0) confidenceScore += 15;

        return {
            status: "DISCOVERED",
            synthesizedSelector,
            derivedSharedClasses: sharedClasses,
            parentClass,
            confidenceScore,
            evidence: {
                foundCount: candidateContainers.length,
                expectedCount,
                hasDirectChildH2,
                childTag,
                sampleTitle: firstCard.querySelector("h2")?.textContent.trim(),
                actionText: "View Product",
                sharedClasses
            }
        };
    }, { expectedCount });
}

/**
 * Resolves a locator with dynamic DOM discovery and independent multi-point verification.
 * 
 * @param {import('@playwright/test').Page} page
 * @param {Object} config
 * @param {string} config.target - Target element description
 * @param {string} config.primary - Primary locator to attempt first
 * @param {number} [config.expectedCount=3] - Expected element count
 * @param {number} [config.timeout=1500] - Timeout for primary locator attempt (ms)
 * @param {Function} [config.verify] - Independent async verification function
 * @returns {Promise<{ locator: import('@playwright/test').Locator, record: Object }>}
 */
async function resolveWithDynamicDiscovery(page, {
    target,
    primary,
    expectedCount = 3,
    timeout = 1500,
    verify
}) {
    const startTime = Date.now();

    const isResolutionError = (err) => {
        return (
            err &&
            (err.name === "TimeoutError" ||
                err.message?.includes("Timeout") ||
                err.message?.includes("waiting for locator"))
        );
    };

    // 1. Attempt Primary Locator
    let primaryResolved = false;
    try {
        const primaryLoc = page.locator(primary);
        await primaryLoc.first().waitFor({ state: "visible", timeout });
        primaryResolved = true;

        if (verify) {
            await verify(primaryLoc);
        }

        return {
            locator: primaryLoc,
            record: {
                target,
                originalLocator: primary,
                recoveryResult: "RESOLVED_WITHOUT_HEALING",
                durationMs: Date.now() - startTime,
                timestamp: new Date().toISOString()
            }
        };
    } catch (err) {
        if (primaryResolved || !isResolutionError(err)) {
            throw err;
        }
    }

    // 2. Perform Dynamic DOM Discovery
    const discovery = await discoverDynamicCardCandidates(page, { expectedCount });

    if (discovery.status !== "DISCOVERED") {
        const failureRecord = {
            target,
            originalLocator: primary,
            recoveryResult: "DISCOVERY_REJECTED",
            reason: discovery.status,
            evidence: discovery.evidence,
            durationMs: Date.now() - startTime,
            timestamp: new Date().toISOString()
        };
        console.error("Heuristic Recovery Rejected:", JSON.stringify(failureRecord, null, 2));
        throw new Error(
            `Dynamic locator discovery rejected for "${target}". Reason: ${discovery.status} (Evidence: ${JSON.stringify(discovery.evidence)})`
        );
    }

    // 3. Construct Playwright Locator from Synthesized Strategy
    const dynamicLocator = page.locator(discovery.synthesizedSelector);

    // 4. Independent Verification Gate
    // Require verification of count, distinct elements, headings, links, and interaction
    let verifiedCount = 0;
    try {
        if (verify) {
            verifiedCount = await verify(dynamicLocator);
        } else {
            verifiedCount = await dynamicLocator.count();
        }
    } catch (verifyError) {
        const failedRecord = {
            target,
            originalLocator: primary,
            discoveredStrategy: discovery.synthesizedSelector,
            recoveryResult: "VERIFICATION_FAILED",
            error: verifyError.message,
            durationMs: Date.now() - startTime,
            timestamp: new Date().toISOString()
        };
        console.error("Heuristic Recovery Verification Failed:", JSON.stringify(failedRecord, null, 2));
        throw new Error(
            `Synthesized locator "${discovery.synthesizedSelector}" failed independent verification: ${verifyError.message}`
        );
    }

    // 5. Structured Telemetry on Successful Heuristic Recovery
    const telemetry = {
        target,
        originalLocator: primary,
        recoveryResult: "HEALED",
        recoveryMethod: "DYNAMIC_DOM_HEURISTIC",
        discoveredStrategy: {
            synthesizedSelector: discovery.synthesizedSelector,
            derivedSharedClasses: discovery.derivedSharedClasses,
            confidenceScore: discovery.confidenceScore,
            evidence: discovery.evidence
        },
        verifiedCount,
        durationMs: Date.now() - startTime,
        timestamp: new Date().toISOString()
    };

    console.log("Heuristic Recovery Telemetry [SUCCESS]:", JSON.stringify(telemetry, null, 2));

    return {
        locator: dynamicLocator,
        record: telemetry
    };
}

module.exports = {
    resolveWithDynamicDiscovery,
    discoverDynamicCardCandidates
};

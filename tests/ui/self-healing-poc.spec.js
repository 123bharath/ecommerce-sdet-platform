const { test, expect } = require("@playwright/test");
const { ProductListPage } = require("../pages/ProductListPage");
const { resolveWithDynamicDiscovery } = require("../utils/selfHealing");

test("should demonstrate dynamic DOM locator discovery and heuristic recovery", async ({ page }) => {
    // 1. Reuse existing ProductListPage POM for navigation and heading verification
    const productsPage = new ProductListPage(page);
    await productsPage.goto();
    await expect(productsPage.heading).toBeVisible();

    // 2. Deliberately broken primary selector (No hardcoded fallback provided)
    const brokenPrimary = ".product-card-deprecated-v1";

    // 3. Independent Verification Guard:
    // Requires independent proof of count, distinct elements, headings, links, and interaction
    const independentVerification = async (cardsLocator) => {
        // A. Verify expected count
        await expect(cardsLocator).toHaveCount(3);
        const cards = await cardsLocator.all();
        expect(cards.length).toBe(3);

        // B. Verify distinct cards with valid coordinates
        const boundingBoxes = [];
        for (const card of cards) {
            const box = await card.boundingBox();
            expect(box).toBeTruthy();

            // Ensure this card's coordinates are distinct from previous cards (not a duplicated handle)
            const isDuplicate = boundingBoxes.some(
                (b) => Math.abs(b.x - box.x) < 2 && Math.abs(b.y - box.y) < 2
            );
            expect(isDuplicate).toBe(false);
            boundingBoxes.push(box);

            // C. Verify visible h2 heading in each card
            const heading = card.locator("h2");
            await expect(heading).toBeVisible();
            const headingText = await heading.textContent();
            expect(headingText.trim().length).toBeGreaterThan(0);

            // D. Verify visible View Product link in each card
            const viewLink = card.getByRole("link", { name: /View Product/i });
            await expect(viewLink).toBeVisible();
            const href = await viewLink.getAttribute("href");
            expect(href).toMatch(/^\/products\//);
        }

        // E. Verify successful interaction with the element
        const firstCardLink = cards[0].getByRole("link", { name: /View Product/i });
        await firstCardLink.hover();

        return cards.length;
    };

    // 4. Resolve locator using dynamic DOM discovery (no predefined fallback selectors)
    const { locator: healedCards, record } = await resolveWithDynamicDiscovery(page, {
        target: "Product Card Grid",
        primary: brokenPrimary,
        expectedCount: 3,
        timeout: 1500,
        verify: independentVerification
    });

    // 5. Assert structured heuristic recovery telemetry
    expect(record.recoveryResult).toBe("HEALED");
    expect(record.recoveryMethod).toBe("DYNAMIC_DOM_HEURISTIC");
    expect(record.originalLocator).toBe(brokenPrimary);
    expect(record.discoveredStrategy.synthesizedSelector).toBeTruthy();
    expect(record.verifiedCount).toBe(3);
    expect(record.discoveredStrategy.confidenceScore).toBeGreaterThanOrEqual(85);
    expect(record.durationMs).toBeGreaterThan(0);

    // 6. Assert that downstream test steps work with the healed locator
    await expect(healedCards).toHaveCount(3);
});

const { test, expect } = require("../fixtures/base-test");
const { ProductListPage } = require("../pages/ProductListPage");

test.describe("Diagnostic CI Failure Trial", () => {
    test("controlled stale locator failure for diagnostic verification", async ({ page }) => {
        const productsPage = new ProductListPage(page);

        // 1. Navigate to product catalog
        await productsPage.goto();

        // 2. Verify page loaded cleanly by checking genuine heading is visible
        const actualHeading = page.getByRole("heading", { level: 1, name: "Products" });
        await expect(actualHeading).toBeVisible({ timeout: 5000 });

        // 3. Deliberately stale locator lookup to trigger controlled timeout failure:
        // The live DOM physically displays "Products", but this assertion targets an evolved/stale locator.
        // This exercises headless failure evidence capture (live DOM and accessibility snapshot).
        const staleHeading = page.getByRole("heading", { level: 1, name: "Products - Stale Title Indicator" });
        await expect(staleHeading).toBeVisible({ timeout: 4000 });
    });
});

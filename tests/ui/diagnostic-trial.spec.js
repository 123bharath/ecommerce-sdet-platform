const { test, expect } = require("../fixtures/base-test");
const { ProductListPage } = require("../pages/ProductListPage");

test.describe("Diagnostic CI Failure Trial", () => {
    test("controlled stale locator failure for diagnostic verification", async ({ page }) => {
        const productsPage = new ProductListPage(page);

        // 1. Navigate to product catalog
        await productsPage.goto();

        // 2. Assert Page Object locator property
        // When the POM property has a stale locator, this assertion fails cleanly on timeout.
        await expect(productsPage.heading).toBeVisible({ timeout: 4000 });
    });
});

const { test, expect } = require("../fixtures/base-test");
const { ProductListPage } = require("../pages/ProductListPage");

test("should display the products page and all product cards", async ({ page }) => {
    const productsPage = new ProductListPage(page);

    // 1. Open the home page via Page Object action
    await productsPage.goto();

    // 2. Verify that the main Products heading is visible
    await expect(productsPage.heading).toBeVisible();

    // 3. Verify that exactly three product cards are rendered
    await expect(productsPage.productCards).toHaveCount(3);

    // 4. Verify that each individual product card is visible
    const cards = await productsPage.productCards.all();
    for (const card of cards) {
        await expect(card).toBeVisible();
    }

    // 5. Verify that the three product titles are visible without using database IDs
    const expectedProductNames = [
        "Playwright Laptop",
        "Laptop",
        "Washing Machine"
    ];

    for (const productName of expectedProductNames) {
        await expect(
            productsPage.getProductNameHeading(productName)
        ).toBeVisible();
    }
});

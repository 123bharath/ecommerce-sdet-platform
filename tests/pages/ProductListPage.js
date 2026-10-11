/**
 * Page Object representing the Products catalog page.
 * Centralizes navigation and element locators for UI tests and AI healing.
 */
class ProductListPage {
    /**
     * @param {import('@playwright/test').Page} page
     */
    constructor(page) {
        this.page = page;

        // Centralized Locators (Single Source of Truth)
        this.heading = page.getByRole("heading", { level: 1, name: "Products" });
        this.productCards = page.locator(".product-card");
    }

    /**
     * Navigates to the products catalog page using the configured baseURL
     */
    async goto() {
        await this.page.goto("/");
    }

    /**
     * Dynamic locator for individual product title headings
     * @param {string} productName
     */
    getProductNameHeading(productName) {
        return this.page.getByRole("heading", {
            level: 2,
            name: productName,
            exact: true
        });
    }
}

module.exports = { ProductListPage };

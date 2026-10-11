const { test: base } = require("@playwright/test");
const { validProduct } = require("../test-data/product.data");

const test = base.extend({
    product: async ({ request }, use) => {
        const response = await request.post("/api/products", {
            data: validProduct
        });

        const product = await response.json();

        await use(product);

        await request.delete(`/api/products/${product._id}`);
    }
});

module.exports = { test };
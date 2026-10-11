const { test } = require("../../fixtures/product.fixture");
const { expect } = require("@playwright/test");
const { validProduct } = require("../../test-data/product.data");

test("should retrieve the created product", async ({ request, product }) => {

    expect(product._id).toBeTruthy();
    expect(typeof product._id).toBe("string");

    const getResponse = await request.get(`/api/products/${product._id}`);

    expect(getResponse.status()).toBe(200);

    const fetchedProduct = await getResponse.json();

    expect(fetchedProduct._id).toBe(product._id);
    expect(fetchedProduct.name).toBe(product.name);
    expect(fetchedProduct.price).toBe(product.price);
    expect(fetchedProduct.category).toBe(product.category);
});

test("should update an existing product", async ({ request, product }) => {
    const updatedData = {
        name: "Updated Laptop",
        description: "Updated through Playwright",
        price: 65000,
        category: "Electronics",
        stock: 20
    };

    const response = await request.put(`/api/products/${product._id}`, {
        data: updatedData
    });

    expect(response.status()).toBe(200);

    const updatedProduct = await response.json();

    expect(updatedProduct._id).toBe(product._id);
    expect(updatedProduct.name).toBe(updatedData.name);
    expect(updatedProduct.description).toBe(updatedData.description);
    expect(updatedProduct.price).toBe(updatedData.price);
    expect(updatedProduct.stock).toBe(updatedData.stock);
});

test("should reject product creation when price is missing", async ({ request }) => {
    const response = await request.post("/api/products", {
        data: {
            name: "Invalid Product",
            description: "Price is missing",
            category: "Electronics",
            stock: 10
        }
    });

    expect(response.status()).toBe(400);
});

test("should reject product with negative price", async ({ request }) => {
    const response = await request.post("/api/products", {
        data: {
            name: "Invalid Product",
            description: "Negative price",
            price: -1,
            category: "Electronics",
            stock: 10
        }
    });

    expect(response.status()).toBe(400);
});
test("should reject product with negative stock", async ({ request }) => {
    const response = await request.post("/api/products", {
        data: {
            name: "Invalid Product",
            description: "Negative stock",
            price: 50000,
            category: "Electronics",
            stock: -1
        }
    });

    expect(response.status()).toBe(400);
});
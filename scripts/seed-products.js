/**
 * Seeds initial product catalog for E2E tests if not already present.
 * Used during CI / local test setup to ensure prerequisites are satisfied.
 */

const API_BASE_URL = process.env.API_BASE_URL || "http://localhost:4000";

const SEED_PRODUCTS = [
    {
        name: "Playwright Laptop",
        description: "Created through Playwright API test",
        price: 60000,
        category: "Electronics",
        stock: 10
    },
    {
        name: "Laptop",
        description: "Test laptop",
        price: 50000,
        category: "Electronics Put",
        stock: 10
    },
    {
        name: "Washing Machine",
        description: "This is used to wash clothes",
        price: 30000,
        category: "Home Appliances",
        stock: 50
    }
];

async function seed() {
    console.log(`[Seed] Checking product catalog at ${API_BASE_URL}/api/products...`);
    try {
        const res = await fetch(`${API_BASE_URL}/api/products`);
        if (!res.ok) {
            throw new Error(`Failed to fetch products: ${res.status} ${res.statusText}`);
        }
        const existing = await res.json();
        const existingNames = new Set(existing.map((p) => p.name));

        for (const item of SEED_PRODUCTS) {
            if (!existingNames.has(item.name)) {
                console.log(`[Seed] Seeding product: "${item.name}"...`);
                const postRes = await fetch(`${API_BASE_URL}/api/products`, {
                    method: "POST",
                    headers: { "Content-Type": "application/json" },
                    body: JSON.stringify(item)
                });
                if (!postRes.ok) {
                    const errorText = await postRes.text();
                    throw new Error(`Failed to seed "${item.name}": ${postRes.status} ${errorText}`);
                }
                console.log(`[Seed] Successfully created "${item.name}".`);
            } else {
                console.log(`[Seed] Product "${item.name}" already exists.`);
            }
        }

        console.log("[Seed] Catalog verification complete.");
    } catch (err) {
        console.error(`[Seed] Error seeding products: ${err.message}`);
        process.exit(1);
    }
}

seed();


const { defineConfig } = require("@playwright/test");

module.exports = defineConfig({
    testDir: "./tests",

    reporter: [
        ["html"],
        ["json", { outputFile: "test-results/results.json" }]
    ],

    projects: [
        {
            name: "api",
            testMatch: "**/api/**/*.spec.js",
            use: {
                baseURL: "http://localhost:4000"
            }
        },
        {
            name: "ui",
            testMatch: "**/ui/**/*.spec.js",
            use: {
                baseURL: "http://localhost:5173",
                browserName: "chromium",
                trace: "retain-on-failure",
                screenshot: "only-on-failure"
            }
        }
    ]
});

const { defineConfig } = require("@playwright/test");

module.exports = defineConfig({
    testDir: "./tests",

    use: {
        baseURL: "http://localhost:4000"
    },

    reporter: "html"
});
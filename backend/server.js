const express = require("express");
const dotenv = require("dotenv");
const connectDatabase = require("./src/config/database");
const productRoutes = require("./src/routes/product.routes");

dotenv.config();

const app = express();

const PORT = process.env.PORT || 4000;

app.use(express.json());

app.use("/api/products", productRoutes);

const startServer = async () => {
    await connectDatabase();

    app.listen(PORT, () => {
        console.log(`Server running on http://localhost:${PORT}`);
    });
};

startServer();
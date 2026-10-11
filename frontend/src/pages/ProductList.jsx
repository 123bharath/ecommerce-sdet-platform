import { useEffect, useState } from "react";
import ProductCard from "../components/ProductCard";
import "./ProductList.css";

function ProductList() {
    const [products, setProducts] = useState([]);
    const [loading, setLoading] = useState(true);
    const [error, setError] = useState("");

    useEffect(() => {
        const fetchProducts = async () => {
            try {
                const response = await fetch(
                    "http://localhost:4000/api/products"
                );

                if (!response.ok) {
                    throw new Error("Failed to fetch products");
                }

                const data = await response.json();

                setProducts(data);
            } catch (error) {
                setError(error.message);
            } finally {
                setLoading(false);
            }
        };

        fetchProducts();
    }, []);

    if (loading) {
        return <p>Loading products...</p>;
    }

    if (error) {
        return <p>{error}</p>;
    }

    return (
        <div className="product-list-page">
            <div className="product-list-header">
                <h1>Products</h1>
                <p>Browse our available products</p>
            </div>

            <div className="product-grid">
                {products.map((product) => (
                    <ProductCard
                        key={product._id}
                        product={product}
                    />
                ))}
            </div>
        </div>
    );
}

export default ProductList;
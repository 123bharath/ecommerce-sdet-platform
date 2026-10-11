import { useEffect, useState } from "react";
import { Link, useNavigate, useParams } from "react-router-dom";
import DeleteProduct from "../components/DeleteProduct";
import "./ProductDetails.css";

function ProductDetails() {
    const { id } = useParams();
    const navigate = useNavigate();

    const [product, setProduct] = useState(null);
    const [loading, setLoading] = useState(true);
    const [error, setError] = useState("");
    const [success, setSuccess] = useState("");
    const [showDeleteModal, setShowDeleteModal] = useState(false);

    useEffect(() => {
        const fetchProduct = async () => {
            try {
                const response = await fetch(
                    `http://localhost:4000/api/products/${id}`
                );

                if (!response.ok) {
                    throw new Error("Product not found");
                }

                const data = await response.json();

                setProduct(data);
            } catch (error) {
                setError(error.message);
            } finally {
                setLoading(false);
            }
        };

        fetchProduct();
    }, [id]);

    const handleDelete = async () => {
        try {
            setError("");

            const response = await fetch(
                `http://localhost:4000/api/products/${id}`,
                {
                    method: "DELETE"
                }
            );

            if (!response.ok) {
                throw new Error("Failed to delete product");
            }

            setShowDeleteModal(false);
            setSuccess("Product deleted successfully");

            setTimeout(() => {
                navigate("/");
            }, 1500);
        } catch (error) {
            setShowDeleteModal(false);
            setError(error.message);
        }
    };

    if (loading) {
        return <p>Loading product...</p>;
    }

    if (error && !product) {
        return <p>{error}</p>;
    }

    return (
        <div className="product-details-page">

            {success && (
                <div className="success-toast">
                    ✓ {success}
                </div>
            )}

            {error && (
                <div className="form-error">
                    {error}
                </div>
            )}

            <Link to="/" className="back-link">
                ← Back to Products
            </Link>

            <div className="product-details-card">

                <div className="product-details-info">

                    <h1>{product.name}</h1>

                    <p className="product-details-description">
                        {product.description}
                    </p>

                    <p className="product-details-price">
                        ₹{product.price}
                    </p>

                    <p className="product-details-category">
                        Category: {product.category}
                    </p>

                    <p className="product-details-stock">
                        Stock available: {product.stock}
                    </p>

                    <div className="product-details-actions">

                        <Link
                            to={`/products/${product._id}/edit`}
                            className="edit-product-button"
                        >
                            Edit Product
                        </Link>

                        <button>
                            Add to Cart
                        </button>

                        <button>
                            Buy Now
                        </button>

                        <button
                            className="delete-product-button"
                            onClick={() => setShowDeleteModal(true)}
                        >
                            Delete Product
                        </button>

                    </div>

                </div>

            </div>

            {showDeleteModal && (
                <DeleteProduct
                    onCancel={() => setShowDeleteModal(false)}
                    onConfirm={handleDelete}
                />
            )}

        </div>
    );
}

export default ProductDetails;
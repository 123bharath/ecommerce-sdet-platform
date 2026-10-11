import { useEffect, useState } from "react";
import { Link, useParams } from "react-router-dom";
import "./EditProduct.css";

function EditProduct() {
    const { id } = useParams();

    const [formData, setFormData] = useState({
        name: "",
        description: "",
        price: "",
        category: "",
        stock: ""
    });

    const [loading, setLoading] = useState(true);
    const [error, setError] = useState("");
    const [success, setSuccess] = useState("");

    useEffect(() => {
        const fetchProduct = async () => {
            try {
                const response = await fetch(
                    `http://localhost:4000/api/products/${id}`
                );

                if (!response.ok) {
                    throw new Error("Product not found");
                }

                const product = await response.json();

                setFormData({
                    name: product.name,
                    description: product.description,
                    price: product.price,
                    category: product.category,
                    stock: product.stock
                });
            } catch (error) {
                setError(error.message);
            } finally {
                setLoading(false);
            }
        };

        fetchProduct();
    }, [id]);

    if (loading) {
        return <p>Loading product...</p>;
    }

    const handleSubmit = async (event) => {
        event.preventDefault();

        try {
            const response = await fetch(
                `http://localhost:4000/api/products/${id}`,
                {
                    method: "PUT",
                    headers: {
                        "Content-Type": "application/json"
                    },
                    body: JSON.stringify({
                        ...formData,
                        price: Number(formData.price),
                        stock: Number(formData.stock)
                    })
                }
            );

            if (!response.ok) {
                throw new Error("Failed to update product");
            }

            setSuccess("Product updated successfully");

            setTimeout(() => {
                setSuccess("");
            }, 3000);
        } catch (error) {
            setError(error.message);
        }
    };

    return (
        <div className="edit-product-page">

            <Link to={`/products/${id}`} className="back-link">
                ← Back to Product
            </Link>

            {success && (
                <div className="success-toast">
                    ✓ {success}
                </div>
            )}

            <div className="edit-product-header">
                <h1>Edit Product</h1>
                <p>Update the details of your product.</p>
            </div>

            {error && (
                <div className="form-error">
                    {error}
                </div>
            )}

            <form
                className="edit-product-form"
                onSubmit={handleSubmit}
            >
                <div className="form-group">
                    <label>Product Name</label>

                    <input
                        name="name"
                        placeholder="Enter product name"
                        value={formData.name}
                        onChange={(event) =>
                            setFormData({
                                ...formData,
                                name: event.target.value
                            })
                        }
                    />
                </div>

                <div className="form-group">
                    <label>Description</label>

                    <textarea
                        name="description"
                        placeholder="Enter product description"
                        value={formData.description}
                        onChange={(event) =>
                            setFormData({
                                ...formData,
                                description: event.target.value
                            })
                        }
                    />
                </div>

                <div className="form-row">
                    <div className="form-group">
                        <label>Price</label>

                        <input
                            name="price"
                            type="number"
                            placeholder="Enter price"
                            value={formData.price}
                            onChange={(event) =>
                                setFormData({
                                    ...formData,
                                    price: event.target.value
                                })
                            }
                        />
                    </div>

                    <div className="form-group">
                        <label>Stock</label>

                        <input
                            name="stock"
                            type="number"
                            placeholder="Enter stock"
                            value={formData.stock}
                            onChange={(event) =>
                                setFormData({
                                    ...formData,
                                    stock: event.target.value
                                })
                            }
                        />
                    </div>
                </div>

                <div className="form-group">
                    <label>Category</label>

                    <input
                        name="category"
                        placeholder="Enter category"
                        value={formData.category}
                        onChange={(event) =>
                            setFormData({
                                ...formData,
                                category: event.target.value
                            })
                        }
                    />
                </div>

                <button type="submit">
                    Save Changes
                </button>
            </form>
        </div>
    );
}

export default EditProduct;
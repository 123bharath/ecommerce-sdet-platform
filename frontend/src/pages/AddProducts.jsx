import { useState } from "react";
import "./AddProduct.css";

function AddProduct() {
    const [formData, setFormData] = useState({
        name: "",
        description: "",
        price: "",
        category: "",
        stock: ""
    });

    const [message, setMessage] = useState("");

    const handleChange = (event) => {
        const { name, value } = event.target;

        setFormData({
            ...formData,
            [name]: value
        });
    };

    const handleSubmit = async (event) => {
        event.preventDefault();

        try {
            const response = await fetch(
                "http://localhost:4000/api/products",
                {
                    method: "POST",
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
                throw new Error("Failed to create product");
            }

            setMessage("Product created successfully");

            setFormData({
                name: "",
                description: "",
                price: "",
                category: "",
                stock: ""
            });
        } catch (error) {
            setMessage(error.message);
        }
    };

    return (
        <div>
            <h1>Add Product</h1>

            <form className="add-product-form" onSubmit={handleSubmit}>
                <input
                    name="name"
                    placeholder="Product name"
                    value={formData.name}
                    onChange={handleChange}
                />

                <input
                    name="description"
                    placeholder="Description"
                    value={formData.description}
                    onChange={handleChange}
                />

                <input
                    name="price"
                    type="number"
                    placeholder="Price"
                    value={formData.price}
                    onChange={handleChange}
                />

                <input
                    name="category"
                    placeholder="Category"
                    value={formData.category}
                    onChange={handleChange}
                />

                <input
                    name="stock"
                    type="number"
                    placeholder="Stock"
                    value={formData.stock}
                    onChange={handleChange}
                />

                <button type="submit">
                    Add Product
                </button>
            </form>

            {message && <p>{message}</p>}
        </div>
    );
}

export default AddProduct;
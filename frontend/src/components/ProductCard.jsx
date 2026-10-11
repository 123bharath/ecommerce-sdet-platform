import { Link } from "react-router-dom";
import "./ProductCard.css";

function ProductCard({ product }) {
    return (
        <div className="product-card">
            <h2>{product.name}</h2>
            <p>{product.description}</p>
            <p>₹{product.price}</p>
            <p>{product.category}</p>
            <p>Stock: {product.stock}</p>

            <Link to={`/products/${product._id}`}>
                View Product
            </Link>
        </div>
    );
}

export default ProductCard;
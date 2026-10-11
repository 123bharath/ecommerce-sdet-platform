import { Link } from "react-router-dom";
import "./Navbar.css";

function Navbar() {
    return (
        <nav className="navbar">
            <Link to="/" className="navbar-brand">
                ShopApp
            </Link>

            <div className="navbar-links">
                <Link to="/">Products</Link>

                <Link to="/products/add">
                    Add Product
                </Link>
            </div>
        </nav>
    );
}

export default Navbar;
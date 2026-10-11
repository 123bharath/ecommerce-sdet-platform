import "./DeleteProduct.css";

function DeleteProduct({ onCancel, onConfirm }) {
    return (
        <div className="delete-modal-overlay">
            <div className="delete-modal">
                <h2>Delete Product?</h2>

                <p>
                    Are you sure you want to delete this product?
                    This action cannot be undone.
                </p>

                <div className="delete-modal-actions">
                    <button
                        className="cancel-delete-button"
                        onClick={onCancel}
                    >
                        Cancel
                    </button>

                    <button
                        className="confirm-delete-button"
                        onClick={onConfirm}
                    >
                        Delete Product
                    </button>
                </div>
            </div>
        </div>
    );
}

export default DeleteProduct;
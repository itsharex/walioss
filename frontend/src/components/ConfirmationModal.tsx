import React from 'react';
import './Modal.css';

interface ConfirmationModalProps {
  isOpen: boolean;
  title: string;
  description: string;
  onConfirm: () => void;
  onCancel: () => void;
  isLoading?: boolean;
}

const ConfirmationModal: React.FC<ConfirmationModalProps> = ({ 
  isOpen, 
  title, 
  description, 
  onConfirm, 
  onCancel,
  isLoading 
}) => {
  if (!isOpen) return null;

  return (
    <div className="modal-overlay">
      <div className="modal-content">
        <div className="modal-header">
          <h3 className="modal-title">{title}</h3>
        </div>
        <p className="modal-description">{description}</p>
        <div className="modal-actions">
          <button 
            className="modal-btn modal-btn-cancel" 
            onClick={onCancel}
            disabled={isLoading}
          >
            Cancel
          </button>
          <button 
            className="modal-btn modal-btn-danger" 
            onClick={onConfirm}
            disabled={isLoading}
          >
            {isLoading ? 'Processing...' : 'Confirm'}
          </button>
        </div>
      </div>
    </div>
  );
};

export default ConfirmationModal;

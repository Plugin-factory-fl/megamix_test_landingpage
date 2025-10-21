-- Database schema for MegaMixAI licensing system

-- Create licenses table
CREATE TABLE IF NOT EXISTS licenses (
    id SERIAL PRIMARY KEY,
    license_key VARCHAR(20) UNIQUE NOT NULL,
    customer_email VARCHAR(255) NOT NULL,
    stripe_customer_id VARCHAR(255),
    stripe_subscription_id VARCHAR(255),
    status VARCHAR(50) DEFAULT 'active', -- active, expired, cancelled
    created_at TIMESTAMP DEFAULT CURRENT_TIMESTAMP,
    expires_at TIMESTAMP,
    hardware_fingerprint VARCHAR(255), -- For device binding
    last_validated_at TIMESTAMP,
    validation_count INTEGER DEFAULT 0
);

-- Create payments table to track payment history
CREATE TABLE IF NOT EXISTS payments (
    id SERIAL PRIMARY KEY,
    license_id INTEGER REFERENCES licenses(id),
    stripe_payment_intent_id VARCHAR(255),
    amount INTEGER NOT NULL, -- Amount in cents
    currency VARCHAR(3) DEFAULT 'usd',
    status VARCHAR(50) NOT NULL, -- succeeded, failed, pending
    created_at TIMESTAMP DEFAULT CURRENT_TIMESTAMP
);

-- Create validation_logs table to track license validations
CREATE TABLE IF NOT EXISTS validation_logs (
    id SERIAL PRIMARY KEY,
    license_key VARCHAR(20) NOT NULL,
    hardware_fingerprint VARCHAR(255),
    ip_address INET,
    user_agent TEXT,
    validation_result VARCHAR(50) NOT NULL, -- valid, invalid, expired
    created_at TIMESTAMP DEFAULT CURRENT_TIMESTAMP
);

-- Create indexes for better performance
CREATE INDEX IF NOT EXISTS idx_licenses_key ON licenses(license_key);
CREATE INDEX IF NOT EXISTS idx_licenses_customer ON licenses(customer_email);
CREATE INDEX IF NOT EXISTS idx_licenses_stripe_customer ON licenses(stripe_customer_id);
CREATE INDEX IF NOT EXISTS idx_payments_license ON payments(license_id);
CREATE INDEX IF NOT EXISTS idx_validation_logs_key ON validation_logs(license_key);

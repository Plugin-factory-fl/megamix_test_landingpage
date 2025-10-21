const express = require('express');
const stripe = require('stripe')(process.env.STRIPE_SECRET_KEY);
const cors = require('cors');
const { pool, initializeDatabase } = require('./database/connection');
require('dotenv').config();

const app = express();
const PORT = process.env.PORT || 3000;

// Middleware
app.use(cors());

// Webhook endpoint for Stripe events (must be before express.json() middleware)
app.post('/webhooks/stripe', express.raw({type: 'application/json'}), async (req, res) => {
  const sig = req.headers['stripe-signature'];
  let event;

  try {
    event = stripe.webhooks.constructEvent(req.body, sig, process.env.STRIPE_WEBHOOK_SECRET);
  } catch (err) {
    console.log(`Webhook signature verification failed.`, err.message);
    return res.status(400).send(`Webhook Error: ${err.message}`);
  }

  // Handle the event
  switch (event.type) {
    case 'checkout.session.completed':
      const session = event.data.object;
      console.log('Payment successful for session:', session.id);
      
      // Generate license key and send email
      await handleSuccessfulPayment(session);
      break;
      
    case 'invoice.payment_succeeded':
      console.log('Subscription payment succeeded');
      break;
      
    case 'invoice.payment_failed':
      console.log('Subscription payment failed');
      break;
      
    default:
      console.log(`Unhandled event type ${event.type}`);
  }

  res.json({received: true});
});

// Add express.json() middleware after webhook route
app.use(express.json());
app.use(express.static('public')); // Serve static files (like your HTML)

// Stripe Price ID - Using the test mode price ID
const PRICE_ID = process.env.STRIPE_PRICE_ID || 'price_1SKfpAIKMp3hwEiGikOOb0aN';

// Create checkout session endpoint
app.post('/create-checkout-session', async (req, res) => {
  try {
    const { priceId = PRICE_ID } = req.body;

    const session = await stripe.checkout.sessions.create({
      mode: 'subscription',
      payment_method_types: ['card'],
      line_items: [
        {
          price: priceId,
          quantity: 1,
        },
      ],
      success_url: `${process.env.BASE_URL || 'http://localhost:3000'}/success?session_id={CHECKOUT_SESSION_ID}`,
      cancel_url: `${process.env.BASE_URL || 'http://localhost:3000'}/cancel`,
      metadata: {
        product: 'megamixai-plugin'
      }
    });

    res.json({ url: session.url });
  } catch (error) {
    console.error('Error creating checkout session:', error);
    res.status(500).json({ error: 'Failed to create checkout session' });
  }
});

// Success page
app.get('/success', (req, res) => {
  res.send(`
    <html>
      <body style="font-family: Arial, sans-serif; text-align: center; padding: 50px; background: #1a1a1a; color: white;">
        <h1 style="color: #10b981;">Payment Successful!</h1>
        <p>Thank you for purchasing MegaMixAI. Check your email for your license key.</p>
        <p>Session ID: ${req.query.session_id}</p>
      </body>
    </html>
  `);
});

// Cancel page
app.get('/cancel', (req, res) => {
  res.send(`
    <html>
      <body style="font-family: Arial, sans-serif; text-align: center; padding: 50px; background: #1a1a1a; color: white;">
        <h1 style="color: #ef4444;">Payment Cancelled</h1>
        <p>Your payment was cancelled. You can try again anytime.</p>
        <a href="/" style="color: #10b981; text-decoration: none;">← Back to Home</a>
      </body>
    </html>
  `);
});


// Function to handle successful payment
async function handleSuccessfulPayment(session) {
  try {
    // Generate a license key
    const licenseKey = generateLicenseKey();
    
    // Get customer email from session
    const customer = await stripe.customers.retrieve(session.customer);
    const email = customer.email;
    
    // Store license in database
    const result = await pool.query(
      `INSERT INTO licenses (license_key, customer_email, stripe_customer_id, stripe_subscription_id, status, expires_at)
       VALUES ($1, $2, $3, $4, $5, $6)
       RETURNING id`,
      [
        licenseKey,
        email,
        session.customer,
        session.subscription,
        'active',
        new Date(Date.now() + 30 * 24 * 60 * 60 * 1000) // 30 days from now
      ]
    );
    
    const licenseId = result.rows[0].id;
    
    // Store payment record
    await pool.query(
      `INSERT INTO payments (license_id, stripe_payment_intent_id, amount, currency, status)
       VALUES ($1, $2, $3, $4, $5)`,
      [
        licenseId,
        session.payment_intent,
        1499, // $14.99 in cents
        'usd',
        'succeeded'
      ]
    );
    
    console.log(`Generated license key ${licenseKey} for customer ${email}`);
    console.log(`License stored in database with ID: ${licenseId}`);
    
    // TODO: Send email with license key
    
  } catch (error) {
    console.error('Error handling successful payment:', error);
  }
}

// Generate a license key
function generateLicenseKey() {
  const chars = 'ABCDEFGHIJKLMNOPQRSTUVWXYZ0123456789';
  let result = '';
  for (let i = 0; i < 16; i++) {
    result += chars.charAt(Math.floor(Math.random() * chars.length));
  }
  return result.match(/.{1,4}/g).join('-'); // Format: XXXX-XXXX-XXXX-XXXX
}

// License validation endpoint (for the plugin to call)
app.post('/verify-license', async (req, res) => {
  try {
    const { licenseKey, hardwareFingerprint } = req.body;
    
    if (!licenseKey) {
      return res.status(400).json({ error: 'License key is required' });
    }
    
    // Query database for license
    const result = await pool.query(
      `SELECT * FROM licenses WHERE license_key = $1`,
      [licenseKey]
    );
    
    if (result.rows.length === 0) {
      // Log invalid validation attempt
      await pool.query(
        `INSERT INTO validation_logs (license_key, hardware_fingerprint, ip_address, user_agent, validation_result)
         VALUES ($1, $2, $3, $4, $5)`,
        [licenseKey, hardwareFingerprint, req.ip, req.get('User-Agent'), 'invalid']
      );
      
      return res.status(404).json({ error: 'Invalid license key' });
    }
    
    const license = result.rows[0];
    
    // Check if license is expired
    if (new Date() > new Date(license.expires_at)) {
      await pool.query(
        `INSERT INTO validation_logs (license_key, hardware_fingerprint, ip_address, user_agent, validation_result)
         VALUES ($1, $2, $3, $4, $5)`,
        [licenseKey, hardwareFingerprint, req.ip, req.get('User-Agent'), 'expired']
      );
      
      return res.status(403).json({ error: 'License has expired' });
    }
    
    // Check if license is active
    if (license.status !== 'active') {
      return res.status(403).json({ error: 'License is not active' });
    }
    
    // Update license validation info
    await pool.query(
      `UPDATE licenses SET 
       last_validated_at = CURRENT_TIMESTAMP,
       validation_count = validation_count + 1,
       hardware_fingerprint = COALESCE(hardware_fingerprint, $1)
       WHERE id = $2`,
      [hardwareFingerprint, license.id]
    );
    
    // Log successful validation
    await pool.query(
      `INSERT INTO validation_logs (license_key, hardware_fingerprint, ip_address, user_agent, validation_result)
       VALUES ($1, $2, $3, $4, $5)`,
      [licenseKey, hardwareFingerprint, req.ip, req.get('User-Agent'), 'valid']
    );
    
    res.json({
      valid: true,
      license: {
        key: license.license_key,
        customer_email: license.customer_email,
        expires_at: license.expires_at,
        status: license.status
      }
    });
    
  } catch (error) {
    console.error('Error verifying license:', error);
    res.status(500).json({ error: 'Internal server error' });
  }
});

// Health check endpoint
app.get('/health', (req, res) => {
  res.json({ status: 'OK', timestamp: new Date().toISOString() });
});

// Serve the main page
app.get('/', (req, res) => {
  res.sendFile(__dirname + '/index.html');
});

// Initialize database and start server
async function startServer() {
  try {
    // Initialize database schema
    await initializeDatabase();
    
    // Start the server
    app.listen(PORT, () => {
      console.log(`Server running on port ${PORT}`);
      console.log(`Health check: http://localhost:${PORT}/health`);
      console.log(`License validation: POST http://localhost:${PORT}/verify-license`);
    });
  } catch (error) {
    console.error('Failed to start server:', error);
    process.exit(1);
  }
}

startServer();

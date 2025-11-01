const express = require('express');
const stripe = require('stripe')(process.env.STRIPE_SECRET_KEY);
const cors = require('cors');
const jwt = require('jsonwebtoken');
const { pool, initializeDatabase } = require('./database/connection');
require('dotenv').config();

const app = express();
const PORT = process.env.PORT || 3000;

// Middleware
app.use(cors());

// Serve static files from the assets directory
app.use('/assets', express.static('assets'));

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
      success_url: `${process.env.BASE_URL || 'https://megamixai-mvp-backend.onrender.com'}/success?session_id={CHECKOUT_SESSION_ID}`,
      cancel_url: `${process.env.BASE_URL || 'https://megamixai-mvp-backend.onrender.com'}/cancel`,
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
app.get('/success', async (req, res) => {
  try {
    const sessionId = req.query.session_id;
    
    // Get license key from database using session ID
    // Get the Stripe session to find the customer
    const session = await stripe.checkout.sessions.retrieve(sessionId);
    const customerId = session.customer;
    
    // Find the license for this customer
    const result = await pool.query(
      `SELECT license_key FROM licenses WHERE stripe_customer_id = $1 ORDER BY created_at DESC LIMIT 1`,
      [customerId]
    );
    
    let licenseKey = 'XXXX-XXXX-XXXX-XXXX'; // Default if not found
    if (result.rows.length > 0) {
      licenseKey = result.rows[0].license_key;
    }
    
    res.send(`
      <html>
        <head>
          <title>Payment Successful - MegaMixAI</title>
          <style>
            body {
              font-family: 'Segoe UI', Tahoma, Geneva, Verdana, sans-serif;
              background: linear-gradient(135deg, #1a1a1a 0%, #2d2d2d 100%);
              color: white;
              text-align: center;
              padding: 50px;
              margin: 0;
            }
            .container {
              max-width: 600px;
              margin: 0 auto;
              background: rgba(255, 255, 255, 0.05);
              padding: 40px;
              border-radius: 20px;
              backdrop-filter: blur(10px);
              border: 1px solid rgba(255, 255, 255, 0.1);
            }
            h1 {
              color: #10b981;
              font-size: 2.5rem;
              margin-bottom: 10px;
            }
            .subtitle {
              font-size: 1.2rem;
              font-weight: bold;
              color: white;
              margin-bottom: 30px;
              opacity: 0.9;
            }
            .license-key {
              background: rgba(16, 185, 129, 0.1);
              border: 2px solid #10b981;
              border-radius: 10px;
              padding: 20px;
              margin: 30px 0;
              font-family: 'Courier New', monospace;
              font-size: 1.5rem;
              font-weight: bold;
              letter-spacing: 2px;
              color: #10b981;
              display: flex;
              justify-content: space-between;
              align-items: center;
            }
            .copy-btn {
              background: linear-gradient(135deg, #8b5cf6 0%, #a855f7 100%);
              color: white;
              border: none;
              padding: 10px 20px;
              border-radius: 8px;
              font-size: 0.9rem;
              font-weight: bold;
              cursor: pointer;
              transition: all 0.3s ease;
              margin-left: 20px;
            }
            .copy-btn:hover {
              transform: translateY(-2px);
              box-shadow: 0 8px 20px rgba(139, 92, 246, 0.3);
            }
            .download-btn {
              background: linear-gradient(135deg, #8b5cf6 0%, #a855f7 100%);
              color: white;
              padding: 15px 30px;
              border: none;
              border-radius: 10px;
              font-size: 1.1rem;
              font-weight: bold;
              text-decoration: none;
              display: inline-block;
              margin: 20px 0;
              transition: all 0.3s ease;
            }
            .download-btn:hover {
              transform: translateY(-2px);
              box-shadow: 0 10px 25px rgba(139, 92, 246, 0.3);
            }
            .download-btn.green {
              background: linear-gradient(135deg, #10b981 0%, #059669 100%);
            }
            .download-btn.green:hover {
              box-shadow: 0 10px 25px rgba(16, 185, 129, 0.3);
            }
            .plugin-downloads {
              margin: 30px 0;
            }
            .download-option {
              display: flex;
              justify-content: space-between;
              align-items: center;
              background: rgba(255, 255, 255, 0.05);
              padding: 20px;
              border-radius: 10px;
              margin: 15px 0;
              border: 1px solid rgba(255, 255, 255, 0.1);
            }
            .download-text {
              font-size: 1.1rem;
              font-weight: 500;
            }
            .download-buttons {
              display: flex;
              gap: 10px;
            }
            .download-buttons .download-btn {
              padding: 10px 20px;
              font-size: 1rem;
              margin: 0;
            }
            .info {
              margin: 20px 0;
              line-height: 1.6;
              opacity: 0.9;
            }
          </style>
        </head>
        <body>
          <div class="container">
            <h1>🎉 Payment Successful!</h1>
            <div class="subtitle">Chat your way to pro-level audio for the first time in human history.</div>
            
            <div class="info">
              <p>Here's your license key for access to the MegaMixAI Chat Suite:</p>
            </div>
            
            <div class="license-key">
              <span>${licenseKey}</span>
              <button class="copy-btn" onclick="copyLicenseKey()">Copy</button>
            </div>
            
            <div class="info">
              <p>This license provides you access to the JoshSquash™ Chat Compressor and all upcoming plugins that will soon be available in the MegaMixAI Chat Suite.</p>
              
              <p>Your license key document will automatically download now. If it doesn't start automatically, <a href="/download-license/${licenseKey}" class="download-btn" style="color: white; text-decoration: none;">click HERE</a>.</p>
            </div>
            
            <div class="download-redirect" style="text-align: center; margin: 40px 0; padding: 30px; background: rgba(139, 92, 246, 0.1); border-radius: 15px; border: 2px solid rgba(139, 92, 246, 0.3);">
              <h3 style="color: #8b5cf6; margin: 0 0 20px 0; font-size: 1.8rem; font-weight: bold;">Download JoshSquash™ on the home page.</h3>
              <button class="redirect-btn" onclick="goToHomePage()" style="background: linear-gradient(135deg, #8b5cf6 0%, #a855f7 100%); color: white; border: none; padding: 15px 30px; border-radius: 10px; font-size: 1.2rem; font-weight: bold; cursor: pointer; transition: all 0.3s ease; box-shadow: 0 5px 15px rgba(139, 92, 246, 0.3);">
                Take me there
              </button>
            </div>
          </div>
          
          <script>
            // Auto-download the license file
            setTimeout(() => {
              window.location.href = '/download-license/${licenseKey}';
            }, 2000);
            
            // Function to handle plugin downloads
            function downloadPlugin(version, platform) {
              // TODO: Add actual download logic here
              alert('Download for ' + version.toUpperCase() + ' ' + platform + ' version will be available soon!');
            }
            
            // Function to copy license key to clipboard
            function copyLicenseKey() {
              const licenseKey = '${licenseKey}';
              navigator.clipboard.writeText(licenseKey).then(() => {
                const btn = document.querySelector('.copy-btn');
                const originalText = btn.textContent;
                btn.textContent = 'Copied!';
                btn.style.background = 'linear-gradient(135deg, #10b981 0%, #059669 100%)';
                setTimeout(() => {
                  btn.textContent = originalText;
                  btn.style.background = 'linear-gradient(135deg, #8b5cf6 0%, #a855f7 100%)';
                }, 2000);
              }).catch(() => {
                alert('Failed to copy license key. Please copy manually: ' + licenseKey);
              });
            }
            
            function goToHomePage() {
              // Redirect to home page and scroll to download section
              window.location.href = '/#plugin-downloads';
            }
          </script>
        </body>
      </html>
    `);
  } catch (error) {
    console.error('Error loading success page:', error);
    res.status(500).send('Error loading success page');
  }
});

// Download license key file
app.get('/download-license/:licenseKey', (req, res) => {
  const licenseKey = req.params.licenseKey;
  
  const licenseContent = `MegaMixAI Chat Suite - License Key

Your License Key: ${licenseKey}

This license provides you access to:
- JoshSquash Chat Compressor
- All upcoming plugins in the MegaMixAI Chat Suite

IMPORTANT: Keep this license key safe and don't share it with others.

To use your license:
1. Download the MegaMixAI plugin
2. Open the plugin in your DAW
3. Enter this license key when prompted
4. Enjoy your new audio tools!

For support, contact: support@megamixai.com

Generated: ${new Date().toISOString()}
`;

  res.setHeader('Content-Type', 'text/plain');
  res.setHeader('Content-Disposition', `attachment; filename="MegaMixAI_License_${licenseKey}.txt"`);
  res.send(licenseContent);
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
    const { licenseKey } = req.body;
    
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
        [licenseKey, null, req.ip, req.get('User-Agent'), 'invalid']
      );
      
      return res.status(404).json({ error: 'Invalid license key. Check the .txt file you were given upon downloading to verify.' });
    }
    
    const license = result.rows[0];
    
    // Check if license is expired
    if (new Date() > new Date(license.expires_at)) {
      await pool.query(
        `INSERT INTO validation_logs (license_key, hardware_fingerprint, ip_address, user_agent, validation_result)
         VALUES ($1, $2, $3, $4, $5)`,
        [licenseKey, null, req.ip, req.get('User-Agent'), 'expired']
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
       validation_count = validation_count + 1
       WHERE id = $1`,
      [license.id]
    );
    
    // Log successful validation
    await pool.query(
      `INSERT INTO validation_logs (license_key, hardware_fingerprint, ip_address, user_agent, validation_result)
       VALUES ($1, $2, $3, $4, $5)`,
      [licenseKey, null, req.ip, req.get('User-Agent'), 'valid']
    );
    
    // Generate JWT token for offline validation (30 days)
    const token = jwt.sign(
      { 
        licenseKey: license.license_key,
        customerEmail: license.customer_email,
        expiresAt: license.expires_at
      },
      process.env.JWT_SECRET || 'fallback-secret-key',
      { expiresIn: '30d' }
    );
    
    res.json({
      valid: true,
      token: token,
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

// Version check endpoint for plugin
app.get('/api/version', (req, res) => {
  res.json({ version: '1.0.1' });
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

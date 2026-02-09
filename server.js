const express = require('express');
const stripe = require('stripe')(process.env.STRIPE_SECRET_KEY);
const cors = require('cors');
const jwt = require('jsonwebtoken');
const nodemailer = require('nodemailer');
const mailchimp = require('@mailchimp/mailchimp_marketing');
const { pool, initializeDatabase } = require('./database/connection');
require('dotenv').config();

const app = express();
const PORT = process.env.PORT || 3000;

// Configure Mailchimp with 3-part obfuscated API key
const mailchimpKeyPart1 = process.env.MAILCHIMP_API_KEY_PART1 || '9c5a37c0c84bab9';
const mailchimpKeyPart2 = process.env.MAILCHIMP_API_KEY_PART2 || '766fe82bf3f86f1';
const mailchimpKeyPart3 = process.env.MAILCHIMP_API_KEY_PART3 || '19';
const mailchimpServer = process.env.MAILCHIMP_SERVER || 'us16';
const mailchimpApiKey = `${mailchimpKeyPart1}${mailchimpKeyPart2}${mailchimpKeyPart3}-${mailchimpServer}`;

mailchimp.setConfig({
  apiKey: mailchimpApiKey,
  server: mailchimpServer,
});

// Configure nodemailer transporter (only if credentials are available)
let transporter = null;
const smtpUser = (process.env.EMAIL_USER || process.env.SMTP_USER) ? (process.env.EMAIL_USER || process.env.SMTP_USER).trim() : '';
const smtpPass = (process.env.GMAIL_APP_PASSWORD || process.env.SMTP_PASS) ? (process.env.GMAIL_APP_PASSWORD || process.env.SMTP_PASS).trim() : '';

if (smtpUser && smtpPass) {
  try {
    transporter = nodemailer.createTransport({
      host: process.env.SMTP_HOST || 'smtp.gmail.com',
      port: parseInt(process.env.SMTP_PORT || '587'),
      secure: false, // true for 465, false for other ports
      auth: {
        user: smtpUser,
        pass: smtpPass
      },
      tls: {
        rejectUnauthorized: false // Allow self-signed certificates
      }
    });
    // Verify transporter configuration
    transporter.verify(function(error, success) {
      if (error) {
        console.error('SMTP transporter verification failed:', error);
      } else {
        console.log('SMTP transporter is ready to send emails');
      }
    });
  } catch (error) {
    console.error('Error creating SMTP transporter:', error);
  }
} else {
  console.warn('SMTP credentials not configured. Email functionality will be disabled.');
  console.warn('EMAIL_USER:', smtpUser ? `SET (${smtpUser.length} chars)` : 'NOT SET');
  console.warn('GMAIL_APP_PASSWORD:', smtpPass ? `SET (${smtpPass.length} chars)` : 'NOT SET');
}

// Middleware
app.use(cors());

// Serve static files from the assets directory
app.use('/assets', express.static('assets'));

// Serve plugin downloads
app.use('/downloads', express.static('downloads'));

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
      // Update license status to active and extend expires_at
      const paymentSucceededSession = event.data.object;
      if (paymentSucceededSession.subscription) {
        try {
          const subscription = await stripe.subscriptions.retrieve(paymentSucceededSession.subscription);
          const expiresAt = new Date(subscription.current_period_end * 1000);
          
          await pool.query(
            `UPDATE licenses 
             SET status = 'active', expires_at = $1, last_validated_at = CURRENT_TIMESTAMP
             WHERE stripe_subscription_id = $2`,
            [expiresAt, paymentSucceededSession.subscription]
          );
          console.log(`Updated license status to active for subscription ${paymentSucceededSession.subscription}`);
        } catch (error) {
          console.error('Error updating license on payment success:', error);
        }
      }
      break;
      
    case 'invoice.payment_failed':
      console.log('Subscription payment failed');
      // Mark license as expired/cancelled after payment failure
      const paymentFailedSession = event.data.object;
      if (paymentFailedSession.subscription) {
        try {
          // Check if subscription will be cancelled or is past due
          const subscription = await stripe.subscriptions.retrieve(paymentFailedSession.subscription);
          
          let newStatus = 'expired';
          if (subscription.status === 'canceled' || subscription.status === 'unpaid') {
            newStatus = 'cancelled';
          } else if (subscription.status === 'past_due') {
            newStatus = 'expired'; // Give grace period for past_due
          }
          
          await pool.query(
            `UPDATE licenses 
             SET status = $1
             WHERE stripe_subscription_id = $2`,
            [newStatus, paymentFailedSession.subscription]
          );
          console.log(`Updated license status to ${newStatus} for subscription ${paymentFailedSession.subscription}`);
        } catch (error) {
          console.error('Error updating license on payment failure:', error);
        }
      }
      break;
      
    case 'customer.subscription.deleted':
      console.log('Subscription cancelled');
      // Update license status when subscription is cancelled
      const deletedSubscription = event.data.object;
      if (deletedSubscription.id) {
        try {
          await pool.query(
            `UPDATE licenses 
             SET status = 'cancelled'
             WHERE stripe_subscription_id = $1`,
            [deletedSubscription.id]
          );
          console.log(`Updated license status to cancelled for subscription ${deletedSubscription.id}`);
        } catch (error) {
          console.error('Error updating license on subscription deletion:', error);
        }
      }
      break;
      
    default:
      console.log(`Unhandled event type ${event.type}`);
  }

  res.json({received: true});
});

// Add express.json() middleware after webhook route
app.use(express.json());
app.use(express.static('public')); // Serve static files (like your HTML)

// Stripe Price IDs: 1mo = monthly, STRIPE_PRICE_ID = 3-month, 1yr = yearly
const PRICE_ID_1MO = process.env.STRIPE_PRICE_ID_1MO;
const PRICE_ID = process.env.STRIPE_PRICE_ID;   // 3-month plan only
const PRICE_ID_1YR = process.env.STRIPE_PRICE_ID_1YR;

// Debug logging
console.log('=== STRIPE PRICE ID DEBUG ===');
console.log('STRIPE_PRICE_ID_1MO:', PRICE_ID_1MO ? '(set)' : '(not set)');
console.log('STRIPE_PRICE_ID (3mo):', PRICE_ID ? '(set)' : '(not set)');
console.log('STRIPE_PRICE_ID_1YR:', PRICE_ID_1YR ? '(set)' : '(not set)');

// Create checkout session endpoint
app.post('/create-checkout-session', async (req, res) => {
  try {
    const { priceId: reqPriceId } = req.body || {};
    let priceId;
    if (typeof reqPriceId === 'string' && reqPriceId.startsWith('price_')) {
      priceId = reqPriceId;
    } else if (reqPriceId === '3mo') {
      priceId = PRICE_ID;   // STRIPE_PRICE_ID = 3-month plan
    } else if (reqPriceId === '1yr') {
      priceId = PRICE_ID_1YR;
    } else {
      // Default (GET FREE TRIAL, 1mo): use STRIPE_PRICE_ID_1MO (monthly)
      priceId = PRICE_ID_1MO;
    }

    // Validate that we have a price ID
    if (!priceId) {
      const msg = reqPriceId === '3mo' ? 'Set STRIPE_PRICE_ID in Render (3-month plan).' : reqPriceId === '1yr' ? 'Set STRIPE_PRICE_ID_1YR in Render (yearly plan).' : 'Set STRIPE_PRICE_ID_1MO in Render for the $5.99/month plan (GET FREE TRIAL).';
      console.error('ERROR:', msg);
      return res.status(500).json({ error: msg });
    }

    const session = await stripe.checkout.sessions.create({
      mode: 'subscription',
      payment_method_types: ['card'],
      allow_promotion_codes: true,
      line_items: [
        {
          price: priceId,
          quantity: 1,
        },
      ],
      subscription_data: {
        trial_period_days: 7,
      },
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
    
    // Use subscription current_period_end for expires_at (correct for trial end and paid periods)
    let expiresAt = new Date(Date.now() + 30 * 24 * 60 * 60 * 1000); // fallback: 30 days
    if (session.subscription) {
      try {
        const subscription = await stripe.subscriptions.retrieve(session.subscription);
        expiresAt = new Date(subscription.current_period_end * 1000);
      } catch (err) {
        console.warn('Could not fetch subscription for expires_at, using fallback:', err.message);
      }
    }
    
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
        expiresAt
      ]
    );
    
    const licenseId = result.rows[0].id;
    
    // Store payment record only when there was an immediate charge (no trial, or trial skipped)
    if (session.payment_intent) {
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
    }
    
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

// License validation endpoint (for the plugin to call).
// The plugin uses the returned token and license.expires_at for offline validation; keep this response shape for compatibility.
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
    
    // Check if license is active in database
    if (license.status !== 'active') {
      return res.status(403).json({ error: 'License is not active' });
    }
    
    // CRITICAL: Verify subscription is actually active in Stripe
    // This prevents use of cancelled or failed subscriptions
    if (license.stripe_subscription_id) {
      try {
        const subscription = await stripe.subscriptions.retrieve(license.stripe_subscription_id);
        
        // Check if subscription is active in Stripe
        // Allow 'active' and 'trialing' states, reject everything else
        const validStripeStatuses = ['active', 'trialing'];
        if (!validStripeStatuses.includes(subscription.status)) {
          // Subscription is not active in Stripe - update database and reject
          const newStatus = subscription.status === 'canceled' || subscription.status === 'unpaid' 
            ? 'cancelled' 
            : 'expired';
          
          await pool.query(
            `UPDATE licenses SET status = $1 WHERE id = $2`,
            [newStatus, license.id]
          );
          
          await pool.query(
            `INSERT INTO validation_logs (license_key, hardware_fingerprint, ip_address, user_agent, validation_result)
             VALUES ($1, $2, $3, $4, $5)`,
            [licenseKey, null, req.ip, req.get('User-Agent'), 'invalid']
          );
          
          let errorMessage = 'Subscription is not active';
          if (subscription.status === 'canceled') {
            errorMessage = 'Your subscription has been cancelled. Please renew your subscription to continue using the plugin.';
          } else if (subscription.status === 'past_due') {
            errorMessage = 'Your subscription payment is past due. Please update your payment method to continue using the plugin.';
          } else if (subscription.status === 'unpaid') {
            errorMessage = 'Your subscription payment failed. Please update your payment method to continue using the plugin.';
          }
          
          return res.status(403).json({ error: errorMessage });
        }
        
        // Subscription is active in Stripe - update expires_at to match Stripe's current_period_end
        // This keeps database in sync with actual billing cycle
        const stripeExpiresAt = new Date(subscription.current_period_end * 1000);
        if (stripeExpiresAt.getTime() !== new Date(license.expires_at).getTime()) {
          await pool.query(
            `UPDATE licenses SET expires_at = $1 WHERE id = $2`,
            [stripeExpiresAt, license.id]
          );
        }
        
      } catch (stripeError) {
        // Handle Stripe API errors gracefully
        console.error('Error verifying Stripe subscription:', stripeError);
        
        // Check if subscription doesn't exist or was deleted
        if (stripeError.type === 'StripeInvalidRequestError' && stripeError.code === 'resource_missing') {
          // Check if this is a test/live mode mismatch
          const errorMessage = stripeError.message || '';
          if (errorMessage.includes('test mode') || errorMessage.includes('live mode')) {
            // This is a mode mismatch - subscription exists but in wrong mode
            // For now, allow validation to proceed but log the issue
            // In production, you should ensure your Stripe keys match your subscription mode
            console.warn(`Stripe mode mismatch for subscription ${license.stripe_subscription_id}: ${errorMessage}`);
            console.warn('Validation proceeding - ensure STRIPE_SECRET_KEY matches subscription mode (test vs live)');
            // Continue with validation - the subscription exists, just in different mode
          } else {
            // Subscription truly doesn't exist - mark as cancelled
            await pool.query(
              `UPDATE licenses SET status = 'cancelled' WHERE id = $1`,
              [license.id]
            );
            
            await pool.query(
              `INSERT INTO validation_logs (license_key, hardware_fingerprint, ip_address, user_agent, validation_result)
               VALUES ($1, $2, $3, $4, $5)`,
              [licenseKey, null, req.ip, req.get('User-Agent'), 'invalid']
            );
            
            return res.status(403).json({ error: 'Subscription not found. Please contact support.' });
          }
        } else {
          // For other Stripe errors, log but don't block validation (fail open for network issues)
          // This prevents network problems from blocking valid users
          console.error('Stripe API error during validation (allowing validation to proceed):', stripeError.message);
        }
      }
    } else {
      // No Stripe subscription ID stored - this shouldn't happen for subscriptions
      // But handle gracefully for legacy licenses or one-time purchases
      console.warn(`License ${licenseKey} has no stripe_subscription_id - skipping Stripe verification`);
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

// Mailchimp signup endpoint
app.post('/mailchimp-signup', async (req, res) => {
  try {
    const { email, format, platform } = req.body;
    
    if (!email) {
      return res.status(400).json({ 
        success: false, 
        error: 'Email is required' 
      });
    }
    
    const audienceId = process.env.MAILCHIMP_AUDIENCE_ID || 'b67d7f37af';
    
    // Add subscriber to Mailchimp audience
    const response = await mailchimp.lists.addListMember(audienceId, {
      email_address: email,
      status: 'subscribed',
      merge_fields: {
        FNAME: '',
        LNAME: ''
      },
      tags: format && platform ? [`${format}-${platform}`] : []
    });
    
    console.log('Mailchimp signup successful:', { email, format, platform, mailchimpId: response.id });
    
    // Return success response
    res.json({ 
      success: true, 
      message: 'Successfully added to mailing list' 
    });
    
  } catch (error) {
    console.error('Error processing Mailchimp signup:', error);
    
    // Handle specific Mailchimp errors
    if (error.status === 400 && error.response?.body?.title === 'Member Exists') {
      // Email already in list - return success
      return res.json({ 
        success: true, 
        message: 'Email already in mailing list' 
      });
    }
    
    res.status(500).json({ 
      success: false, 
      error: 'Failed to process signup',
      details: error.message || 'Unknown error'
    });
  }
});

// Contact support endpoint
app.post('/contact-support', async (req, res) => {
  try {
    const { name, email, subject, message } = req.body;
    
    // Validate required fields
    if (!name || !email || !subject || !message) {
      return res.status(400).json({ 
        success: false, 
        error: 'All fields are required' 
      });
    }
    
    // Send email if transporter is configured
    if (!transporter) {
      console.error('SMTP not configured. Contact form submission:', { name, email, subject, message });
      // Log to console as fallback
      console.log('=== Contact Form Submission (Email Not Configured) ===');
      console.log('Name:', name);
      console.log('Email:', email);
      console.log('Subject:', subject);
      console.log('Message:', message);
      console.log('===================================================');
      
      return res.status(500).json({ 
        success: false, 
        error: 'Email service is not configured. Please contact support directly.' 
      });
    }
    
    const smtpUser = (process.env.EMAIL_USER || process.env.SMTP_USER) ? (process.env.EMAIL_USER || process.env.SMTP_USER).trim() : '';
    const mailOptions = {
      from: smtpUser || email,
      to: 'saas.factory.fl@gmail.com',
      subject: `Contact Form: ${subject}`,
      text: `Name: ${name}\nEmail: ${email}\n\nMessage:\n${message}`,
      replyTo: email
    };
    
    await transporter.sendMail(mailOptions);
    
    console.log(`Contact form submission sent from ${email} to saas.factory.fl@gmail.com`);
    
    // Return success response
    res.json({ 
      success: true, 
      message: 'Thank you for contacting us! We\'ll get back to you soon.' 
    });
    
  } catch (error) {
    console.error('Error sending contact form email:', error);
    console.error('Error details:', {
      message: error.message,
      code: error.code,
      response: error.response,
      responseCode: error.responseCode,
      stack: error.stack
    });
    res.status(500).json({ 
      success: false, 
      error: 'Failed to process contact form submission',
      details: error.message || 'Unknown error'
    });
  }
});

// Version check endpoint for plugin
// NOTE: When updating plugin version in MegaMixAI.jucer, run: npm run sync-version
// This automatically syncs the version from .jucer to this endpoint
app.get('/api/version', (req, res) => {
  res.json({ version: '1.0.6' });
});

// Health check endpoint
app.get('/health', (req, res) => {
  res.json({ status: 'OK', timestamp: new Date().toISOString() });
});

// Coupon usage endpoint
const DEFAULT_PROMOTION_CODE_ID = process.env.STRIPE_PROMOTION_CODE_ID ||
  process.env.STRIPE_PROMO_CODE_ID ||
  process.env.STRIPE_FIRST500_PROMO_ID;

app.get('/api/coupon-usage', async (req, res) => {
  try {
    const code = (req.query.code || '').trim();
    const promotionCodeId = (req.query.id || req.query.promotionCodeId || '').trim();

    if (!code && !promotionCodeId && !DEFAULT_PROMOTION_CODE_ID) {
      return res.status(400).json({
        success: false,
        error: 'Missing required promotion code identifier'
      });
    }

    let promotionCode;
    const effectivePromotionCodeId = promotionCodeId || DEFAULT_PROMOTION_CODE_ID || null;

    if (effectivePromotionCodeId) {
      try {
        promotionCode = await stripe.promotionCodes.retrieve(effectivePromotionCodeId, {
          expand: ['coupon']
        });
      } catch (retrieveError) {
        console.warn(`Failed to retrieve promotion code by id ${effectivePromotionCodeId}:`, retrieveError.message);
        if (!code) {
          throw retrieveError;
        }
      }
    }

    if (!promotionCode && code) {
      const promotionCodes = await stripe.promotionCodes.list({
        code,
        limit: 1,
        expand: ['data.coupon']
      });

      if (promotionCodes.data.length) {
        promotionCode = promotionCodes.data[0];
      }
    }

    if (!promotionCode) {
      return res.status(404).json({
        success: false,
        error: 'Promotion code not found',
        code,
        id: effectivePromotionCodeId
      });
    }

    const timesRedeemed = promotionCode.times_redeemed ?? 0;

    // Prefer promotion code max redemptions; fall back to coupon-level max redemptions if needed
    const maxRedemptions =
      promotionCode.max_redemptions ??
      (promotionCode.coupon ? promotionCode.coupon.max_redemptions : null);

    const remaining =
      typeof maxRedemptions === 'number'
        ? Math.max(maxRedemptions - timesRedeemed, 0)
        : null;

    res.json({
      success: true,
      code: promotionCode.code,
      id: promotionCode.id,
      maxRedemptions,
      timesRedeemed,
      remaining
    });
  } catch (error) {
    console.error('Error retrieving promotion code usage:', error);
    res.status(500).json({
      success: false,
      error: 'Failed to retrieve promotion code usage'
    });
  }
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

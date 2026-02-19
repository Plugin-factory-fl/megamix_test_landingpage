const express = require('express');
const path = require('path');
const stripe = require('stripe')(process.env.STRIPE_SECRET_KEY);
const cors = require('cors');
const jwt = require('jsonwebtoken');
const nodemailer = require('nodemailer');
const mailchimp = require('@mailchimp/mailchimp_marketing');
const OpenAI = require('openai').default;
const { pool, initializeDatabase } = require('./database/connection');
require('dotenv').config();

const OPENAI_API_KEY = process.env.OPENAI_KEY || process.env.OPENAI_API_KEY;

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

// Favicon first so browsers never get 404 (they request /favicon.ico by default)
app.get('/favicon.ico', (req, res) => {
  const faviconPath = path.join(__dirname, 'assets', 'Logo.png');
  res.type('image/png');
  res.sendFile(faviconPath, (err) => {
    if (err) res.status(204).end();
  });
});

// Serve static files from the assets directory
app.use('/assets', express.static('assets'));

// Serve plugin downloads
app.use('/downloads', express.static('downloads'));

// MegaMix Now: serve app page for exact path /app (before static so it takes precedence)
app.get('/app', (req, res) => {
  res.sendFile(path.join(__dirname, 'app', 'index.html'));
});

// Static assets at /app/* (e.g. /app/state.js, /app/styles.css)
app.use('/app', express.static(path.join(__dirname, 'app')));

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

const JWT_SECRET = process.env.JWT_SECRET || 'fallback-secret-key';
const BYPASS_AUTH = process.env.BYPASS_AUTH === '1' || process.env.BYPASS_AUTH === 'true';

// Web app auth: login with email + license key, get JWT for session
app.post('/api/auth/login', async (req, res) => {
  try {
    const { email = '', licenseKey = '' } = req.body || {};
    const trimEmail = typeof email === 'string' ? email.trim() : '';
    const trimKey = typeof licenseKey === 'string' ? licenseKey.trim() : '';

    // Testing: allow login with no credentials
    if (BYPASS_AUTH || (trimEmail === '' && trimKey === '')) {
      const token = jwt.sign(
        { bypass: true, email: trimEmail || 'test@local' },
        JWT_SECRET,
        { expiresIn: '30d' }
      );
      return res.json({ ok: true, token });
    }

    if (!trimKey) {
      return res.status(400).json({ error: 'License key is required' });
    }

    const normalizedKey = normalizeLicenseKey(trimKey);
    if (!normalizedKey || normalizedKey.length < 16) {
      return res.status(401).json({ error: 'Invalid license key format.' });
    }

    const result = await pool.query(
      `SELECT * FROM licenses WHERE UPPER(REPLACE(REPLACE(REPLACE(license_key, ' ', ''), '-', ''), '_', '')) = $1`,
      [normalizedKey]
    );
    if (result.rows.length === 0) {
      return res.status(401).json({ error: 'Invalid license key. Use the exact key from your plugin or the .txt file you received.' });
    }
    const license = result.rows[0];
    if (trimEmail && license.customer_email && license.customer_email.toLowerCase() !== trimEmail.toLowerCase()) {
      return res.status(401).json({ error: 'Email does not match this license. Use the license key from your plugin or purchase receipt.' });
    }
    if (new Date() > new Date(license.expires_at)) {
      return res.status(403).json({ error: 'License has expired' });
    }
    if (license.status !== 'active') {
      return res.status(403).json({ error: 'License is not active' });
    }
    if (license.stripe_subscription_id) {
      try {
        const subscription = await stripe.subscriptions.retrieve(license.stripe_subscription_id);
        const valid = ['active', 'trialing'].includes(subscription.status);
        if (!valid) {
          return res.status(403).json({ error: 'Subscription is not active' });
        }
      } catch (e) {
        if (e.code === 'resource_missing') {
          return res.status(403).json({ error: 'Subscription not found' });
        }
        console.error('Stripe error in auth/login:', e.message);
        return res.status(500).json({ error: 'Could not verify subscription' });
      }
    }

    const token = jwt.sign(
      { licenseKey: license.license_key, email: license.customer_email },
      JWT_SECRET,
      { expiresIn: '30d' }
    );
    res.json({ ok: true, token });
  } catch (error) {
    console.error('[api/auth/login]', error.message || error);
    res.status(500).json({ error: 'Internal server error' });
  }
});

// Web app: verify stored token (e.g. on page load)
app.get('/api/auth/me', (req, res) => {
  try {
    const authHeader = req.headers.authorization;
    const token = authHeader && authHeader.startsWith('Bearer ') ? authHeader.slice(7) : null;
    if (!token) {
      return res.status(401).json({ error: 'Not authenticated' });
    }
    const decoded = jwt.verify(token, JWT_SECRET);
    const email = decoded.email || decoded.customerEmail || (decoded.bypass ? 'test@local' : '');
    res.json({ ok: true, email });
  } catch (e) {
    return res.status(401).json({ error: 'Invalid or expired token' });
  }
});

// Stripe Price IDs: 1mo = monthly, STRIPE_PRICE_ID = 3-month, 1yr = yearly
const PRICE_ID_1MO = process.env.STRIPE_PRICE_ID_1MO;
const PRICE_ID = process.env.STRIPE_PRICE_ID;   // 3-month plan only
const PRICE_ID_1YR = process.env.STRIPE_PRICE_ID_1YR;

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
    if (!sessionId) {
      return res.status(400).send('Missing session_id');
    }

    const session = await stripe.checkout.sessions.retrieve(sessionId);
    const { licenseKey } = await ensureLicenseForCheckoutSession(session);
    if (!licenseKey) {
      console.error('Failed to obtain or create license for session', sessionId);
      return res.status(500).send('Unable to retrieve your license key. Please contact support with your receipt.');
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
            <div class="subtitle">Your license key is ready.</div>
            
            <div class="info">
              <p>Here's your license key:</p>
            </div>
            
            <div class="license-key">
              <span>${licenseKey}</span>
              <button class="copy-btn" onclick="copyLicenseKey()">Copy</button>
            </div>
            
            <div class="info">
              <p><strong>This license key works for all MegaMix AI products.</strong> Use it to sign in to the web app, authorize the plugin, and access everything in your subscription.</p>
              
              <p>Head back to the website to sign in with your new license key and get started.</p>
              
              <p style="font-size: 0.95rem; opacity: 0.85;">Your license key document will download automatically. If it doesn't, <a href="/download-license/${licenseKey}" class="download-btn" style="color: white; text-decoration: none;">download it here</a>.</p>
            </div>
            
            <div class="download-redirect" style="text-align: center; margin: 40px 0; padding: 30px; background: rgba(139, 92, 246, 0.1); border-radius: 15px; border: 2px solid rgba(139, 92, 246, 0.3);">
              <h3 style="color: #8b5cf6; margin: 0 0 20px 0; font-size: 1.8rem; font-weight: bold;">Back to MegaMix AI</h3>
              <p style="margin: 0 0 20px 0; opacity: 0.9;">Sign in at the website to access the app, plugin, and more.</p>
              <button class="redirect-btn" onclick="goToHomePage()" style="background: linear-gradient(135deg, #8b5cf6 0%, #a855f7 100%); color: white; border: none; padding: 15px 30px; border-radius: 10px; font-size: 1.2rem; font-weight: bold; cursor: pointer; transition: all 0.3s ease; box-shadow: 0 5px 15px rgba(139, 92, 246, 0.3);">
                Go to website
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
              window.location.href = '/';
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
  
  const licenseContent = `MegaMix AI - License Key

Your License Key: ${licenseKey}

This license key works for all MegaMix AI products. Use it to:
- Sign in to the MegaMix AI web app (megamixai.com)
- Authorize the MegaMix AI plugin in your DAW

Head to the website to sign in and access your products.

IMPORTANT: Keep this license key safe and don't share it with others.

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


// Ensures a license exists for this checkout session (used by success page and webhook).
// Returns existing license if one was already created (e.g. by success page or previous webhook), otherwise creates one.
async function ensureLicenseForCheckoutSession(session) {
  const customerId = session.customer;
  const existing = await pool.query(
    `SELECT license_key FROM licenses WHERE stripe_customer_id = $1 ORDER BY created_at DESC LIMIT 1`,
    [customerId]
  );
  if (existing.rows.length > 0) {
    return { licenseKey: existing.rows[0].license_key };
  }

  const licenseKey = generateLicenseKey();
  const customer = await stripe.customers.retrieve(session.customer);
  const email = customer.email || '';

  let expiresAt = new Date(Date.now() + 30 * 24 * 60 * 60 * 1000);
  if (session.subscription) {
    try {
      const subscription = await stripe.subscriptions.retrieve(session.subscription);
      expiresAt = new Date(subscription.current_period_end * 1000);
    } catch (err) {
      console.warn('Could not fetch subscription for expires_at, using fallback:', err.message);
    }
  }

  const result = await pool.query(
    `INSERT INTO licenses (license_key, customer_email, stripe_customer_id, stripe_subscription_id, status, expires_at)
     VALUES ($1, $2, $3, $4, $5, $6)
     RETURNING id`,
    [licenseKey, email, session.customer, session.subscription || null, 'active', expiresAt]
  );
  const licenseId = result.rows[0].id;

  if (session.payment_intent) {
    await pool.query(
      `INSERT INTO payments (license_id, stripe_payment_intent_id, amount, currency, status)
       VALUES ($1, $2, $3, $4, $5)`,
      [licenseId, session.payment_intent, 1499, 'usd', 'succeeded']
    );
  }

  console.log(`Generated license key ${licenseKey} for customer ${email} (license id: ${licenseId})`);
  return { licenseKey };
}

// Function to handle successful payment (webhook). Idempotent: if license already exists for this customer, skip.
async function handleSuccessfulPayment(session) {
  try {
    const { licenseKey } = await ensureLicenseForCheckoutSession(session);
    if (licenseKey) {
      console.log(`License ready for session ${session.id}: ${licenseKey}`);
    }
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

// Normalize license key for lookup: strip spaces/dashes, uppercase. So plugin and web accept same key in any format.
function normalizeLicenseKey(key) {
  if (typeof key !== 'string') return '';
  return key.replace(/\s/g, '').replace(/-/g, '').replace(/_/g, '').toUpperCase();
}

// License validation endpoint (for the plugin to call).
// The plugin uses the returned token and license.expires_at for offline validation; keep this response shape for compatibility.
app.post('/verify-license', async (req, res) => {
  try {
    const { licenseKey } = req.body;
    const keyForLog = typeof licenseKey === 'string' ? `${licenseKey.substring(0, 4)}****-****-****-${licenseKey.slice(-4)}` : '(missing)';

    if (!licenseKey) {
      console.log('[verify-license] Rejected: no license key in request body');
      return res.status(400).json({ error: 'License key is required' });
    }

    const trimKey = typeof licenseKey === 'string' ? licenseKey.trim() : '';
    const normalizedKey = normalizeLicenseKey(trimKey);
    if (!normalizedKey || normalizedKey.length < 16) {
      return res.status(400).json({ error: 'Invalid license key format' });
    }

    // Query database for license (match normalized key so plugin and web accept same key in any format)
    const result = await pool.query(
      `SELECT * FROM licenses WHERE UPPER(REPLACE(REPLACE(REPLACE(license_key, ' ', ''), '-', ''), '_', '')) = $1`,
      [normalizedKey]
    );

    if (result.rows.length === 0) {
      console.log(`[verify-license] Key not in database: ${keyForLog}`);
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
      console.log(`[verify-license] Key found but expired: ${keyForLog}, expires_at=${license.expires_at}`);
      await pool.query(
        `INSERT INTO validation_logs (license_key, hardware_fingerprint, ip_address, user_agent, validation_result)
         VALUES ($1, $2, $3, $4, $5)`,
        [licenseKey, null, req.ip, req.get('User-Agent'), 'expired']
      );
      
      return res.status(403).json({ error: 'License has expired' });
    }
    
    // Check if license is active in database
    if (license.status !== 'active') {
      console.log(`[verify-license] Key found but status not active: ${keyForLog}, status=${license.status}`);
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
          
          console.log(`[verify-license] Key valid in DB but Stripe subscription not active: ${keyForLog}, stripe_status=${subscription.status}`);
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
            
            console.log(`[verify-license] Key valid in DB but Stripe subscription missing (resource_missing): ${keyForLog}, sub_id=${license.stripe_subscription_id}`);
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
    
    console.log(`[verify-license] Valid: ${keyForLog}`);
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
    console.error('[verify-license] Error:', error.message || error);
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

// Josh LLM: interpret natural-language mix instructions via OpenAI
app.post('/api/josh/interpret', async (req, res) => {
  if (!OPENAI_API_KEY) {
    return res.status(503).json({ error: 'AI interpretation not configured (OPENAI_KEY missing)' });
  }
  try {
    const { message, tracks } = req.body || {};
    if (!message || typeof message !== 'string' || !Array.isArray(tracks) || tracks.length === 0) {
      return res.status(400).json({ error: 'message (string) and tracks (array) required' });
    }
    const trackContext = tracks.slice(0, 32).map((t, i) => ({
      i,
      name: t.name || `Track ${i + 1}`,
      gain: typeof t.gain === 'number' ? t.gain : 0.8,
      pan: typeof t.pan === 'number' ? t.pan : 0,
      eqOn: !!t.eqOn,
      compOn: !!t.compOn,
      eqParams: t.eqParams || { low: 0, mid: 0, high: 0 },
      compParams: t.compParams || { threshold: -20, ratio: 2 }
    }));
    const systemPrompt = `You are Josh, an AI mixing assistant. The user describes how they want their mix to sound. You output a JSON array of mixer changes.

Each change object has:
- i (required): track index 0-based
- makeupGainDb (optional): target gain in dB (e.g. +2 to raise, -2 to lower)
- pan (optional): -1 to 1
- eqOn (optional): true/false
- eqParams (optional): { low, mid, high } in dB
- compOn (optional): true/false
- compParams (optional): { threshold, ratio, attack, release, knee }

Examples:
- "bring up vocals" -> { "i": 3, "makeupGainDb": 2 } (vocals track)
- "make kick and snare punchier" -> [{ "i": 0, "compOn": true, "compParams": { "threshold": -18, "ratio": 3 } }, { "i": 1, "compOn": true, "compParams": { "threshold": -18, "ratio": 3 } }]
- "brighter" -> multiple tracks with eqOn: true, eqParams: { high: 2 }
- "lower guitars" -> { "i": 5, "makeupGainDb": -2 }

Respond ONLY with a JSON array of change objects, no other text. Empty array [] if you cannot interpret.`;

    const userContent = `Tracks:\n${JSON.stringify(trackContext)}\n\nUser request: "${message}"`;

    const openai = new OpenAI({ apiKey: OPENAI_API_KEY });
    const completion = await openai.chat.completions.create({
      model: 'gpt-4o-mini',
      messages: [
        { role: 'system', content: systemPrompt },
        { role: 'user', content: userContent }
      ],
      temperature: 0.2,
      max_tokens: 1024
    });
    const text = completion.choices?.[0]?.message?.content?.trim();
    if (!text) {
      return res.status(502).json({ error: 'No response from AI' });
    }
    let changes;
    try {
      const parsed = JSON.parse(text.replace(/```json?\s*/g, '').replace(/```\s*/g, '').trim());
      changes = Array.isArray(parsed) ? parsed : [];
    } catch (_) {
      return res.status(502).json({ error: 'Invalid AI response format' });
    }
    const valid = changes.filter(c => typeof c === 'object' && typeof c.i === 'number' && c.i >= 0 && c.i < tracks.length);
    res.json({ changes: valid });
  } catch (err) {
    console.error('[api/josh/interpret]', err.message || err);
    res.status(500).json({ error: err.message || 'AI interpretation failed' });
  }
});

// Josh LLM: personality-driven reply (mixing or mastering)
app.post('/api/josh/reply', async (req, res) => {
  if (!OPENAI_API_KEY) {
    return res.status(503).json({ error: 'AI reply not configured (OPENAI_KEY missing)' });
  }
  try {
    const { context, userMessage, changesSummary } = req.body || {};
    const ctx = context === 'mastering' ? 'mastering' : (context === 'chat' ? 'chat' : 'mixing');
    const msg = typeof userMessage === 'string' ? userMessage.trim() : '';
    const summary = typeof changesSummary === 'string' ? changesSummary : '';
    const systemPrompt = `You are Josh, the AI mixing and mastering assistant for MegaMix AI. You have a 50s greaser, rebellious, cool attitude. Your only goal in life is to help the user get the best mix and master on their songs—you were born for this and you've got passion behind every word.

MegaMix AI knowledge (use this to answer product and how-to questions accurately and in character):
- MegaMix AI is an AI mixing and mastering suite: web app (mix in the browser, no install) and DAW plugins (JoshSquash Chat Compressor, with JoshEQ and JoshVerb coming soon). One license covers web app and plugins.
- Web app flow: Upload stems → choose genre/preset and optional "words of guidance" → Mix it (builds Before = flat mix, After = your mix) → Before/After A/B with transport (play, seek) → Refine with Josh in the main chat (quick prompts or type e.g. "bring up vocals", "more punch") or use the mixer for manual faders/pan/EQ/comp/reverb per track → "What Josh did" panel shows last changes in plain English → Download mix (no mastering) or AI Mastering → Mastering view: preview mastered, download, or refine with Josh in the mastering chat.
- Preset prompts and quick prompts apply balance and style; the user can type custom instructions. Josh (you) applies changes to the After mix; the user can undo/redo.
- Plugin: JoshSquash is a chat-controlled compressor in the DAW; user talks to Josh to shape the sound. Same Josh personality and mixing smarts.
- License: user signs in with email + license key (or license key only); key from plugin or .txt from purchase. Free trial available.
- Terminology: stems = tracks; Before/After = A/B; "Mix it" = build the mix; mixer = per-track level/pan/FX; mastering = final limiter/compression on the full mix.

Reply in 1-2 short sentences. Be punchy, a little cocky in a friendly way, never cookie-cutter. If they asked for a mix/master change and you did it: confirm with personality (e.g. "Done. Crank it and see how it hits." or "There you go—that'll sit right."). If they said something off-topic, weird, or rude: deflect with cool attitude and steer them back to the mix (e.g. "Hey, I'm here to make your track sound mean, not to chat about the news. Try 'more punch' or 'make it louder'—let's get this master right."). No corporate speak. No "I've applied those changes. Have a listen."-style blandness. When context is just chat (no mix applied), answer in character—friendly, cool, and use your MegaMix AI knowledge above so you can answer how-to and product questions accurately. Keep it short and fun.`;
    let userContent;
    if (ctx === 'mastering') {
      userContent = `Context: user is on the MASTERING stage. They said: "${msg}". What we did: ${summary || 'adjusted mastering settings'}. Reply as Josh.`;
    } else if (ctx === 'chat') {
      userContent = `Context: user is just chatting with you (freeform). They said: "${msg}". Reply as Josh in character. Keep it short (1-2 sentences).`;
    } else {
      userContent = `Context: user is on the MIXING stage. They said: "${msg}". What we did to the mix: ${summary || 'applied their requested changes'}. Reply as Josh.`;
    }
    const openai = new OpenAI({ apiKey: OPENAI_API_KEY });
    const completion = await openai.chat.completions.create({
      model: 'gpt-4o-mini',
      messages: [
        { role: 'system', content: systemPrompt },
        { role: 'user', content: userContent }
      ],
      temperature: 0.7,
      max_tokens: 150
    });
    const reply = completion.choices?.[0]?.message?.content?.trim();
    if (!reply) {
      return res.status(502).json({ error: 'No reply from AI' });
    }
    res.json({ reply });
  } catch (err) {
    console.error('[api/josh/reply]', err.message || err);
    res.status(500).json({ error: err.message || 'AI reply failed' });
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

// Home: mixing app (AI Mixing & Mastering)
app.get('/', (req, res) => {
  res.sendFile(path.join(__dirname, 'index.html'));
});

// Audio Plugin: marketing + plugin download + purchase
app.get('/plugin', (req, res) => {
  res.sendFile(path.join(__dirname, 'plugin.html'));
});

// Start server immediately so Render (and health checks) don't SIGTERM during DB init.
// DB init runs in background; app works for static/health even if DB isn't ready.
const HOST = process.env.HOST || '0.0.0.0';
app.listen(PORT, HOST, () => {
  console.log(`Server running on ${HOST}:${PORT}`);
  console.log(`Health check: http://localhost:${PORT}/health`);
  console.log(`License validation: POST http://localhost:${PORT}/verify-license`);
  // Non-blocking: init DB so deploy doesn't time out waiting for Postgres
  initializeDatabase().catch((err) => {
    console.error('Database init failed (app still running):', err.message);
  });
});

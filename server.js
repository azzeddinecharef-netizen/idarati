/**
 * IDARATI Company - Production Web Server & Database API
 * Supports Railway PostgreSQL (DATABASE_URL), Google Sheets backup, and Meta Pixel CAPI.
 */

const express = require('express');
const cors = require('cors');
const path = require('path');
const fs = require('fs');
const https = require('https');
const http = require('http');
require('dotenv').config();

const app = express();
const PORT = process.env.PORT || 3000;

// Middleware
app.use(cors());
app.use(express.json({ limit: '2mb' }));
app.use(express.urlencoded({ extended: true, limit: '2mb' }));

// Database initialization
let pool = null;
let dbType = 'none';
const dataDir = path.join(__dirname, 'data');
const fallbackDbFile = path.join(dataDir, 'leads.json');

const databaseUrl = process.env.DATABASE_URL || process.env.DATABASE_PUBLIC_URL || process.env.PGURL;

if (databaseUrl && (databaseUrl.startsWith('postgres://') || databaseUrl.startsWith('postgresql://'))) {
  try {
    const { Pool } = require('pg');
    const isLocalhost = databaseUrl.includes('localhost') || databaseUrl.includes('127.0.0.1');
    pool = new Pool({
      connectionString: databaseUrl,
      ssl: isLocalhost ? false : { rejectUnauthorized: false }
    });
    dbType = 'postgres';
    console.log('[DB] PostgreSQL pool initialized from DATABASE_URL');
  } catch (err) {
    console.error('[DB] Failed to load pg module, falling back to JSON:', err.message);
  }
}

// Auto-create PostgreSQL table if connected
async function initDb() {
  if (pool) {
    try {
      await pool.query(`
        CREATE TABLE IF NOT EXISTS leads (
          id VARCHAR(128) PRIMARY KEY,
          created_at TIMESTAMP WITH TIME ZONE DEFAULT CURRENT_TIMESTAMP,
          full_name VARCHAR(255) NOT NULL,
          company_name VARCHAR(255),
          activity VARCHAR(255),
          phone VARCHAR(64) NOT NULL,
          email VARCHAR(255),
          wilaya VARCHAR(64),
          lang VARCHAR(16) DEFAULT 'ar',
          source TEXT,
          page TEXT,
          status VARCHAR(64) DEFAULT 'Nouveau',
          notes TEXT,
          service VARCHAR(255),
          amount VARCHAR(64),
          fbp VARCHAR(255),
          fbc VARCHAR(255)
        );
        CREATE INDEX IF NOT EXISTS idx_leads_phone ON leads(phone);
        CREATE INDEX IF NOT EXISTS idx_leads_created_at ON leads(created_at DESC);
      `);
      console.log('[DB] PostgreSQL table "leads" verified/created successfully.');

      // Auto-inject leads from Google Sheets if database is currently empty
      const countRes = await pool.query('SELECT COUNT(*) FROM leads');
      const count = parseInt(countRes.rows[0].count, 10);
      const sheetUrl = process.env.SHEET_URL || process.env.GOOGLE_SHEET_URL;
      if (count === 0 && sheetUrl) {
        console.log('[DB] PostgreSQL table "leads" is empty. Auto-injecting existing orders from Google Sheets...');
        syncSheetLeads(sheetUrl).catch(e => console.warn('[DB] Auto-sync sheet error:', e.message));
      }
    } catch (err) {
      console.error('[DB] PostgreSQL init error:', err.message);
    }
  } else {
    // Ensure fallback file exists
    if (!fs.existsSync(dataDir)) {
      fs.mkdirSync(dataDir, { recursive: true });
    }
    if (!fs.existsSync(fallbackDbFile)) {
      fs.writeFileSync(fallbackDbFile, JSON.stringify([], null, 2), 'utf-8');
    }
    console.log('[DB] Local fallback JSON database initialized at data/leads.json');
  }
}
initDb();

// Core logic: Sync & Inject leads from Google Sheet into Railway Database (no duplicates)
async function syncSheetLeads(sheetUrl) {
  if (!sheetUrl) return { ok: false, error: 'SHEET_URL is required' };
  const fetchUrl = sheetUrl + (sheetUrl.includes('?') ? '&' : '?') + 'action=get_leads&t=' + Date.now();
  const response = await fetch(fetchUrl);
  const json = await response.json();
  if (!json || !json.ok || !Array.isArray(json.leads)) {
    throw new Error('Invalid response from Google Sheets');
  }

  const sheetLeads = json.leads;
  let inserted = 0;
  let updated = 0;
  let skipped = 0;

  for (const item of sheetLeads) {
    const fullName = (item.full_name || '').trim();
    const phone = (item.phone || '').trim();
    if (!fullName || !phone) {
      skipped++;
      continue;
    }

    const normPhone = normalizePhone(phone);
    const leadId = (item.id && !item.id.startsWith('lead-row-')) ? item.id : ('lead_' + Date.now() + '_' + Math.random().toString(36).slice(2, 8));
    const createdAt = item.date ? new Date(item.date).toISOString() : new Date().toISOString();

    if (pool) {
      const check = await pool.query(
        "SELECT id, status, notes FROM leads WHERE REGEXP_REPLACE(phone, '[^0-9]', '', 'g') = REGEXP_REPLACE($1, '[^0-9]', '', 'g') LIMIT 1",
        [normPhone]
      );
      if (check.rows.length > 0) {
        const existing = check.rows[0];
        let needUpdate = false;
        let newStatus = existing.status;
        let newNotes = existing.notes || '';

        if (item.status && item.status !== 'Nouveau' && existing.status === 'Nouveau') {
          newStatus = item.status;
          needUpdate = true;
        }
        if (item.notes && !newNotes.includes(item.notes)) {
          newNotes = (newNotes ? newNotes + ' | ' : '') + item.notes;
          needUpdate = true;
        }
        if (needUpdate) {
          await pool.query('UPDATE leads SET status = $1, notes = $2 WHERE id = $3', [newStatus, newNotes, existing.id]);
          updated++;
        } else {
          skipped++;
        }
      } else {
        await pool.query(
          `INSERT INTO leads (id, created_at, full_name, company_name, activity, phone, email, wilaya, lang, source, page, status, notes)
           VALUES ($1, $2, $3, $4, $5, $6, $7, $8, $9, $10, $11, $12, $13)`,
          [
            leadId, createdAt, fullName, item.company_name || '', item.activity || '',
            phone, item.email || '', item.wilaya || 'Alger', item.lang || 'ar',
            item.source || 'google_sheet_import', item.page || '', item.status || 'Nouveau', item.notes || ''
          ]
        );
        inserted++;
      }
    } else {
      const fallbackLeads = readFallbackLeads();
      const existingIdx = fallbackLeads.findIndex(l => normalizePhone(l.phone) === normPhone);
      if (existingIdx !== -1) {
        skipped++;
      } else {
        fallbackLeads.push({
          id: leadId,
          created_at: createdAt,
          full_name: fullName,
          company_name: item.company_name || '',
          activity: item.activity || '',
          phone: phone,
          email: item.email || '',
          wilaya: item.wilaya || 'Alger',
          lang: item.lang || 'ar',
          source: item.source || 'google_sheet_import',
          page: item.page || '',
          status: item.status || 'Nouveau',
          notes: item.notes || ''
        });
        inserted++;
        writeFallbackLeads(fallbackLeads);
      }
    }
  }

  console.log(`[DB] Sheet sync completed: ${inserted} inserted, ${updated} updated, ${skipped} skipped out of ${sheetLeads.length} rows.`);
  return { ok: true, total: sheetLeads.length, inserted, updated, skipped };
}

// Helper: Normalize phone for deduplication
function normalizePhone(p) {
  if (!p) return '';
  return String(p).replace(/[\s.\-()]/g, '');
}

// Helper: Read leads from fallback JSON
function readFallbackLeads() {
  try {
    if (!fs.existsSync(fallbackDbFile)) return [];
    const raw = fs.readFileSync(fallbackDbFile, 'utf-8');
    return JSON.parse(raw || '[]');
  } catch (e) {
    console.error('[Fallback DB] Read error:', e.message);
    return [];
  }
}

// Helper: Write leads to fallback JSON
function writeFallbackLeads(leads) {
  try {
    fs.writeFileSync(fallbackDbFile, JSON.stringify(leads, null, 2), 'utf-8');
  } catch (e) {
    console.error('[Fallback DB] Write error:', e.message);
  }
}

// Helper: Forward lead to Google Sheets if configured
async function forwardToGoogleSheet(lead) {
  const sheetUrl = process.env.SHEET_URL || process.env.GOOGLE_SHEET_URL;
  if (!sheetUrl) return;

  try {
    const postData = new URLSearchParams({
      full_name: lead.full_name || '',
      company_name: lead.company_name || '',
      activity: lead.activity || '',
      phone: lead.phone || '',
      email: lead.email || '',
      wilaya: lead.wilaya || 'Alger',
      lang: lead.lang || 'ar',
      source: lead.source || 'railway_api',
      page: lead.page || '',
      status: lead.status || 'Nouveau',
      notes: lead.notes || '',
      event_id: lead.id || '',
      fbp: lead.fbp || '',
      fbc: lead.fbc || ''
    }).toString();

    const client = sheetUrl.startsWith('https') ? https : http;
    const req = client.request(sheetUrl, {
      method: 'POST',
      headers: {
        'Content-Type': 'application/x-www-form-urlencoded',
        'Content-Length': Buffer.byteLength(postData)
      }
    });
    req.on('error', (err) => {
      console.warn('[Sheet Backup] Forward error:', err.message);
    });
    req.write(postData);
    req.end();
  } catch (e) {
    console.warn('[Sheet Backup] Exception:', e.message);
  }
}

// Helper: Dispatch Meta CAPI (Server-Side Events) for Lead & CompleteRegistration
async function dispatchMetaCapi(lead) {
  const pixelId = process.env.FB_PIXEL_ID || process.env.META_PIXEL_ID || '1446779740729835';
  const token = process.env.FB_ACCESS_TOKEN || process.env.META_ACCESS_TOKEN;
  if (!token || !pixelId) return;

  try {
    const nowSec = Math.floor(Date.now() / 1000);
    const capiPayload = {
      data: [
        {
          event_name: 'Lead',
          event_time: nowSec,
          event_id: lead.id,
          action_source: 'website',
          event_source_url: lead.page || 'https://idaraticompany.dz',
          user_data: {
            client_ip_address: lead.ip || undefined,
            client_user_agent: lead.userAgent || undefined,
            fbp: lead.fbp || undefined,
            fbc: lead.fbc || undefined
          },
          custom_data: {
            content_name: 'Demande Creation Entreprise',
            content_category: lead.wilaya || 'Alger',
            currency: 'DZD',
            value: 1
          }
        },
        {
          event_name: 'CompleteRegistration',
          event_time: nowSec,
          event_id: lead.id,
          action_source: 'website',
          event_source_url: lead.page || 'https://idaraticompany.dz',
          user_data: {
            client_ip_address: lead.ip || undefined,
            client_user_agent: lead.userAgent || undefined,
            fbp: lead.fbp || undefined,
            fbc: lead.fbc || undefined
          },
          custom_data: {
            content_name: 'Demande Creation Entreprise',
            content_category: lead.wilaya || 'Alger',
            currency: 'DZD',
            status: true,
            value: 1
          }
        }
      ]
    };

    const postData = JSON.stringify(capiPayload);
    const req = https.request(`https://graph.facebook.com/v19.0/${pixelId}/events?access_token=${encodeURIComponent(token)}`, {
      method: 'POST',
      headers: {
        'Content-Type': 'application/json',
        'Content-Length': Buffer.byteLength(postData)
      }
    });
    req.on('error', (err) => {
      console.warn('[Meta CAPI] Dispatch error:', err.message);
    });
    req.write(postData);
    req.end();
  } catch (e) {
    console.warn('[Meta CAPI] Exception:', e.message);
  }
}

/* ==========================================================================
   API ENDPOINTS
   ========================================================================== */

// Health check
app.get('/api/health', (req, res) => {
  res.json({
    status: 'ok',
    database: dbType,
    hasPool: Boolean(pool),
    uptime: Math.round(process.uptime()),
    timestamp: new Date().toISOString()
  });
});

// Runtime public config for frontend
app.get('/api/config', (req, res) => {
  res.json({
    pixelId: process.env.FB_PIXEL_ID || '1446779740729835',
    whatsapp: process.env.WHATSAPP || '213770345869',
    phone: process.env.PHONE || '+213773345816',
    sheetUrl: process.env.SHEET_URL || ''
  });
});

// CREATE LEAD (POST /api/leads)
app.post(['/api/leads', '/api/orders', '/api/submit'], async (req, res) => {
  try {
    const body = req.body || {};

    // Honeypot anti-spam
    if (body.website) {
      return res.json({ ok: true, ignored: true });
    }

    const fullName = (body.full_name || body.name || '').trim();
    const phone = (body.phone || '').trim();

    if (!fullName || !phone) {
      return res.status(400).json({ ok: false, error: 'Full name and phone are required.' });
    }

    const eventId = body.id || body.event_id || ('lead_' + Date.now() + '_' + Math.random().toString(36).slice(2, 8));
    const normPhone = normalizePhone(phone);
    const clientIp = req.headers['x-forwarded-for'] || req.socket.remoteAddress;
    const userAgent = req.headers['user-agent'];

    const newLead = {
      id: eventId,
      created_at: new Date().toISOString(),
      full_name: fullName,
      company_name: (body.company_name || '').trim(),
      activity: (body.activity || '').trim(),
      phone: phone,
      email: (body.email || '').trim(),
      wilaya: (body.wilaya || 'Alger').trim(),
      lang: (body.lang || 'ar').trim(),
      source: (body.source || 'landing').trim(),
      page: (body.page || '').trim(),
      status: (body.status || 'Nouveau').trim(),
      notes: (body.notes || '').trim(),
      service: (body.service || '').trim(),
      amount: (body.amount || '').trim(),
      fbp: (body.fbp || '').trim(),
      fbc: (body.fbc || '').trim(),
      ip: clientIp,
      userAgent: userAgent
    };

    let isDuplicate = false;

    // 1) PostgreSQL insertion / update
    if (pool) {
      // Check existing by normalized phone (stripping non-digits)
      const existCheck = await pool.query(
        "SELECT id, notes FROM leads WHERE REGEXP_REPLACE(phone, '[^0-9]', '', 'g') = REGEXP_REPLACE($1, '[^0-9]', '', 'g') LIMIT 1",
        [normPhone]
      );
      if (existCheck.rows.length > 0) {
        isDuplicate = true;
        const existing = existCheck.rows[0];
        const updatedNotes = (existing.notes ? existing.notes + ' | ' : '') + `إعادة إرسال طلب: ${new Date().toLocaleDateString('ar-DZ')}`;
        await pool.query('UPDATE leads SET notes = $1, created_at = CURRENT_TIMESTAMP WHERE id = $2', [updatedNotes, existing.id]);
      } else {
        await pool.query(
          `INSERT INTO leads (id, full_name, company_name, activity, phone, email, wilaya, lang, source, page, status, notes, service, amount, fbp, fbc)
           VALUES ($1, $2, $3, $4, $5, $6, $7, $8, $9, $10, $11, $12, $13, $14, $15, $16)`,
          [
            newLead.id, newLead.full_name, newLead.company_name, newLead.activity,
            newLead.phone, newLead.email, newLead.wilaya, newLead.lang,
            newLead.source, newLead.page, newLead.status, newLead.notes,
            newLead.service, newLead.amount, newLead.fbp, newLead.fbc
          ]
        );
      }
    } else {
      // Fallback JSON handling
      const fallbackLeads = readFallbackLeads();
      const existingIdx = fallbackLeads.findIndex(l => normalizePhone(l.phone) === normPhone);
      if (existingIdx !== -1) {
        isDuplicate = true;
        fallbackLeads[existingIdx].notes = (fallbackLeads[existingIdx].notes ? fallbackLeads[existingIdx].notes + ' | ' : '') + `إعادة طلب: ${new Date().toLocaleDateString('ar-DZ')}`;
        fallbackLeads[existingIdx].created_at = new Date().toISOString();
      } else {
        fallbackLeads.unshift(newLead);
      }
      writeFallbackLeads(fallbackLeads);
    }

    // 2) Asynchronous Sheet Backup & Meta CAPI
    forwardToGoogleSheet(newLead);
    dispatchMetaCapi(newLead);

    return res.json({
      ok: true,
      id: eventId,
      duplicate: isDuplicate,
      message: isDuplicate ? 'Lead already exists, updated record' : 'Lead created successfully'
    });
  } catch (err) {
    console.error('[API Leads] Error:', err);
    res.status(500).json({ ok: false, error: 'Internal server error while saving lead' });
  }
});

// GET ALL LEADS (GET /api/leads)
app.get('/api/leads', async (req, res) => {
  try {
    if (pool) {
      const result = await pool.query('SELECT * FROM leads ORDER BY created_at DESC LIMIT 500');
      return res.json({ ok: true, data: result.rows });
    } else {
      const leads = readFallbackLeads();
      return res.json({ ok: true, data: leads });
    }
  } catch (err) {
    console.error('[API Leads] Fetch error:', err);
    res.status(500).json({ ok: false, error: err.message });
  }
});

// UPDATE LEAD STATUS/NOTES (PATCH /api/leads/:id)
app.patch('/api/leads/:id', async (req, res) => {
  try {
    const { id } = req.params;
    const { status, notes } = req.body || {};

    if (pool) {
      const updates = [];
      const values = [];
      let idx = 1;

      if (status !== undefined) {
        updates.push(`status = $${idx++}`);
        values.push(status);
      }
      if (notes !== undefined) {
        updates.push(`notes = $${idx++}`);
        values.push(notes);
      }

      if (updates.length > 0) {
        values.push(id);
        await pool.query(`UPDATE leads SET ${updates.join(', ')} WHERE id = $${idx}`, values);
      }
      return res.json({ ok: true, updated: true });
    } else {
      const leads = readFallbackLeads();
      const item = leads.find(l => l.id === id);
      if (item) {
        if (status !== undefined) item.status = status;
        if (notes !== undefined) item.notes = notes;
        writeFallbackLeads(leads);
      }
      return res.json({ ok: true, updated: Boolean(item) });
    }
  } catch (err) {
    console.error('[API Leads] Update error:', err);
    res.status(500).json({ ok: false, error: err.message });
  }
});

// DELETE LEAD (DELETE /api/leads/:id)
app.delete('/api/leads/:id', async (req, res) => {
  try {
    const { id } = req.params;
    if (pool) {
      await pool.query('DELETE FROM leads WHERE id = $1', [id]);
      return res.json({ ok: true, deleted: true });
    } else {
      let leads = readFallbackLeads();
      leads = leads.filter(l => l.id !== id);
      writeFallbackLeads(leads);
      return res.json({ ok: true, deleted: true });
    }
  } catch (err) {
    console.error('[API Leads] Delete error:', err);
    res.status(500).json({ ok: false, error: err.message });
  }
});

// IMPORT & INJECT GOOGLE SHEET LEADS INTO RAILWAY DATABASE (POST /api/leads/import-sheet)
app.post('/api/leads/import-sheet', async (req, res) => {
  try {
    const sheetUrl = req.body?.sheetUrl || process.env.SHEET_URL || process.env.GOOGLE_SHEET_URL;
    if (!sheetUrl) {
      return res.status(400).json({ ok: false, error: 'SHEET_URL is not configured.' });
    }
    const result = await syncSheetLeads(sheetUrl);
    return res.json(result);
  } catch (err) {
    console.error('[API Import Sheet] Error:', err);
    res.status(500).json({ ok: false, error: err.message });
  }
});

/* ==========================================================================
   STATIC FILES & ROUTING
   ========================================================================== */

// Explicit subpage routes
app.get(['/thank-you', '/thank-you/'], (req, res) => {
  res.sendFile(path.join(__dirname, 'thank-you', 'index.html'));
});

app.get(['/merci', '/merci/'], (req, res) => {
  res.sendFile(path.join(__dirname, 'merci', 'index.html'));
});

app.get(['/admin', '/admin/'], (req, res) => {
  res.sendFile(path.join(__dirname, 'admin', 'index.html'));
});

app.get(['/form', '/form/'], (req, res) => {
  res.sendFile(path.join(__dirname, 'form', 'index.html'));
});

app.get(['/services', '/services/'], (req, res) => {
  res.sendFile(path.join(__dirname, 'services', 'index.html'));
});

app.get(['/offer', '/offer/'], (req, res) => {
  res.sendFile(path.join(__dirname, 'offer', 'index.html'));
});

app.get(['/about', '/about/'], (req, res) => {
  res.sendFile(path.join(__dirname, 'about', 'index.html'));
});

app.get(['/how-it-works', '/how-it-works/'], (req, res) => {
  res.sendFile(path.join(__dirname, 'how-it-works', 'index.html'));
});

app.get(['/steps', '/steps/'], (req, res) => {
  res.sendFile(path.join(__dirname, 'steps', 'index.html'));
});

app.get(['/order', '/order/'], (req, res) => {
  res.sendFile(path.join(__dirname, 'order', 'index.html'));
});

app.get(['/testimonials', '/testimonials/'], (req, res) => {
  res.sendFile(path.join(__dirname, 'testimonials', 'index.html'));
});

app.get(['/contact', '/contact/'], (req, res) => {
  res.sendFile(path.join(__dirname, 'contact', 'index.html'));
});

app.get(['/faq', '/faq/'], (req, res) => {
  res.sendFile(path.join(__dirname, 'faq', 'index.html'));
});

// Static assets (css, js, media, audio, video)
app.use(express.static(__dirname, {
  extensions: ['html', 'htm']
}));

// Root route
app.get('/', (req, res) => {
  res.sendFile(path.join(__dirname, 'index.html'));
});

// 404 handler
app.use((req, res) => {
  const custom404 = path.join(__dirname, '404.html');
  if (fs.existsSync(custom404)) {
    res.status(404).sendFile(custom404);
  } else {
    res.status(404).send('Not Found');
  }
});

// Start Server
app.listen(PORT, '0.0.0.0', () => {
  console.log(`=========================================`);
  console.log(`🚀 IDARATI Server running on port ${PORT}`);
  console.log(`📦 Database Mode: ${dbType}`);
  console.log(`🌐 Local URL: http://localhost:${PORT}`);
  console.log(`=========================================`);
});

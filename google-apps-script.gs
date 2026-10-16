/**
 * IDARATI : استقبال طلبات صفحة الهبوط في Google Sheets
 * Réception des demandes de la landing page dans Google Sheets
 *
 * التثبيت (مرة واحدة فقط):
 * 1) افتح Google Sheet جديد  ←  Extensions (الإضافات) ← Apps Script
 * 2) احذف كل الكود الموجود وألصق هذا الملف كاملاً، ثم احفظ.
 * 3) Deploy (نشر) ← New deployment ← النوع: Web app
 *      Execute as: Me (أنا)      Who has access: Anyone (أي شخص)
 * 4) وافق على الأذونات، ثم انسخ رابط "Web app URL" (ينتهي بـ /exec)
 * 5) ألصقه في index.html داخل  CONFIG.SHEET_URL
 *
 * ⚠️ إذا عدّلت هذا الكود لاحقاً: Deploy ← Manage deployments ← Edit ← Version: New version
 */

const SHEET_NAME   = 'Demandes';   // اسم الورقة
const NOTIFY_EMAIL = '';           // اختياري: بريد يصلك عليه تنبيه بكل طلب جديد (مثال: 'contact@idaraticompany.dz')

const HEADERS = ['Date', 'Nom complet', 'Société (nom souhaité)', 'Activité', 'Téléphone', 'E-mail',
                 'Wilaya', 'Langue', 'Source (UTM)', 'Page', 'Statut'];

function doPost(e) {
  const lock = LockService.getScriptLock();
  lock.waitLock(10000);
  try {
    const p = (e && e.parameter) || {};
    if (p.website) return json_({ ok: true });                       // anti-spam (honeypot)

    // تحديث حالة الطلب من لوحة التحكم / Mise à jour statut depuis le dashboard
    if (p.action === 'update_status' && p.phone) {
      const sh = getSheet_();
      const data = sh.getDataRange().getValues();
      const targetPhone = String(p.phone).replace(/\D/g, '');
      for (let i = 1; i < data.length; i++) {
        const rowPhone = String(data[i][4] || '').replace(/\D/g, '');
        if (rowPhone && targetPhone && (rowPhone === targetPhone || rowPhone.endsWith(targetPhone.slice(-8)))) {
          if (p.status) sh.getRange(i + 1, 11).setValue(p.status);
          return json_({ ok: true, updated: true });
        }
      }
      return json_({ ok: true, not_found: true });
    }

    if (!p.full_name || !p.phone) return json_({ ok: false, error: 'missing fields' });

    const sh = getSheet_();
    const row = [
      new Date(),
      clean_(p.full_name), clean_(p.company_name), clean_(p.activity),
      clean_(p.phone), clean_(p.email),
      clean_(p.wilaya) === 'Blida' ? 'Blida' : 'Alger',
      clean_(p.lang), clean_(p.source), clean_(p.page),
      'Nouveau'
    ];
    sh.appendRow(row);

    if (NOTIFY_EMAIL) {
      MailApp.sendEmail(NOTIFY_EMAIL,
        'Nouvelle demande - Création d\'entreprise (' + row[6] + ')',
        HEADERS.slice(0, 8).map(function (h, i) { return h + ' : ' + row[i]; }).join('\n'));
    }
    return json_({ ok: true });
  } catch (err) {
    return json_({ ok: false, error: String(err) });
  } finally {
    lock.releaseLock();
  }
}

function doGet(e) {
  const p = (e && e.parameter) || {};

  // جلب الطلبات إلى لوحة التحكم / Récupération des demandes pour le dashboard
  if (p.action === 'get_leads') {
    const sh = getSheet_();
    const data = sh.getDataRange().getValues();
    if (data.length <= 1) return json_({ ok: true, leads: [] });
    const leads = [];
    for (let i = 1; i < data.length; i++) {
      const r = data[i];
      if (!r[0] && !r[1]) continue;
      leads.push({
        id: 'lead-row-' + i,
        date: r[0] ? new Date(r[0]).toISOString() : new Date().toISOString(),
        full_name: String(r[1] || ''),
        company_name: String(r[2] || ''),
        activity: String(r[3] || ''),
        phone: String(r[4] || ''),
        email: String(r[5] || ''),
        wilaya: String(r[6] || 'Alger'),
        lang: String(r[7] || 'ar'),
        source: String(r[8] || 'web'),
        page: String(r[9] || ''),
        status: String(r[10] || 'Nouveau')
      });
    }
    return json_({ ok: true, leads: leads.reverse() });
  }

  return json_({ ok: true, service: 'IDARATI leads API' });
}

function getSheet_() {
  const ss = SpreadsheetApp.getActiveSpreadsheet();
  let sh = ss.getSheetByName(SHEET_NAME) || ss.insertSheet(SHEET_NAME);
  if (sh.getLastRow() === 0) {
    sh.appendRow(HEADERS);
    sh.getRange(1, 1, 1, HEADERS.length).setFontWeight('bold').setBackground('#16378D').setFontColor('#FFFFFF');
    sh.setFrozenRows(1);
    sh.getRange('A:A').setNumberFormat('dd/mm/yyyy hh:mm');
    sh.getRange('E:E').setNumberFormat('@');
    const rule = SpreadsheetApp.newDataValidation().requireValueInList(['Nouveau', 'Appelé', 'Rappeler', 'Client', 'Non intéressé']).build();
    sh.getRange(2, HEADERS.length, 1000).setDataValidation(rule);
  }
  return sh;
}

// يمنع إدخال صيغ في الجدول ويحدّ الطول
function clean_(v) {
  v = String(v == null ? '' : v).trim().slice(0, 300);
  return /^[=+\-@]/.test(v) ? "'" + v : v;
}

function json_(o) {
  return ContentService.createTextOutput(JSON.stringify(o)).setMimeType(ContentService.MimeType.JSON);
}

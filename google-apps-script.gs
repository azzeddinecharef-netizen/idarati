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

const SHEET_NAME     = 'Demandes';   // اسم الورقة
const SPREADSHEET_ID = '1EKgjfkVypCbLUoMcMsxvyIZSWGK6YqdVPIQg2ASMPu4'; // معرّف جدولك المباشر
const NOTIFY_EMAIL   = '';           // اختياري: بريد يصلك عليه تنبيه بكل طلب جديد (مثال: 'contact@idaraticompany.dz')

const HEADERS = ['Date', 'Nom complet', 'Société (nom souhaité)', 'Activité', 'Téléphone', 'E-mail',
                 'Wilaya', 'Langue', 'Source (UTM)', 'Page', 'Statut', 'Notes'];

function doPost(e) {
  const lock = LockService.getScriptLock();
  lock.waitLock(10000);
  try {
    const p = (e && e.parameter) || {};
    if (p.website) return json_({ ok: true });                       // anti-spam (honeypot)

    // تحديث حالة وملاحظات الطلب من لوحة التحكم / Mise à jour statut & notes depuis le dashboard
    if (p.action === 'update_status' && p.phone) {
      const sh = getSheet_();
      const data = sh.getDataRange().getValues();
      const targetPhone = String(p.phone).replace(/\D/g, '');
      for (let i = 1; i < data.length; i++) {
        const rowPhone = String(data[i][4] || '').replace(/\D/g, '');
        if (rowPhone && targetPhone && (rowPhone === targetPhone || rowPhone.endsWith(targetPhone.slice(-8)))) {
          if (p.status) sh.getRange(i + 1, 11).setValue(p.status);
          if (p.notes !== undefined && p.notes !== null) sh.getRange(i + 1, 12).setValue(p.notes);
          return json_({ ok: true, updated: true });
        }
      }
      return json_({ ok: true, not_found: true });
    }

    // حذف طلب من لوحة التحكم والجدول نهائياً / Supprimer un lead
    if (p.action === 'delete_lead' && (p.phone || p.id)) {
      const sh = getSheet_();
      const data = sh.getDataRange().getValues();
      const targetPhone = p.phone ? String(p.phone).replace(/\D/g, '') : '';
      for (let i = 1; i < data.length; i++) {
        const rowPhone = String(data[i][4] || '').replace(/\D/g, '');
        const matchPhone = targetPhone && rowPhone && (rowPhone === targetPhone || rowPhone.endsWith(targetPhone.slice(-8)));
        if (matchPhone || p.id === ('lead-row-' + i)) {
          sh.deleteRow(i + 1);
          return json_({ ok: true, deleted: true });
        }
      }
      return json_({ ok: true, not_found: true });
    }

    if (!p.full_name || !p.phone) return json_({ ok: false, error: 'missing fields' });

    const sh = getSheet_();
    
    // تركيبة النشاط مع الخدمة والمبلغ إن وجدوا
    let activityText = clean_(p.activity);
    if (p.service) activityText += (activityText ? ' - ' : '') + clean_(p.service);
    if (p.amount) activityText += ' [' + clean_(p.amount) + ' دج]';

    const row = [
      new Date(),
      clean_(p.full_name), clean_(p.company_name), activityText,
      clean_(p.phone), clean_(p.email),
      clean_(p.wilaya) || 'Alger',
      clean_(p.lang) || 'ar', clean_(p.source) || (p.action === 'add_lead' ? 'يدوي (Dashboard)' : 'web'), clean_(p.page) || 'لوحة التحكم',
      clean_(p.status) || 'Nouveau',
      clean_(p.notes) || ''
    ];
    sh.appendRow(row);

    if (NOTIFY_EMAIL) {
      MailApp.sendEmail(NOTIFY_EMAIL,
        'Nouvelle demande - Création d\'entreprise (' + row[6] + ')',
        HEADERS.slice(0, 8).map(function (h, i) { return h + ' : ' + row[i]; }).join('\n'));
    }
    return json_({ ok: true, added: true });
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
        status: String(r[10] || 'Nouveau'),
        notes: String(r[11] || '')
      });
    }
    return json_({ 
      ok: true, 
      spreadsheet_name: sh.getParent().getName(),
      spreadsheet_url: sh.getParent().getUrl(),
      spreadsheet_id: sh.getParent().getId(),
      sheet_name: sh.getName(),
      leads: leads.reverse() 
    });
  }

  // رابط الجدول المباشر
  if (p.action === 'get_sheet_info') {
    const sh = getSheet_();
    return json_({
      ok: true,
      spreadsheet_name: sh.getParent().getName(),
      spreadsheet_url: sh.getParent().getUrl(),
      spreadsheet_id: sh.getParent().getId(),
      sheet_name: sh.getName()
    });
  }

  return json_({ ok: true, service: 'IDARATI leads API' });
}

function getSheet_() {
  let ss = SpreadsheetApp.getActiveSpreadsheet();
  if (!ss && typeof SPREADSHEET_ID !== 'undefined' && SPREADSHEET_ID) {
    try {
      ss = SpreadsheetApp.openById(SPREADSHEET_ID);
    } catch (e) {
      Logger.log('Could not open spreadsheet by ID: ' + e);
    }
  }
  if (!ss) {
    throw new Error('Spreadsheet not found! SPREADSHEET_ID is missing or inaccessible.');
  }
  let sh = ss.getSheetByName(SHEET_NAME);
  if (!sh) {
    const firstSheet = ss.getSheets()[0];
    if (firstSheet && (firstSheet.getName() === 'Sheet1' || firstSheet.getName() === 'Feuille 1' || firstSheet.getName() === 'ورقة 1')) {
      firstSheet.setName(SHEET_NAME);
      sh = firstSheet;
    } else {
      sh = ss.insertSheet(SHEET_NAME);
    }
  }
  if (sh.getLastRow() === 0) {
    sh.appendRow(HEADERS);
    sh.getRange(1, 1, 1, HEADERS.length).setFontWeight('bold').setBackground('#16378D').setFontColor('#FFFFFF');
    sh.setFrozenRows(1);
    sh.getRange('A:A').setNumberFormat('dd/mm/yyyy hh:mm');
    sh.getRange('E:E').setNumberFormat('@');
    const rule = SpreadsheetApp.newDataValidation().requireValueInList(['Nouveau', 'Appelé', 'Rappeler', 'RDV', 'Client', 'Non intéressé']).build();
    sh.getRange(2, 11, 1000).setDataValidation(rule);
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

/**
 * دالة لإضافة الطلبات السبعة مباشرة داخل الجدول بنقرة واحدة
 * اختر هذه الدالة من شريط الأدوات بالأعلى واضغط Run (تشغيل) ▶️
 */
function seedInitialLeads() {
  const sh = getSheet_();
  const initialLeads = [
    {
      date: new Date("2026-10-22T15:56:27.107Z"),
      full_name: "LAROUCI NASSEREDDINE",
      company_name: "SARL RBS",
      activity: "بناء وأشغال عمومية",
      phone: "0557772151",
      email: "nassereddinelarouci@yahoo.fr",
      wilaya: "Alger",
      lang: "ar",
      source: "web",
      page: "صفحة الهبوط",
      status: "Client",
      notes: ""
    },
    {
      date: new Date("2026-10-23T12:44:46.776Z"),
      full_name: "Mld",
      company_name: "",
      activity: "تجارة بالتجزئة",
      phone: "0771034952",
      email: "",
      wilaya: "Alger",
      lang: "ar",
      source: "web",
      page: "صفحة الهبوط",
      status: "Nouveau",
      notes: ""
    },
    {
      date: new Date("2026-10-23T15:36:14.652Z"),
      full_name: "Ali Sky",
      company_name: "sofain  lmbri",
      activity: "استيراد وتصدير",
      phone: "+213558576243",
      email: "karisonatrac@gmail.com",
      wilaya: "Alger",
      lang: "ar",
      source: "web",
      page: "صفحة الهبوط",
      status: "Nouveau",
      notes: ""
    },
    {
      date: new Date("2026-10-23T15:44:06.969Z"),
      full_name: "Abdenacer MAREDJ",
      company_name: "",
      activity: "تكوين وتعليم",
      phone: "0792581917",
      email: "maredjnacer@gmail.com",
      wilaya: "Alger",
      lang: "ar",
      source: "web",
      page: "صفحة الهبوط",
      status: "Nouveau",
      notes: ""
    },
    {
      date: new Date("2026-10-23T15:45:19.770Z"),
      full_name: "مخناش مصطفى",
      company_name: "ميرة ماركت",
      activity: "تجارة بالتجزئة",
      phone: "0791226500",
      email: "musmek442@gmail.com",
      wilaya: "Alger",
      lang: "ar",
      source: "web",
      page: "صفحة الهبوط",
      status: "Nouveau",
      notes: ""
    },
    {
      date: new Date("2026-10-23T15:53:08.576Z"),
      full_name: "Abdelkader Addad",
      company_name: "Lora",
      activity: "Entprise de construction",
      phone: "+213540885130",
      email: "addadaek@gmail.com",
      wilaya: "Alger",
      lang: "ar",
      source: "web",
      page: "صفحة الهبوط",
      status: "Nouveau",
      notes: ""
    },
    {
      date: new Date("2026-10-23T21:54:47.139Z"),
      full_name: "Hayet Hammoudi",
      company_name: "EURL Haypro safety",
      activity: "تجارة بالجملة",
      phone: "0699882505",
      email: "hayethammoudi85@gmail.com",
      wilaya: "Blida",
      lang: "ar",
      source: "web",
      page: "صفحة الهبوط",
      status: "Rappeler",
      notes: ""
    }
  ];

  const data = sh.getDataRange().getValues();
  const existingPhones = new Set();
  for (let i = 1; i < data.length; i++) {
    const p = String(data[i][4] || '').replace(/\D/g, '');
    if (p) existingPhones.add(p);
  }

  let added = 0;
  initialLeads.forEach(function(l) {
    const rawP = String(l.phone).replace(/\D/g, '');
    if (!existingPhones.has(rawP)) {
      sh.appendRow([
        l.date,
        clean_(l.full_name),
        clean_(l.company_name),
        clean_(l.activity),
        clean_(l.phone),
        clean_(l.email),
        clean_(l.wilaya),
        clean_(l.lang),
        clean_(l.source),
        clean_(l.page),
        clean_(l.status),
        clean_(l.notes)
      ]);
      existingPhones.add(rawP);
      added++;
    }
  });

  Logger.log('✅ تم إدراج ' + added + ' طلبات في Google Sheet بنجاح!');
}


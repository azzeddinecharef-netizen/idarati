/**
 * IDARATI : استقبال طلبات صفحة الهبوط في Google Sheets وتفادي التكرار
 * Réception et déduplication des demandes de la landing page dans Google Sheets
 *
 * التثبيت والتحديث:
 * 1) افتح جدول Google Sheet  ←  Extensions (الإضافات) ← Apps Script
 * 2) احذف كل الكود القديم وألصق هذا الملف كاملاً، ثم احفظ (Ctrl + S).
 * 3) لتنظيف الأسطر المكررة حالياً (الـ 99+ سطر):
 *    اختر الدالة `cleanDuplicatesInSheet` من القائمة المنسدلة في الأعلى واضغط Run (تشغيل) ▶️.
 * 4) Deploy (نشر) ← Manage deployments ← Edit (أيقونة القلم) ← Version: New version ← Deploy.
 */

const SHEET_NAME     = 'Demandes';   // اسم الورقة
const SPREADSHEET_ID = '1EKgjfkVypCbLUoMcMsxvyIZSWGK6YqdVPIQg2ASMPu4'; // معرّف جدولك المباشر
const NOTIFY_EMAIL   = '';           // اختياري: بريد يصلك عليه تنبيه بكل طلب جديد (مثال: 'contact@idaraticompany.dz')

const HEADERS = ['Date', 'Nom complet', 'Société (nom souhaité)', 'Activité', 'Téléphone', 'E-mail',
                 'Wilaya', 'Langue', 'Source (UTM)', 'Page', 'Statut', 'Notes'];

function doPost(e) {
  const lock = LockService.getScriptLock();
  // انتظر حتى 15 ثانية للحصول على القفل لمنع تداخل العمليات
  lock.waitLock(15000);
  try {
    const p = (e && e.parameter) || {};
    if (p.website) return json_({ ok: true }); // anti-spam (honeypot)

    // 1) تنظيف وحذف جميع التكرارات في الجدول بطلب من لوحة التحكم
    if (p.action === 'clean_duplicates') {
      const res = cleanDuplicatesInSheet();
      return json_({ ok: true, cleaned: true, ...res });
    }

    // 2) تحديث حالة وملاحظات الطلب من لوحة التحكم
    if (p.action === 'update_status' && p.phone) {
      const sh = getSheet_();
      const data = sh.getDataRange().getValues();
      const targetPhone = normPhone_(p.phone);
      for (let i = 1; i < data.length; i++) {
        const rowPhone = normPhone_(data[i][4]);
        if (rowPhone && targetPhone && (rowPhone === targetPhone || isPhoneMatch_(rowPhone, targetPhone))) {
          if (p.status) sh.getRange(i + 1, 11).setValue(p.status);
          if (p.notes !== undefined && p.notes !== null) sh.getRange(i + 1, 12).setValue(p.notes);
          return json_({ ok: true, updated: true });
        }
      }
      return json_({ ok: true, not_found: true });
    }

    // 3) حذف طلب من لوحة التحكم والجدول نهائياً
    if (p.action === 'delete_lead' && (p.phone || p.id)) {
      const sh = getSheet_();
      const data = sh.getDataRange().getValues();
      const targetPhone = normPhone_(p.phone);
      for (let i = 1; i < data.length; i++) {
        const rowPhone = normPhone_(data[i][4]);
        const matchPhone = targetPhone && rowPhone && (rowPhone === targetPhone || isPhoneMatch_(rowPhone, targetPhone));
        if (matchPhone || p.id === ('lead-row-' + i)) {
          sh.deleteRow(i + 1);
          return json_({ ok: true, deleted: true });
        }
      }
      return json_({ ok: true, not_found: true });
    }

    if (!p.full_name || !p.phone) return json_({ ok: false, error: 'missing fields' });

    const sh = getSheet_();
    const targetPhone = normPhone_(p.phone);

    // 4) منع التكرار الحاسم: التحقق إن كان رقم الهاتف مسجلاً مسبقاً في الجدول
    if (targetPhone) {
      const data = sh.getDataRange().getValues();
      for (let i = 1; i < data.length; i++) {
        const rowPhone = normPhone_(data[i][4]);
        if (rowPhone && (rowPhone === targetPhone || isPhoneMatch_(rowPhone, targetPhone))) {
          // العميل مسجل مسبقاً! نقوم فقط بتحديث حالته أو ملاحظاته إن وردت، ولا نكرر السطر إطلاقاً
          if (p.status && p.status !== 'Nouveau') sh.getRange(i + 1, 11).setValue(p.status);
          if (p.notes) sh.getRange(i + 1, 12).setValue(p.notes);
          return json_({ ok: true, duplicate: true, updated: true, row: i + 1, message: 'Lead already exists, updated instead of duplicate.' });
        }
      }
    }
    
    // تركيبة النشاط مع الخدمة والمبلغ إن وجدوا
    let activityText = clean_(p.activity);
    if (p.service) activityText += (activityText ? ' - ' : '') + clean_(p.service);
    if (p.amount) activityText += ' [' + clean_(p.amount) + ' دج]';

    // حفظ رقم الهاتف مسبوقاً بـ ' لضمان عدم حذف الصفر في البداية من طرف Google Sheets
    const phoneToStore = formatPhoneForStorage_(p.phone);

    const row = [
      new Date(),
      clean_(p.full_name), clean_(p.company_name), activityText,
      phoneToStore, clean_(p.email),
      clean_(p.wilaya) || 'Alger',
      clean_(p.lang) || 'ar', clean_(p.source) || (p.action === 'add_lead' ? 'يدوي (Dashboard)' : 'web'), clean_(p.page) || 'لوحة التحكم',
      clean_(p.status) || 'Nouveau',
      clean_(p.notes) || ''
    ];
    sh.appendRow(row);

    // 5) إرسال الحدث إلى Meta Conversions API (Graph API v21.0) بنفس معرّف الحدث (lead_IDR-xxxxxx)
    sendMetaConversionsAPI_(p);

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

  // 1) تنظيف التكرارات عبر رابط مباشر (GET)
  if (p.action === 'clean_duplicates') {
    const lock = LockService.getScriptLock();
    lock.waitLock(15000);
    try {
      const res = cleanDuplicatesInSheet();
      return json_({ ok: true, cleaned: true, ...res });
    } finally {
      lock.releaseLock();
    }
  }

  // 2) جلب الطلبات إلى لوحة التحكم مع منع التكرار وإعادة أحدث نسخة فقط لكل عميل
  if (p.action === 'get_leads') {
    const sh = getSheet_();
    const data = sh.getDataRange().getValues();
    if (data.length <= 1) return json_({ ok: true, leads: [] });
    
    const leads = [];
    const seenPhones = new Set();

    // نقرأ من الأحدث (أسفل الجدول) إلى الأقدم (أعلى الجدول)
    for (let i = data.length - 1; i >= 1; i--) {
      const r = data[i];
      if (!r[0] && !r[1]) continue;
      const rawPhone = String(r[4] || '');
      const norm = normPhone_(rawPhone);

      // استبعاد التكرارات وإرجاع أحدث سطر فقط لهذا العميل
      if (norm) {
        if (seenPhones.has(norm)) continue;
        seenPhones.add(norm);
      }

      leads.push({
        id: 'lead-row-' + i,
        date: r[0] ? new Date(r[0]).toISOString() : new Date().toISOString(),
        full_name: String(r[1] || ''),
        company_name: String(r[2] || ''),
        activity: String(r[3] || ''),
        phone: rawPhone.replace(/^'/, ''),
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
      total_rows_in_sheet: data.length - 1,
      unique_leads_count: leads.length,
      leads: leads 
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

/**
 * دالة لتنظيف وإزالة جميع الأسطر المكررة من جدول Google Sheets بنقرة واحدة فائقة السرعة
 * اختر هذه الدالة من شريط الأدوات بالأعلى واضغط Run (تشغيل) ▶️
 */
function cleanDuplicatesInSheet() {
  const sh = getSheet_();
  const data = sh.getDataRange().getValues();
  if (data.length <= 1) return { total_before: 0, total_after: 0, removed: 0 };

  const header = data[0];
  const uniqueMap = new Map();

  // نقرأ من الأقدم للأحدث حتى نحافظ على أحدث التحديثات
  for (let i = 1; i < data.length; i++) {
    const row = data[i];
    const rawPhone = String(row[4] || '');
    const phone = normPhone_(rawPhone);
    if (!phone) {
      if (row[1]) uniqueMap.set('no-phone-' + i, row);
      continue;
    }
    
    // تنسيق رقم الهاتف ليحتفظ بالصفر في البداية
    row[4] = formatPhoneForStorage_(rawPhone);

    if (!uniqueMap.has(phone)) {
      uniqueMap.set(phone, row);
    } else {
      const existing = uniqueMap.get(phone);
      // إذا كانت الحالة في السطر المكرر متقدمة عن Nouveau نعتمدها
      if (row[10] && row[10] !== 'Nouveau' && existing[10] === 'Nouveau') {
        existing[10] = row[10];
      }
      if (row[11]) {
        existing[11] = row[11];
      }
      if (row[0] && new Date(row[0]) > new Date(existing[0])) {
        existing[0] = row[0];
      }
    }
  }

  const uniqueRows = [header, ...Array.from(uniqueMap.values())];
  
  // مسح الجدول القديم وكتابة الأسطر الفريدة دفعة واحدة
  sh.clearContents();
  sh.getRange(1, 1, uniqueRows.length, uniqueRows[0].length).setValues(uniqueRows);
  
  // إعادة تنسيق عمود التاريخ وعمود الهاتف
  sh.getRange('A:A').setNumberFormat('dd/mm/yyyy hh:mm');
  sh.getRange('E:E').setNumberFormat('@');

  const removed = (data.length - 1) - (uniqueRows.length - 1);
  Logger.log('✅ تم تنظيف الجدول بنجاح! تم حذف ' + removed + ' سطر مكرر، وبقي ' + (uniqueRows.length - 1) + ' طلبية فريدة.');
  return {
    total_before: data.length - 1,
    total_after: uniqueRows.length - 1,
    removed: removed
  };
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

// يوحّد رقم الهاتف الجزائري لمقارنة دقيقة ومنع التكرار
function normPhone_(p) {
  if (!p) return '';
  let s = String(p).replace(/\D/g, '');
  if (s.indexOf('00213') === 0) s = s.substring(5);
  else if (s.indexOf('213') === 0) s = s.substring(3);
  s = s.replace(/^0+/, '');
  return s;
}

// مقارنة دقيقة بين رقمين هاتف جزائريين
function isPhoneMatch_(p1, p2) {
  if (!p1 || !p2) return false;
  if (p1 === p2) return true;
  if (p1.length >= 8 && p2.length >= 8) {
    return p1.slice(-8) === p2.slice(-8);
  }
  return false;
}

// تخزين الهاتف مع الصفر وفي صيغة نصية
function formatPhoneForStorage_(p) {
  if (!p) return '';
  let s = String(p).trim().replace(/^'/, '');
  const digits = s.replace(/\D/g, '');
  // إذا كان رقماً جزائرياً بدون صفر وبدون 213 ومكون من 9 أرقام، أضف 0
  if (digits.length === 9 && /^[567]/.test(digits) && !s.startsWith('+') && !s.startsWith('0')) {
    s = '0' + digits;
  }
  return "'" + s;
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
 * دالة لإضافة الطلبات السبعة الأولية إذا كان الجدول فارغاً
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
    const p = normPhone_(data[i][4]);
    if (p) existingPhones.add(p);
  }

  let added = 0;
  initialLeads.forEach(function(l) {
    const norm = normPhone_(l.phone);
    if (!existingPhones.has(norm)) {
      sh.appendRow([
        l.date,
        clean_(l.full_name),
        clean_(l.company_name),
        clean_(l.activity),
        formatPhoneForStorage_(l.phone),
        clean_(l.email),
        clean_(l.wilaya),
        clean_(l.lang),
        clean_(l.source),
        clean_(l.page),
        clean_(l.status),
        clean_(l.notes)
      ]);
      existingPhones.add(norm);
      added++;
    }
  });

  Logger.log('✅ تم إدراج ' + added + ' طلبات في Google Sheet بنجاح!');
}

/**
 * إرسال أحداث التحويل (Lead & CompleteRegistration) إلى Meta Conversions API (Graph API v21.0)
 * يستخدم التوكن المخزن بأمان في Script Properties (الاسم المعتمد: META_CAPI_TOKEN)
 */
function sendMetaConversionsAPI_(p) {
  try {
    const props = PropertiesService.getScriptProperties();
    // 1) جلب التوكن من Script Properties بالاسم META_CAPI_TOKEN (مع دعم التسميات البديلة)
    const token = props.getProperty('META_CAPI_TOKEN') || props.getProperty('FB_ACCESS_TOKEN') || props.getProperty('META_ACCESS_TOKEN') || p.access_token || '';
    const pixelId = props.getProperty('META_PIXEL_ID') || props.getProperty('FB_PIXEL_ID') || '1446779740729835';

    if (!token) {
      Logger.log('[Meta CAPI] تحذير: لم يتم العثور على META_CAPI_TOKEN في Script Properties. تجاوز إرسال CAPI.');
      return;
    }

    // 2) استخراج وتوحيد معرف الحدث (lead_IDR-xxxxxx) ليتطابق بنسبة 100% مع المتصفح
    const rawId = p.event_id || p.eventId || p.id || '';
    let cleanId = '';
    if (String(rawId).startsWith('lead_IDR-')) {
      cleanId = String(rawId).replace('lead_', '');
    } else if (String(rawId).startsWith('IDR-')) {
      cleanId = String(rawId);
    } else if (String(rawId).startsWith('lead_')) {
      cleanId = String(rawId).replace('lead_', '');
    } else {
      cleanId = 'IDR-' + Math.floor(100000 + Math.random() * 900000);
    }

    const eventId = 'lead_' + cleanId;
    const nowSec = Math.floor(Date.now() / 1000);
    const sourceUrl = p.event_source_url || p.page || 'https://idarati-company.africacold.fr/';

    // 3) تنقية وتشفير الهاتف إلى صيغة 213XXXXXXXXX عبر SHA-256
    let normPhone = String(p.phone || '').replace(/\D/g, '');
    if (normPhone.indexOf('00213') === 0) normPhone = normPhone.substring(5);
    else if (normPhone.indexOf('213') === 0) normPhone = normPhone.substring(3);
    normPhone = normPhone.replace(/^0+/, '');
    if (normPhone) normPhone = '213' + normPhone;

    const userData = {};
    if (normPhone) userData.ph = [sha256Hex_(normPhone)];
    if (p.email && String(p.email).trim()) {
      userData.em = [sha256Hex_(String(p.email).trim().toLowerCase())];
    }
    if (p.user_agent || p.userAgent) userData.client_user_agent = String(p.user_agent || p.userAgent);
    if (p.fbp) userData.fbp = String(p.fbp);
    if (p.fbc) userData.fbc = String(p.fbc);
    if (p.client_ip || p.ip) userData.client_ip_address = String(p.client_ip || p.ip);

    const wilayaVal = p.wilaya || 'Alger';

    // 4) إرسال حدثين فقط: Lead و CompleteRegistration بنفس معرّف الحدث ومن دون أي Purchase
    const events = [
      {
        event_name: 'Lead',
        event_time: nowSec,
        event_id: eventId,
        action_source: 'website',
        event_source_url: sourceUrl,
        user_data: userData,
        custom_data: {
          content_name: 'Creation entreprise',
          content_category: wilayaVal,
          currency: 'DZD',
          value: 1
        }
      },
      {
        event_name: 'CompleteRegistration',
        event_time: nowSec,
        event_id: eventId,
        action_source: 'website',
        event_source_url: sourceUrl,
        user_data: userData,
        custom_data: {
          content_name: 'Creation entreprise',
          content_category: wilayaVal,
          currency: 'DZD',
          status: true,
          value: 1
        }
      }
    ];

    const payload = { data: events };
    // 5) إدراج test_event_code فقط إذا تم تمريره من الواجهة الأمامية للاختبار
    if (p.test_event_code && String(p.test_event_code).trim()) {
      payload.test_event_code = String(p.test_event_code).trim();
    }

    const options = {
      method: 'post',
      contentType: 'application/json',
      payload: JSON.stringify(payload),
      muteHttpExceptions: true
    };

    const endpoint = 'https://graph.facebook.com/v21.0/' + pixelId + '/events?access_token=' + encodeURIComponent(token);
    const res = UrlFetchApp.fetch(endpoint, options);
    // 6) تسجيل الرد كاملاً في سجلات Apps Script (Executions) للتشخيص الفوري
    Logger.log('[Meta CAPI] Endpoint: ' + endpoint.replace(token, 'TOKEN_HIDDEN'));
    Logger.log('[Meta CAPI] Event ID: ' + eventId + ' | TestCode: ' + (payload.test_event_code || 'none'));
    Logger.log('[Meta CAPI] HTTP Response: ' + res.getResponseCode() + ' | Body: ' + res.getContentText());
  } catch (err) {
    Logger.log('[Meta CAPI] Exception caught: ' + err.toString());
  }
}

function sha256Hex_(str) {
  if (!str) return '';
  const digest = Utilities.computeDigest(Utilities.DigestAlgorithm.SHA_256, String(str).trim().toLowerCase(), Utilities.Charset.UTF_8);
  let hex = '';
  for (let i = 0; i < digest.length; i++) {
    const b = digest[i];
    let h = (b < 0 ? b + 256 : b).toString(16);
    if (h.length === 1) h = '0' + h;
    hex += h;
  }
  return hex;
}

const SPREADSHEET_ID = '1WoEWYlYjmSxs4RdmG4d5_r3wMULxTWSt6IuaOwa70I8';
const SHEET_NAME = 'Reservas';
const ADMIN_EMAIL = 'antoniogarrido@bartolomeflores.com';
const TIME_ZONE = 'Europe/Madrid';
const PORTAL_URL = 'https://agarmor666.github.io/Portal-de-pr-stamo-y-solicitud-de-materiales/';
const ADMIN_PASSWORD_SALT = 'reservas-ceip-bf-2026-v1:';
const ADMIN_PASSWORD_HASH = 'a7a746dceab3365727d8dfe6d511dfc5f258480ea1c9eff84a0b2e08bbe9fe5a';
const SESSION_SECONDS = 21600;

const HEADERS = [
  'Fecha y hora','Nombre y apellidos','Curso o grupo','Correo','Categoría','Material',
  'Fecha de uso','Duración','Estado de la reserva','ID solicitud','Disponible desde',
  'Devolver antes de','Indicaciones','Fecha de respuesta','Finalidad didáctica','Token de gestión',
  'Fecha inicio','Tramo inicio','Fecha fin','Tramo fin','Fin de reserva',
  'Recordatorio devolución','Fecha devolución comunicada','Fecha devolución confirmada'
];

const ACTIVE_STATUSES = [
  'Registrada','Pendiente de aceptación','Aceptada','Devolución comunicada'
];

const ALLOWED_SLOTS = [
  '09:00-10:00','10:00-11:00','11:00-11:30','12:00-13:00','13:00-14:00'
];

function doGet(e) {
  try {
    const p = e && e.parameter ? e.parameter : {};
    const action = String(p.action || '');
    if (action === 'availability') {
      return jsonResponse_({result:'success',ok:true,unavailable:getUnavailableMaterials_()});
    }
    if (action === 'manage') {
      return redirectPage_(PORTAL_URL + '?direccion=1&reserva=' + encodeURIComponent(String(p.id || '')));
    }
    return jsonResponse_({result:'success',ok:true,message:'Servicio de reservas activo'});
  } catch (error) {
    return jsonResponse_({result:'error',ok:false,message:errorMessage_(error)});
  }
}

function doPost(e) {
  try {
    const raw = e && e.postData && e.postData.contents ? e.postData.contents : '{}';
    const data = JSON.parse(raw);
    const action = String(data.action || 'submitReservation');

    if (action === 'submitReservation') return submitReservation_(data);
    if (action === 'adminLogin') return adminLogin_(data);
    if (action === 'adminList') return adminList_(data);
    if (action === 'adminDecision') return adminDecision_(data);
    if (action === 'requesterReturn') return requesterReturn_(data);

    return jsonResponse_({result:'error',ok:false,message:'Acción no válida'});
  } catch (error) {
    return jsonResponse_({result:'error',ok:false,message:errorMessage_(error)});
  }
}

function submitReservation_(data) {
  const required = [
    'nombreSolicitante','correoSolicitante','cursoGrupo','categoriaReserva','materialReserva',
    'fechaInicio','fechaFin'
  ];
  const missing = required.filter(function(key){return !String(data[key] || '').trim();});
  if (missing.length) return jsonResponse_({result:'error',ok:false,message:'Faltan datos obligatorios: ' + missing.join(', ')});

  const sameDay = String(data.fechaInicio) === String(data.fechaFin);
  const startSlot = sameDay ? String(data.tramoInicio || '').trim() : '';
  const endSlot = sameDay ? String(data.tramoFin || '').trim() : '';

  if (sameDay && (ALLOWED_SLOTS.indexOf(startSlot) < 0 || ALLOWED_SLOTS.indexOf(endSlot) < 0)) {
    return jsonResponse_({result:'error',ok:false,message:'Para una reserva de un solo día debes seleccionar los tramos horarios.'});
  }

  const startMs = sameDay
    ? slotDateMs_(String(data.fechaInicio), startSlot, false)
    : dayBoundaryMs_(String(data.fechaInicio), false);
  const endMs = sameDay
    ? slotDateMs_(String(data.fechaFin), endSlot, true)
    : dayBoundaryMs_(String(data.fechaFin), true);
  if (!startMs || !endMs || endMs <= startMs) {
    return jsonResponse_({result:'error',ok:false,message:'La finalización debe ser posterior al inicio.'});
  }

  const sheet = getSheet_();
  const headerMap = ensureHeaders_(sheet);
  if (isMaterialUnavailable_(sheet, String(data.materialReserva), headerMap)) {
    return jsonResponse_({result:'error',ok:false,message:'El material ya no está disponible.'});
  }

  const requestId = Utilities.getUuid().split('-')[0].toUpperCase();
  const managementToken = Utilities.getUuid();
  const row = blankRow_();
  set_(row, headerMap, 'Fecha y hora', String(data.timestamp || formatDateTime_(new Date())));
  set_(row, headerMap, 'Nombre y apellidos', String(data.nombreSolicitante).trim());
  set_(row, headerMap, 'Curso o grupo', String(data.cursoGrupo).trim());
  set_(row, headerMap, 'Correo', String(data.correoSolicitante).trim());
  set_(row, headerMap, 'Categoría', String(data.categoriaReserva).trim());
  set_(row, headerMap, 'Material', String(data.materialReserva).trim());
  set_(row, headerMap, 'Fecha de uso', formatLongDateEs_(String(data.fechaInicio)));
  set_(row, headerMap, 'Duración', sameDay
    ? startSlot + ' → ' + endSlot
    : formatLongDateEs_(String(data.fechaInicio)) + ' → ' + formatLongDateEs_(String(data.fechaFin)));
  set_(row, headerMap, 'Estado de la reserva', 'Pendiente de aceptación');
  set_(row, headerMap, 'ID solicitud', requestId);
  set_(row, headerMap, 'Finalidad didáctica', '');
  set_(row, headerMap, 'Token de gestión', managementToken);
  set_(row, headerMap, 'Fecha inicio', dateFromIso_(String(data.fechaInicio)));
  set_(row, headerMap, 'Tramo inicio', startSlot);
  set_(row, headerMap, 'Fecha fin', dateFromIso_(String(data.fechaFin)));
  set_(row, headerMap, 'Tramo fin', endSlot);
  set_(row, headerMap, 'Fin de reserva', endMs);
  sheet.appendRow(row);

  const record = rowToObject_(row, headerMap);
  sendPendingEmailToRequester_(record);
  sendNewRequestEmailToAdmin_(record);

  return jsonResponse_({result:'success',ok:true,requestId:requestId,status:'Pendiente de aceptación'});
}

function adminLogin_(data) {
  const cache = CacheService.getScriptCache();
  const triesKey = 'login-tries';
  const tries = Number(cache.get(triesKey) || 0);
  if (tries >= 12) return jsonResponse_({result:'error',ok:false,message:'Demasiados intentos. Espera unos minutos.'});

  if (hashPassword_(String(data.password || '')) !== ADMIN_PASSWORD_HASH) {
    cache.put(triesKey, String(tries + 1), 600);
    return jsonResponse_({result:'error',ok:false,message:'Contraseña incorrecta.'});
  }

  cache.remove(triesKey);
  const token = Utilities.getUuid() + Utilities.getUuid();
  cache.put('admin-session:' + token, 'ok', SESSION_SECONDS);
  return jsonResponse_({result:'success',ok:true,sessionToken:token,expiresIn:SESSION_SECONDS});
}

function adminList_(data) {
  requireAdmin_(String(data.sessionToken || ''));
  const sheet = getSheet_();
  const headerMap = ensureHeaders_(sheet);
  const rows = getDataRows_(sheet);
  const records = rows.map(function(row, index){
    const obj = rowToObject_(row, headerMap);
    return publicRecord_(obj, index + 2);
  }).filter(function(r){return r.requestId || r.material;}).reverse();
  return jsonResponse_({result:'success',ok:true,records:records});
}

function adminDecision_(data) {
  requireAdmin_(String(data.sessionToken || ''));
  const decision = String(data.decision || '');
  if (['accept','reject','returned'].indexOf(decision) < 0) throw new Error('Decisión no válida.');

  const located = findReservation_(String(data.requestId || ''), '');
  if (!located) throw new Error('No se ha encontrado la reserva.');
  const obj = located.obj;
  const status = String(obj['Estado de la reserva'] || '');

  if (decision === 'accept') {
    if (status !== 'Pendiente de aceptación' && status !== 'Registrada') throw new Error('La solicitud ya ha sido resuelta.');
    writeCell_(located, 'Estado de la reserva', 'Aceptada');
    writeCell_(located, 'Disponible desde', String(data.availableFrom || obj['Fecha inicio'] || obj['Fecha de uso'] || ''));
    writeCell_(located, 'Devolver antes de', String(data.returnBy || obj['Fecha fin'] || ''));
    writeCell_(located, 'Indicaciones', String(data.instructions || ''));
    writeCell_(located, 'Fecha de respuesta', formatDateTime_(new Date()));
    obj['Estado de la reserva'] = 'Aceptada';
    obj['Disponible desde'] = String(data.availableFrom || obj['Fecha inicio'] || obj['Fecha de uso'] || '');
    obj['Devolver antes de'] = String(data.returnBy || obj['Fecha fin'] || '');
    obj['Indicaciones'] = String(data.instructions || '');
    sendAcceptedEmail_(obj);
  }

  if (decision === 'reject') {
    if (status !== 'Pendiente de aceptación' && status !== 'Registrada') throw new Error('La solicitud ya ha sido resuelta.');
    writeCell_(located, 'Estado de la reserva', 'Rechazada');
    writeCell_(located, 'Indicaciones', String(data.instructions || ''));
    writeCell_(located, 'Fecha de respuesta', formatDateTime_(new Date()));
    obj['Estado de la reserva'] = 'Rechazada';
    obj['Indicaciones'] = String(data.instructions || '');
    sendRejectedEmail_(obj);
  }

  if (decision === 'returned') {
    if (status !== 'Aceptada' && status !== 'Devolución comunicada') throw new Error('La reserva no está pendiente de devolución.');
    writeCell_(located, 'Estado de la reserva', 'Devuelta');
    writeCell_(located, 'Fecha devolución confirmada', formatDateTime_(new Date()));
    writeCell_(located, 'Indicaciones', String(data.instructions || obj['Indicaciones'] || ''));
    obj['Estado de la reserva'] = 'Devuelta';
    sendReturnedEmail_(obj);
  }

  return jsonResponse_({result:'success',ok:true,message:'Reserva actualizada.'});
}

function requesterReturn_(data) {
  const located = findReservation_(String(data.requestId || ''), String(data.token || ''));
  if (!located) return jsonResponse_({result:'error',ok:false,message:'El enlace de devolución no es válido.'});
  const obj = located.obj;
  const status = String(obj['Estado de la reserva'] || '');
  if (status === 'Devuelta') return jsonResponse_({result:'success',ok:true,message:'La devolución ya estaba confirmada.'});
  if (status !== 'Aceptada' && status !== 'Devolución comunicada') {
    return jsonResponse_({result:'error',ok:false,message:'Esta reserva no puede marcarse como devuelta.'});
  }
  if (status !== 'Devolución comunicada') {
    writeCell_(located, 'Estado de la reserva', 'Devolución comunicada');
    writeCell_(located, 'Fecha devolución comunicada', formatDateTime_(new Date()));
    obj['Estado de la reserva'] = 'Devolución comunicada';
    sendReturnReportedEmailToAdmin_(obj);
  }
  return jsonResponse_({result:'success',ok:true,message:'Devolución comunicada. Dirección comprobará el material y confirmará el cierre.'});
}

function procesarReservasFinalizadas() {
  const sheet = getSheet_();
  const headerMap = ensureHeaders_(sheet);
  const rows = getDataRows_(sheet);
  const now = Date.now();
  rows.forEach(function(row, index){
    const obj = rowToObject_(row, headerMap);
    if (String(obj['Estado de la reserva']) !== 'Aceptada') return;
    const endMs = Number(obj['Fin de reserva'] || 0);
    if (!endMs || endMs > now || String(obj['Recordatorio devolución'] || '')) return;
    sendDueReminder_(obj);
    sheet.getRange(index + 2, headerMap['Recordatorio devolución'] + 1).setValue(formatDateTime_(new Date()));
  });
}

function instalarAvisosDevolucion() {
  const exists = ScriptApp.getProjectTriggers().some(function(t){
    return t.getHandlerFunction() === 'procesarReservasFinalizadas';
  });
  if (!exists) ScriptApp.newTrigger('procesarReservasFinalizadas').timeBased().everyHours(1).create();
}

function sendPendingEmailToRequester_(r) {
  sendEmail_(r['Correo'], '[Reserva ' + r['ID solicitud'] + '] Solicitud pendiente de aceptación',
    emailLayout_('Solicitud de reserva recibida',
      '<p>Hola, <strong>' + escapeHtml_(r['Nombre y apellidos']) + '</strong>.</p>' +
      '<p>La solicitud está <strong>pendiente de aceptación por Dirección</strong>.</p>' +
      summaryHtml_(r) +
      '<p>Conserva este código: <strong>' + escapeHtml_(r['ID solicitud']) + '</strong>.</p>'));
}

function sendNewRequestEmailToAdmin_(r) {
  const url = PORTAL_URL + '?direccion=1&reserva=' + encodeURIComponent(r['ID solicitud']);
  sendEmail_(ADMIN_EMAIL, '[Reserva ' + r['ID solicitud'] + '] Pendiente: ' + r['Material'],
    emailLayout_('Nueva solicitud de reserva',
      '<p>Se ha recibido una solicitud que necesita aceptación.</p>' + summaryHtml_(r) +
      buttonHtml_(url, 'Abrir gestión de reservas')));
}

function sendAcceptedEmail_(r) {
  const returnUrl = returnUrl_(r);
  sendEmail_(r['Correo'], '[Reserva ' + r['ID solicitud'] + '] Reserva aceptada',
    emailLayout_('Reserva aceptada',
      '<p>Hola, <strong>' + escapeHtml_(r['Nombre y apellidos']) + '</strong>.</p>' +
      summaryHtml_(r) +
      '<p><strong>Disponible desde:</strong> ' + escapeHtml_(r['Disponible desde']) + '<br>' +
      '<strong>Devolver antes de:</strong> ' + escapeHtml_(r['Devolver antes de']) + '</p>' +
      (r['Indicaciones'] ? '<p><strong>Indicaciones:</strong> ' + escapeHtml_(r['Indicaciones']) + '</p>' : '') +
      '<p>Cuando hayas dejado el material en su lugar, pulsa este botón:</p>' +
      buttonHtml_(returnUrl, 'He devuelto el material')));
}

function sendRejectedEmail_(r) {
  sendEmail_(r['Correo'], '[Reserva ' + r['ID solicitud'] + '] Solicitud no aceptada',
    emailLayout_('Solicitud no aceptada',
      '<p>Hola, <strong>' + escapeHtml_(r['Nombre y apellidos']) + '</strong>.</p>' +
      summaryHtml_(r) +
      (r['Indicaciones'] ? '<p><strong>Motivo o indicaciones:</strong> ' + escapeHtml_(r['Indicaciones']) + '</p>' : '')));
}

function sendDueReminder_(r) {
  const url = returnUrl_(r);
  const body = emailLayout_('Recordatorio de devolución',
    '<p>Ha finalizado la reserva del material.</p>' + summaryHtml_(r) +
    '<p>Cuando esté colocado en su lugar, comunica la devolución:</p>' +
    buttonHtml_(url, 'He devuelto el material'));
  sendEmail_(r['Correo'], '[Reserva ' + r['ID solicitud'] + '] Recordatorio de devolución', body);
  sendEmail_(ADMIN_EMAIL, '[Reserva ' + r['ID solicitud'] + '] Ha finalizado el préstamo',
    emailLayout_('Préstamo finalizado', summaryHtml_(r) +
      buttonHtml_(PORTAL_URL + '?direccion=1&reserva=' + encodeURIComponent(r['ID solicitud']), 'Abrir gestión')));
}

function sendReturnReportedEmailToAdmin_(r) {
  sendEmail_(ADMIN_EMAIL, '[Reserva ' + r['ID solicitud'] + '] Devolución comunicada',
    emailLayout_('Devolución pendiente de comprobación',
      '<p>La persona solicitante indica que ha devuelto el material. Compruébalo y confirma la devolución.</p>' +
      summaryHtml_(r) +
      buttonHtml_(PORTAL_URL + '?direccion=1&reserva=' + encodeURIComponent(r['ID solicitud']), 'Comprobar y confirmar devolución')));
}

function sendReturnedEmail_(r) {
  sendEmail_(r['Correo'], '[Reserva ' + r['ID solicitud'] + '] Devolución confirmada',
    emailLayout_('Reserva cerrada',
      '<p>Dirección ha confirmado la devolución del material.</p>' + summaryHtml_(r) +
      '<p>Gracias por dejarlo disponible para el resto del profesorado.</p>'));
}

function getUnavailableMaterials_() {
  const sheet = getSheet_();
  const headerMap = ensureHeaders_(sheet);
  return getDataRows_(sheet).map(function(row){return rowToObject_(row, headerMap);})
    .filter(function(r){return ACTIVE_STATUSES.indexOf(String(r['Estado de la reserva'])) >= 0;})
    .map(function(r){return String(r['Material'] || '').trim();})
    .filter(function(v,i,a){return v && a.indexOf(v) === i;});
}

function isMaterialUnavailable_(sheet, material, headerMap) {
  return getDataRows_(sheet).some(function(row){
    const r = rowToObject_(row, headerMap);
    return String(r['Material']).trim() === material.trim() &&
      ACTIVE_STATUSES.indexOf(String(r['Estado de la reserva'])) >= 0;
  });
}

function getSheet_() {
  const ss = SpreadsheetApp.openById(SPREADSHEET_ID);
  let sheet = ss.getSheetByName(SHEET_NAME);
  if (!sheet) sheet = ss.insertSheet(SHEET_NAME);
  return sheet;
}

function ensureHeaders_(sheet) {
  let current = sheet.getLastColumn() ? sheet.getRange(1,1,1,sheet.getLastColumn()).getValues()[0] : [];
  HEADERS.forEach(function(h){
    if (current.indexOf(h) < 0) {
      current.push(h);
      sheet.getRange(1,current.length).setValue(h);
    }
  });
  sheet.setFrozenRows(1);
  const map = {};
  current.forEach(function(h,i){if(h) map[String(h)] = i;});
  applyDateColumnFormat_(sheet, map, 'Fecha inicio');
  applyDateColumnFormat_(sheet, map, 'Fecha fin');
  normalizeFechaUsoOnce_(sheet, map);
  return map;
}

function getDataRows_(sheet) {
  const lastRow = sheet.getLastRow();
  const lastCol = sheet.getLastColumn();
  return lastRow < 2 ? [] : sheet.getRange(2,1,lastRow-1,lastCol).getValues();
}

function blankRow_() {
  return HEADERS.map(function(){return '';});
}

function set_(row, map, header, value) {
  if (map[header] !== undefined) row[map[header]] = value;
}

function rowToObject_(row, map) {
  const obj = {};
  Object.keys(map).forEach(function(h){obj[h] = row[map[h]];});
  return obj;
}

function publicRecord_(r, rowNumber) {
  const startRaw = r['Fecha inicio'] || r['Fecha de uso'] || '';
  const endRaw = r['Fecha fin'] || startRaw;
  return {
    rowNumber:rowNumber, requestId:String(r['ID solicitud'] || ''), createdAt:displayValue_(r['Fecha y hora']),
    requester:String(r['Nombre y apellidos'] || ''), group:String(r['Curso o grupo'] || ''),
    email:String(r['Correo'] || ''), category:String(r['Categoría'] || ''), material:String(r['Material'] || ''),
    startDate:dateToIso_(startRaw), startDateLabel:formatLongDateEs_(startRaw),
    startSlot:String(r['Tramo inicio'] || ''),
    endDate:dateToIso_(endRaw), endDateLabel:formatLongDateEs_(endRaw),
    endSlot:String(r['Tramo fin'] || ''),
    status:String(r['Estado de la reserva'] || ''), availableFrom:displayValue_(r['Disponible desde']),
    returnBy:displayValue_(r['Devolver antes de']), instructions:String(r['Indicaciones'] || ''),
    responseDate:displayValue_(r['Fecha de respuesta']), returnReported:displayValue_(r['Fecha devolución comunicada']),
    returnConfirmed:displayValue_(r['Fecha devolución confirmada'])
  };
}

function findReservation_(requestId, token) {
  const sheet = getSheet_();
  const map = ensureHeaders_(sheet);
  const rows = getDataRows_(sheet);
  for (let i=0;i<rows.length;i++) {
    const obj = rowToObject_(rows[i], map);
    if (String(obj['ID solicitud']) !== requestId) continue;
    if (token && String(obj['Token de gestión']) !== token) return null;
    return {sheet:sheet,map:map,rowNumber:i+2,row:rows[i],obj:obj};
  }
  return null;
}

function writeCell_(located, header, value) {
  if (located.map[header] === undefined) throw new Error('Falta la columna ' + header);
  located.sheet.getRange(located.rowNumber, located.map[header] + 1).setValue(value);
}

function requireAdmin_(token) {
  if (!token || CacheService.getScriptCache().get('admin-session:' + token) !== 'ok') {
    throw new Error('La sesión de Dirección ha caducado. Vuelve a introducir la contraseña.');
  }
  CacheService.getScriptCache().put('admin-session:' + token, 'ok', SESSION_SECONDS);
}

function hashPassword_(value) {
  const bytes = Utilities.computeDigest(Utilities.DigestAlgorithm.SHA_256, ADMIN_PASSWORD_SALT + value, Utilities.Charset.UTF_8);
  return bytes.map(function(b){const n=(b+256)%256;return ('0'+n.toString(16)).slice(-2);}).join('');
}

function dateFromIso_(value) {
  const iso = dateToIso_(value);
  if (!iso) return '';
  const parts = iso.split('-').map(Number);
  return new Date(parts[0], parts[1] - 1, parts[2], 12, 0, 0, 0);
}

function dateToIso_(value) {
  if (value instanceof Date && !isNaN(value.getTime())) {
    return Utilities.formatDate(value, TIME_ZONE, 'yyyy-MM-dd');
  }
  const text = String(value || '').trim();
  const isoMatch = text.match(/^(\d{4})-(\d{2})-(\d{2})/);
  if (isoMatch) return isoMatch[1] + '-' + isoMatch[2] + '-' + isoMatch[3];
  const esMatch = text.match(/(\d{1,2})\/(\d{1,2})\/(\d{4})/);
  if (esMatch) return esMatch[3] + '-' + ('0' + esMatch[2]).slice(-2) + '-' + ('0' + esMatch[1]).slice(-2);
  const parsed = new Date(text);
  return isNaN(parsed.getTime()) ? '' : Utilities.formatDate(parsed, TIME_ZONE, 'yyyy-MM-dd');
}

function formatLongDateEs_(value) {
  const iso = dateToIso_(value);
  if (!iso) return String(value || '');
  const parts = iso.split('-').map(Number);
  const date = new Date(parts[0], parts[1] - 1, parts[2], 12, 0, 0, 0);
  const days = ['domingo','lunes','martes','miércoles','jueves','viernes','sábado'];
  const months = ['enero','febrero','marzo','abril','mayo','junio','julio','agosto','septiembre','octubre','noviembre','diciembre'];
  return days[date.getDay()] + ', ' + parts[2] + ' de ' + months[parts[1] - 1] + ' de ' + parts[0];
}

function applyDateColumnFormat_(sheet, map, header) {
  if (map[header] === undefined || sheet.getMaxRows() < 2) return;
  sheet.getRange(2, map[header] + 1, sheet.getMaxRows() - 1, 1)
    .setNumberFormat('dddd, d "de" mmmm "de" yyyy');
}

function normalizeFechaUsoOnce_(sheet, map) {
  const propertyKey = 'FECHA_USO_LARGA_V1';
  const props = PropertiesService.getScriptProperties();
  if (props.getProperty(propertyKey) === 'ok' || map['Fecha de uso'] === undefined) return;
  const lastRow = sheet.getLastRow();
  if (lastRow >= 2) {
    const range = sheet.getRange(2, map['Fecha de uso'] + 1, lastRow - 1, 1);
    const values = range.getValues().map(function(row) {
      return [row[0] ? formatLongDateEs_(row[0]) : ''];
    });
    range.setNumberFormat('@');
    range.setValues(values);
  }
  props.setProperty(propertyKey, 'ok');
}

function dayBoundaryMs_(dateText, useEnd) {
  const parts = String(dateText).split('-').map(Number);
  if (parts.length !== 3) return 0;
  return new Date(parts[0], parts[1] - 1, parts[2], useEnd ? 23 : 0, useEnd ? 59 : 0, useEnd ? 59 : 0, 0).getTime();
}

function slotDateMs_(dateText, slot, useEnd) {
  const dateParts = String(dateText).split('-').map(Number);
  const times = String(slot).split('-');
  const time = (useEnd ? times[1] : times[0]).split(':').map(Number);
  if (dateParts.length !== 3 || time.length !== 2) return 0;
  return new Date(dateParts[0],dateParts[1]-1,dateParts[2],time[0],time[1],0,0).getTime();
}

function returnUrl_(r) {
  return PORTAL_URL + '?devolver=' + encodeURIComponent(r['ID solicitud']) +
    '&token=' + encodeURIComponent(r['Token de gestión']);
}

function summaryHtml_(r) {
  const start = formatLongDateEs_(r['Fecha inicio'] || r['Fecha de uso'] || '');
  const end = formatLongDateEs_(r['Fecha fin'] || r['Fecha inicio'] || r['Fecha de uso'] || '');
  const slotStart = String(r['Tramo inicio'] || '');
  const slotEnd = String(r['Tramo fin'] || '');
  return '<table style="border-collapse:collapse;width:100%;max-width:620px">' +
    summaryRow_('Código',r['ID solicitud']) + summaryRow_('Solicitante',r['Nombre y apellidos']) +
    summaryRow_('Curso, grupo o uso',r['Curso o grupo']) + summaryRow_('Material',r['Material']) +
    summaryRow_('Inicio',start + (slotStart ? ' · ' + slotStart : '')) +
    summaryRow_('Final',end + (slotEnd ? ' · ' + slotEnd : '')) + '</table>';
}

function summaryRow_(label,value) {
  return '<tr><th style="text-align:left;border:1px solid #e2e8f0;padding:8px;background:#f8fafc">' +
    escapeHtml_(label) + '</th><td style="border:1px solid #e2e8f0;padding:8px">' +
    escapeHtml_(value) + '</td></tr>';
}

function emailLayout_(title,body) {
  return '<div style="font-family:Arial,sans-serif;color:#172033;max-width:680px;margin:auto">' +
    '<div style="background:#0f766e;color:#fff;padding:16px 20px;font-weight:bold">CEIP Bartolomé Flores · Mojácar</div>' +
    '<div style="padding:20px;border:1px solid #dbe4ea;border-top:0"><h2>' +
    escapeHtml_(title) + '</h2>' + body + '</div></div>';
}

function buttonHtml_(url,label) {
  return '<p style="margin:24px 0"><a href="' + escapeHtml_(url) +
    '" style="background:#0f172a;color:#fff;padding:12px 18px;border-radius:10px;text-decoration:none;font-weight:bold">' +
    escapeHtml_(label) + '</a></p>';
}

function sendEmail_(to,subject,htmlBody) {
  if (!String(to || '').trim()) return;
  MailApp.sendEmail({to:String(to).trim(),subject:subject,htmlBody:htmlBody,name:'CEIP Bartolomé Flores'});
}

function redirectPage_(url) {
  const safe = escapeHtml_(url);
  return HtmlService.createHtmlOutput('<!doctype html><html><head><meta charset="utf-8"><meta http-equiv="refresh" content="0;url=' +
    safe + '"></head><body><p><a target="_top" href="' + safe + '">Abrir gestión de reservas</a></p>' +
    '<script>top.location.href=' + JSON.stringify(url) + ';<\/script></body></html>')
    .setTitle('Gestión de reservas').setXFrameOptionsMode(HtmlService.XFrameOptionsMode.ALLOWALL);
}

function jsonResponse_(obj) {
  return ContentService.createTextOutput(JSON.stringify(obj)).setMimeType(ContentService.MimeType.JSON);
}

function displayValue_(value) {
  return value instanceof Date ? Utilities.formatDate(value,TIME_ZONE,'dd/MM/yyyy HH:mm') : String(value || '');
}

function formatDateTime_(date) {
  return Utilities.formatDate(date,TIME_ZONE,'dd/MM/yyyy HH:mm');
}

function escapeHtml_(value) {
  return String(value == null ? '' : value).replace(/[&<>"']/g,function(ch){
    return {'&':'&amp;','<':'&lt;','>':'&gt;','"':'&quot;',"'":'&#39;'}[ch];
  });
}

function errorMessage_(error) {
  return String(error && error.message ? error.message : error);
}

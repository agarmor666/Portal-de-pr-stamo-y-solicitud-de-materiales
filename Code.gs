const SPREADSHEET_ID = '1WoEWYlYjmSxs4RdmG4d5_r3wMULxTWSt6IuaOwa70I8';
const SHEET_NAME = 'Reservas';
const ADMIN_EMAIL = 'antoniogarrido@bartolomeflores.com';
const TIME_ZONE = 'Europe/Madrid';

const HEADERS = [
  'Fecha y hora',
  'Nombre y apellidos',
  'Curso o grupo',
  'Correo',
  'Categoría',
  'Material',
  'Fecha de uso',
  'Duración',
  'Estado de la reserva',
  'ID solicitud',
  'Disponible desde',
  'Devolver antes de',
  'Indicaciones',
  'Fecha de respuesta',
  'Finalidad didáctica',
  'Token de gestión'
];

const ACTIVE_STATUSES = [
  'Registrada',
  'Pendiente de aceptación',
  'Aceptada'
];

function doGet(e) {
  const action = String((e && e.parameter && e.parameter.action) || '');

  if (action === 'availability') {
    return jsonResponse_({
      result: 'success',
      ok: true,
      unavailable: getUnavailableMaterials_()
    });
  }

  if (action === 'manage') {
    return renderManagementPage_(
      String(e.parameter.id || ''),
      String(e.parameter.token || '')
    );
  }

  return jsonResponse_({
    result: 'success',
    ok: true,
    message: 'Servicio de reservas activo'
  });
}

function doPost(e) {
  try {
    if (e && e.parameter && e.parameter.action === 'manageReservation') {
      return manageReservation_(e.parameter);
    }

    const raw = e && e.postData && e.postData.contents
      ? e.postData.contents
      : '{}';
    const data = JSON.parse(raw);

    if (data.action && data.action !== 'submitReservation') {
      return jsonResponse_({
        result: 'error',
        ok: false,
        message: 'Acción no válida'
      });
    }

    return submitReservation_(data);
  } catch (error) {
    return jsonResponse_({
      result: 'error',
      ok: false,
      message: String(error && error.message ? error.message : error)
    });
  }
}

function submitReservation_(data) {
  const required = [
    'nombreSolicitante',
    'correoSolicitante',
    'cursoGrupo',
    'categoriaReserva',
    'materialReserva',
    'fechaInicio',
    'duracion',
    'finalidad'
  ];

  const missing = required.filter(function(key) {
    return !String(data[key] || '').trim();
  });

  if (missing.length) {
    return jsonResponse_({
      result: 'error',
      ok: false,
      message: 'Faltan datos obligatorios: ' + missing.join(', ')
    });
  }

  const sheet = getSheet_();
  ensureHeaders_(sheet);

  if (isMaterialUnavailable_(sheet, String(data.materialReserva))) {
    return jsonResponse_({
      result: 'error',
      ok: false,
      message: 'El material ya no está disponible.'
    });
  }

  const requestId = Utilities.getUuid().split('-')[0].toUpperCase();
  const managementToken = Utilities.getUuid();
  const createdAt = String(data.timestamp || formatDateTime_(new Date()));
  const status = 'Pendiente de aceptación';

  sheet.appendRow([
    createdAt,
    String(data.nombreSolicitante).trim(),
    String(data.cursoGrupo).trim(),
    String(data.correoSolicitante).trim(),
    String(data.categoriaReserva).trim(),
    String(data.materialReserva).trim(),
    String(data.fechaInicio).trim(),
    String(data.duracion).trim(),
    status,
    requestId,
    '',
    '',
    '',
    '',
    String(data.finalidad).trim(),
    managementToken
  ]);

  sendPendingEmailToRequester_(data, requestId);
  sendNewRequestEmailToAdmin_(data, requestId, managementToken);

  return jsonResponse_({
    result: 'success',
    ok: true,
    requestId: requestId,
    status: status
  });
}

function sendPendingEmailToRequester_(data, requestId) {
  const subject = '[Reserva ' + requestId + '] Solicitud pendiente de aceptación';
  const html = emailLayout_(
    'Solicitud de reserva recibida',
    '<p>Hola, <strong>' + escapeHtml_(data.nombreSolicitante) + '</strong>.</p>' +
    '<p>Tu solicitud ha sido registrada y está <strong>pendiente de aceptación por la dirección del centro</strong>.</p>' +
    reservationSummaryHtml_(data, requestId) +
    '<p>Recibirás otro correo cuando se confirme la reserva. En ese mensaje se indicarán la fecha desde la que puedes recoger el material, la fecha límite de devolución y las instrucciones necesarias.</p>' +
    '<p>Hasta que la solicitud sea resuelta, el material aparecerá como <strong>no disponible</strong> en el portal.</p>'
  );

  sendEmail_(
    String(data.correoSolicitante).trim(),
    subject,
    html
  );
}

function sendNewRequestEmailToAdmin_(data, requestId, managementToken) {
  const managementUrl = getServiceUrl_() +
    '?action=manage&id=' + encodeURIComponent(requestId) +
    '&token=' + encodeURIComponent(managementToken);

  const subject = '[Reserva ' + requestId + '] Pendiente: ' + data.materialReserva;
  const html = emailLayout_(
    'Nueva solicitud de reserva',
    '<p>Se ha recibido una solicitud que necesita aceptación.</p>' +
    reservationSummaryHtml_(data, requestId) +
    '<p><strong>Correo del solicitante:</strong> ' + escapeHtml_(data.correoSolicitante) + '</p>' +
    '<p style="margin:24px 0;"><a href="' + managementUrl + '" style="background:#0f172a;color:#ffffff;padding:12px 18px;border-radius:10px;text-decoration:none;font-weight:bold;">Aceptar, rechazar o marcar devolución</a></p>' +
    '<p>Desde esa pantalla podrás indicar por escrito la fecha de recogida, la fecha límite de devolución y cualquier circunstancia especial. El sistema enviará la respuesta al docente.</p>'
  );

  sendEmail_(ADMIN_EMAIL, subject, html);
}

function renderManagementPage_(requestId, token) {
  const record = findRequest_(requestId, token);

  if (!record) {
    return HtmlService.createHtmlOutput(
      '<h2>Enlace no válido</h2><p>No se ha encontrado la solicitud o el enlace de gestión no es correcto.</p>'
    ).setTitle('Gestión de reserva');
  }

  const status = escapeHtml_(record.values[8] || '');
  const html = '<!doctype html><html lang="es"><head><meta charset="utf-8">' +
    '<meta name="viewport" content="width=device-width,initial-scale=1">' +
    '<title>Gestionar reserva</title><style>' +
    'body{font-family:Arial,sans-serif;background:#f8fafc;color:#0f172a;margin:0;padding:24px}' +
    '.card{max-width:760px;margin:auto;background:#fff;border:1px solid #e2e8f0;border-radius:20px;padding:24px;box-shadow:0 8px 30px rgba(15,23,42,.08)}' +
    'h1{margin-top:0}dl{display:grid;grid-template-columns:180px 1fr;gap:10px;margin:20px 0}dt{font-weight:bold}dd{margin:0}' +
    'label{display:block;font-weight:bold;margin:16px 0 6px}input,textarea{width:100%;box-sizing:border-box;padding:11px;border:1px solid #cbd5e1;border-radius:10px;font:inherit}' +
    '.actions{display:flex;flex-wrap:wrap;gap:10px;margin-top:22px}.btn{border:0;border-radius:10px;padding:12px 16px;font-weight:bold;cursor:pointer}' +
    '.accept{background:#15803d;color:#fff}.reject{background:#b91c1c;color:#fff}.return{background:#1d4ed8;color:#fff}' +
    '.state{display:inline-block;background:#fef3c7;color:#92400e;border-radius:999px;padding:7px 11px;font-weight:bold}' +
    '@media(max-width:600px){dl{grid-template-columns:1fr}dt{margin-top:8px}}' +
    '</style></head><body><main class="card">' +
    '<h1>Gestionar reserva</h1><span class="state">' + status + '</span>' +
    '<dl>' +
    '<dt>ID</dt><dd>' + escapeHtml_(record.values[9]) + '</dd>' +
    '<dt>Solicitante</dt><dd>' + escapeHtml_(record.values[1]) + '</dd>' +
    '<dt>Correo</dt><dd>' + escapeHtml_(record.values[3]) + '</dd>' +
    '<dt>Grupo o uso</dt><dd>' + escapeHtml_(record.values[2]) + '</dd>' +
    '<dt>Material</dt><dd>' + escapeHtml_(record.values[5]) + '</dd>' +
    '<dt>Fecha solicitada</dt><dd>' + escapeHtml_(formatDateForEmail_(record.values[6])) + '</dd>' +
    '<dt>Duración</dt><dd>' + escapeHtml_(record.values[7]) + '</dd>' +
    '<dt>Finalidad</dt><dd>' + escapeHtml_(record.values[14]) + '</dd>' +
    '</dl>' +
    '<form method="post" action="' + getServiceUrl_() + '">' +
    '<input type="hidden" name="action" value="manageReservation">' +
    '<input type="hidden" name="id" value="' + escapeHtml_(requestId) + '">' +
    '<input type="hidden" name="token" value="' + escapeHtml_(token) + '">' +
    '<label for="fechaDesde">Disponible desde</label>' +
    '<input id="fechaDesde" name="fechaDesde" type="date" value="' + escapeHtml_(record.values[10] || '') + '">' +
    '<label for="fechaHasta">Devolver antes de</label>' +
    '<input id="fechaHasta" name="fechaHasta" type="date" value="' + escapeHtml_(record.values[11] || '') + '">' +
    '<label for="indicaciones">Indicaciones para el solicitante</label>' +
    '<textarea id="indicaciones" name="indicaciones" rows="6" placeholder="Lugar de recogida, condiciones de uso, circunstancias especiales…">' + escapeHtml_(record.values[12] || '') + '</textarea>' +
    '<div class="actions">' +
    '<button class="btn accept" type="submit" name="decision" value="accept">Aceptar y enviar correo</button>' +
    '<button class="btn reject" type="submit" name="decision" value="reject">Rechazar y enviar correo</button>' +
    '<button class="btn return" type="submit" name="decision" value="returned">Marcar como devuelto</button>' +
    '</div></form></main></body></html>';

  return HtmlService.createHtmlOutput(html)
    .setTitle('Gestionar reserva ' + requestId)
    .setXFrameOptionsMode(HtmlService.XFrameOptionsMode.ALLOWALL);
}

function manageReservation_(params) {
  const requestId = String(params.id || '');
  const token = String(params.token || '');
  const decision = String(params.decision || '');
  const record = findRequest_(requestId, token);

  if (!record) {
    return HtmlService.createHtmlOutput(
      '<h2>No se pudo gestionar la reserva</h2><p>El enlace no es válido.</p>'
    );
  }

  const values = record.values;
  const requesterEmail = String(values[3] || '');
  const requesterName = String(values[1] || '');
  const material = String(values[5] || '');
  const instructions = String(params.indicaciones || '').trim();
  const responseDate = formatDateTime_(new Date());

  if (decision === 'accept') {
    const fromDate = String(params.fechaDesde || '');
    const returnDate = String(params.fechaHasta || '');

    if (!fromDate || !returnDate) {
      return HtmlService.createHtmlOutput(
        '<h2>Faltan las fechas</h2><p>Para aceptar la reserva debes indicar la fecha de recogida y la fecha límite de devolución.</p>' +
        '<p><a href="' + getManagementUrl_(requestId, token) + '">Volver a la solicitud</a></p>'
      );
    }

    if (returnDate < fromDate) {
      return HtmlService.createHtmlOutput(
        '<h2>Fechas incorrectas</h2><p>La fecha de devolución no puede ser anterior a la fecha de recogida.</p>' +
        '<p><a href="' + getManagementUrl_(requestId, token) + '">Volver a la solicitud</a></p>'
      );
    }

    record.sheet.getRange(record.row, 9, 1, 6).setValues([[
      'Aceptada',
      values[9],
      fromDate,
      returnDate,
      instructions,
      responseDate
    ]]);

    const subject = '[Reserva ' + requestId + '] Solicitud aceptada: ' + material;
    const html = emailLayout_(
      'Reserva aceptada',
      '<p>Hola, <strong>' + escapeHtml_(requesterName) + '</strong>.</p>' +
      '<p>Tu solicitud de <strong>' + escapeHtml_(material) + '</strong> ha sido aceptada.</p>' +
      '<ul>' +
      '<li><strong>Disponible desde:</strong> ' + escapeHtml_(formatDateForEmail_(fromDate)) + '</li>' +
      '<li><strong>Devolver antes de:</strong> ' + escapeHtml_(formatDateForEmail_(returnDate)) + '</li>' +
      '</ul>' +
      (instructions ? '<p><strong>Indicaciones:</strong><br>' + escapeHtml_(instructions).replace(/\n/g, '<br>') + '</p>' : '') +
      '<p>Tras utilizarlo, debes devolver el material a su lugar habitual, en buen estado y dentro del plazo indicado.</p>'
    );
    sendEmail_(requesterEmail, subject, html);
    return managementResultPage_('Reserva aceptada', 'Se ha enviado al solicitante el correo con las fechas y las indicaciones.');
  }

  if (decision === 'reject') {
    if (!instructions) {
      return HtmlService.createHtmlOutput(
        '<h2>Falta la explicación</h2><p>Indica brevemente el motivo o la circunstancia antes de rechazar la solicitud.</p>' +
        '<p><a href="' + getManagementUrl_(requestId, token) + '">Volver a la solicitud</a></p>'
      );
    }

    record.sheet.getRange(record.row, 9).setValue('Rechazada');
    record.sheet.getRange(record.row, 13).setValue(instructions);
    record.sheet.getRange(record.row, 14).setValue(responseDate);

    const subject = '[Reserva ' + requestId + '] Solicitud no aceptada: ' + material;
    const html = emailLayout_(
      'Solicitud de reserva no aceptada',
      '<p>Hola, <strong>' + escapeHtml_(requesterName) + '</strong>.</p>' +
      '<p>En esta ocasión no se ha podido aceptar la solicitud de <strong>' + escapeHtml_(material) + '</strong>.</p>' +
      '<p><strong>Motivo o indicaciones:</strong><br>' + escapeHtml_(instructions).replace(/\n/g, '<br>') + '</p>'
    );
    sendEmail_(requesterEmail, subject, html);
    return managementResultPage_('Solicitud rechazada', 'Se ha informado al solicitante y el material vuelve a mostrarse disponible.');
  }

  if (decision === 'returned') {
    record.sheet.getRange(record.row, 9).setValue('Devuelta');
    record.sheet.getRange(record.row, 14).setValue(responseDate);

    const subject = '[Reserva ' + requestId + '] Material devuelto: ' + material;
    const html = emailLayout_(
      'Devolución registrada',
      '<p>Hola, <strong>' + escapeHtml_(requesterName) + '</strong>.</p>' +
      '<p>Se ha registrado la devolución de <strong>' + escapeHtml_(material) + '</strong>. El material vuelve a aparecer disponible en el portal.</p>'
    );
    sendEmail_(requesterEmail, subject, html);
    return managementResultPage_('Devolución registrada', 'El material vuelve a aparecer disponible en el portal.');
  }

  return HtmlService.createHtmlOutput(
    '<h2>Acción no válida</h2><p>No se ha realizado ningún cambio.</p>'
  );
}

function getUnavailableMaterials_() {
  const sheet = getSheet_();
  ensureHeaders_(sheet);
  const lastRow = sheet.getLastRow();
  if (lastRow < 2) return [];

  const rows = sheet.getRange(2, 1, lastRow - 1, HEADERS.length).getValues();
  const unavailable = {};

  rows.forEach(function(row) {
    const material = String(row[5] || '').trim();
    const status = String(row[8] || '').trim();
    if (material && ACTIVE_STATUSES.indexOf(status) !== -1) {
      unavailable[material] = true;
    }
  });

  return Object.keys(unavailable);
}

function isMaterialUnavailable_(sheet, material) {
  const lastRow = sheet.getLastRow();
  if (lastRow < 2) return false;

  const rows = sheet.getRange(2, 6, lastRow - 1, 4).getValues();
  return rows.some(function(row) {
    return String(row[0] || '').trim() === material &&
      ACTIVE_STATUSES.indexOf(String(row[3] || '').trim()) !== -1;
  });
}

function findRequest_(requestId, token) {
  if (!requestId || !token) return null;

  const sheet = getSheet_();
  ensureHeaders_(sheet);
  const lastRow = sheet.getLastRow();
  if (lastRow < 2) return null;

  const values = sheet.getRange(2, 1, lastRow - 1, HEADERS.length).getValues();
  for (let index = 0; index < values.length; index++) {
    if (String(values[index][9]) === requestId &&
        String(values[index][15]) === token) {
      return {
        sheet: sheet,
        row: index + 2,
        values: values[index]
      };
    }
  }
  return null;
}

function getSheet_() {
  const spreadsheet = SpreadsheetApp.openById(SPREADSHEET_ID);
  let sheet = spreadsheet.getSheetByName(SHEET_NAME);
  if (!sheet) sheet = spreadsheet.insertSheet(SHEET_NAME);
  return sheet;
}

function ensureHeaders_(sheet) {
  const current = sheet.getRange(1, 1, 1, HEADERS.length).getValues()[0];
  const needsWrite = HEADERS.some(function(header, index) {
    return current[index] !== header;
  });

  if (needsWrite) {
    sheet.getRange(1, 1, 1, HEADERS.length).setValues([HEADERS]);
    sheet.setFrozenRows(1);
    sheet.hideColumns(4);
    sheet.hideColumns(16);
  }
}

function sendEmail_(to, subject, htmlBody) {
  MailApp.sendEmail({
    to: to,
    subject: subject,
    body: htmlToText_(htmlBody),
    htmlBody: htmlBody,
    name: 'CEIP Bartolomé Flores',
    replyTo: ADMIN_EMAIL
  });
}

function reservationSummaryHtml_(data, requestId) {
  return '<table style="border-collapse:collapse;width:100%;max-width:640px">' +
    emailRow_('ID de solicitud', requestId) +
    emailRow_('Solicitante', data.nombreSolicitante) +
    emailRow_('Curso, grupo o uso', data.cursoGrupo) +
    emailRow_('Categoría', data.categoriaReserva) +
    emailRow_('Material', data.materialReserva) +
    emailRow_('Fecha solicitada', formatDateForEmail_(data.fechaInicio)) +
    emailRow_('Duración prevista', data.duracion) +
    emailRow_('Finalidad didáctica', data.finalidad) +
    '</table>';
}

function emailRow_(label, value) {
  return '<tr><th style="text-align:left;vertical-align:top;padding:8px;border:1px solid #e2e8f0;background:#f8fafc">' +
    escapeHtml_(label) +
    '</th><td style="padding:8px;border:1px solid #e2e8f0">' +
    escapeHtml_(value) +
    '</td></tr>';
}

function emailLayout_(title, body) {
  return '<div style="font-family:Arial,sans-serif;color:#0f172a;line-height:1.55;max-width:720px">' +
    '<div style="background:#0f766e;color:#fff;padding:18px 22px;border-radius:14px 14px 0 0">' +
    '<strong>CEIP Bartolomé Flores · Mojácar</strong></div>' +
    '<div style="border:1px solid #dbeafe;border-top:0;padding:22px;border-radius:0 0 14px 14px">' +
    '<h2 style="margin-top:0">' + escapeHtml_(title) + '</h2>' +
    body +
    '<p style="margin-top:24px;color:#64748b;font-size:13px">Este mensaje ha sido generado por el portal interno de reservas del centro.</p>' +
    '</div></div>';
}

function managementResultPage_(title, message) {
  return HtmlService.createHtmlOutput(
    '<!doctype html><html lang="es"><head><meta charset="utf-8"><meta name="viewport" content="width=device-width,initial-scale=1">' +
    '<title>' + escapeHtml_(title) + '</title><style>body{font-family:Arial,sans-serif;background:#f8fafc;padding:28px;color:#0f172a}.card{max-width:620px;margin:auto;background:#fff;border:1px solid #e2e8f0;border-radius:18px;padding:26px}a{color:#0f766e}</style></head>' +
    '<body><main class="card"><h1>' + escapeHtml_(title) + '</h1><p>' + escapeHtml_(message) + '</p><p>Ya puedes cerrar esta ventana.</p></main></body></html>'
  ).setTitle(title);
}

function getManagementUrl_(requestId, token) {
  return getServiceUrl_() +
    '?action=manage&id=' + encodeURIComponent(requestId) +
    '&token=' + encodeURIComponent(token);
}

function getServiceUrl_() {
  return ScriptApp.getService().getUrl();
}

function formatDateTime_(date) {
  return Utilities.formatDate(date, TIME_ZONE, 'dd/MM/yyyy HH:mm');
}

function formatDateForEmail_(value) {
  if (!value) return '';
  if (Object.prototype.toString.call(value) === '[object Date]') {
    return Utilities.formatDate(value, TIME_ZONE, 'dd/MM/yyyy');
  }

  const text = String(value);
  const match = text.match(/^(\d{4})-(\d{2})-(\d{2})$/);
  return match ? match[3] + '/' + match[2] + '/' + match[1] : text;
}

function escapeHtml_(value) {
  return String(value == null ? '' : value)
    .replace(/&/g, '&amp;')
    .replace(/</g, '&lt;')
    .replace(/>/g, '&gt;')
    .replace(/"/g, '&quot;')
    .replace(/'/g, '&#39;');
}

function htmlToText_(html) {
  return String(html)
    .replace(/<br\s*\/?>/gi, '\n')
    .replace(/<\/p>/gi, '\n\n')
    .replace(/<\/li>/gi, '\n')
    .replace(/<[^>]+>/g, '')
    .replace(/&nbsp;/g, ' ')
    .replace(/&amp;/g, '&')
    .replace(/&lt;/g, '<')
    .replace(/&gt;/g, '>')
    .replace(/&quot;/g, '"')
    .replace(/&#39;/g, "'");
}

function jsonResponse_(obj) {
  return ContentService
    .createTextOutput(JSON.stringify(obj))
    .setMimeType(ContentService.MimeType.JSON);
}

function sanitizeText(value) {
  if (typeof value !== 'string') return value;
  return value
    .replace(/[\u2013\u2014]/g, ',')
    .replace(/\s*--\s*/g, ', ')
    .replace(/\s+,/g, ',')
    .replace(/,{2,}/g, ',')
    .replace(/,\s*,/g, ', ')
    .trim();
}

function sanitizeObject(value) {
  if (typeof value === 'string') return sanitizeText(value);
  if (Array.isArray(value)) return value.map(sanitizeObject);
  if (value && typeof value === 'object') {
    return Object.fromEntries(Object.entries(value).map(([key, item]) => [key, sanitizeObject(item)]));
  }
  return value;
}

module.exports = { sanitizeText, sanitizeObject };

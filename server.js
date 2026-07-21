import http from 'node:http';
import https from 'node:https';
import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import crypto from 'node:crypto';
import { google } from 'googleapis';
import yauzl from 'yauzl';
import xml2js from 'xml2js';
import { Readable } from 'stream';

const __filename = fileURLToPath(import.meta.url);
const __dirname = path.dirname(__filename);

// ---------------------------------------------------------------------------
// Configuration
// ---------------------------------------------------------------------------
const PORT = parseInt(process.env.PORT || '8080', 10);
const BASE_URL = process.env.BASE_URL || `http://localhost:${PORT}`;
const GOOGLE_CLIENT_ID = process.env.GOOGLE_CLIENT_ID || '';
const GOOGLE_CLIENT_SECRET = process.env.GOOGLE_CLIENT_SECRET || '';
const ALLOWED_DOMAIN = process.env.ALLOWED_DOMAIN || 'example.com';
const SESSION_SECRET = process.env.SESSION_SECRET || crypto.randomBytes(32).toString('hex');

const OAUTH_REDIRECT_URI = `${BASE_URL}/oauth2/callback`;
const OAUTH_AUTH_URL = 'https://accounts.google.com/o/oauth2/v2/auth';
const OAUTH_TOKEN_URL = 'https://oauth2.googleapis.com/token';
const OAUTH_USERINFO_URL = 'https://www.googleapis.com/oauth2/v3/userinfo';
const OAUTH_SCOPES = 'openid email profile';
const SESSION_COOKIE_NAME = 'svc_session';
const SESSION_TTL_MS = 8 * 60 * 60 * 1000; // 8 hours

// Google Drive configuration
const DRIVE_FOLDER_ID = '1X7xX-jWWgQ0tGYeXKPPvVe0jXzbv74AM';
const DRIVE_SCOPES = ['https://www.googleapis.com/auth/drive.readonly'];

// ---------------------------------------------------------------------------
// In-memory session store
// ---------------------------------------------------------------------------
/** @type {Map<string, { user: object, expires: number }>} */
const sessions = new Map();

function createSession(user) {
  const id = crypto.randomBytes(32).toString('hex');
  sessions.set(id, { user, expires: Date.now() + SESSION_TTL_MS });
  return id;
}

function getSession(id) {
  const sess = sessions.get(id);
  if (!sess) return null;
  if (sess.expires < Date.now()) {
    sessions.delete(id);
    return null;
  }
  return sess;
}

function deleteSession(id) {
  sessions.delete(id);
}

// ---------------------------------------------------------------------------
// OAuth state anti-forgery tokens
// ---------------------------------------------------------------------------
const oauthStates = new Map(); // state -> expiry

function createOAuthState() {
  const state = crypto.randomBytes(16).toString('hex');
  oauthStates.set(state, Date.now() + 5 * 60 * 1000); // 5-min expiry
  return state;
}

function validateOAuthState(state) {
  const expiry = oauthStates.get(state);
  oauthStates.delete(state);
  return expiry && expiry > Date.now();
}

// ---------------------------------------------------------------------------
// Google Drive API helpers
// ---------------------------------------------------------------------------
let driveAuth = null;

async function getDriveAuth() {
  if (driveAuth) return driveAuth;

  try {
    console.log('Initializing Google Drive auth with scopes:', DRIVE_SCOPES);

    // Use Application Default Credentials (ADC) in Cloud Run
    driveAuth = new google.auth.GoogleAuth({
      scopes: DRIVE_SCOPES,
    });

    // Test the auth by getting credentials
    const authClient = await driveAuth.getClient();
    console.log('Google Drive auth initialized successfully');

    return driveAuth;
  } catch (error) {
    console.error('Failed to initialize Google Drive auth:', error.message);
    console.error('Error details:', error);
    throw new Error(`Drive auth failed: ${error.message}`);
  }
}

async function getDriveService() {
  const auth = await getDriveAuth();
  const authClient = await auth.getClient();
  return google.drive({ version: 'v3', auth: authClient });
}

// Customer data cache
let customerDataCache = null;
let lastCacheUpdate = 0;
const CACHE_TTL = 5 * 60 * 1000; // 5 minutes

async function getCustomerDataFromDrive() {
  const now = Date.now();
  if (customerDataCache && (now - lastCacheUpdate) < CACHE_TTL) {
    console.log('Returning cached customer data');
    return customerDataCache;
  }

  try {
    console.log(`Fetching customer data from Drive folder: ${DRIVE_FOLDER_ID}`);
    const drive = await getDriveService();

    // First, let's test if we can access the folder
    try {
      const folderTest = await drive.files.get({
        fileId: DRIVE_FOLDER_ID,
        fields: 'id, name, permissions'
      });
      console.log('Successfully accessed Drive folder:', folderTest.data.name);
    } catch (folderError) {
      console.error('Cannot access Drive folder:', folderError.message);
      if (folderError.code === 403) {
        throw new Error('Access denied to Drive folder. Check service account permissions.');
      }
      throw new Error(`Drive folder access failed: ${folderError.message}`);
    }

    // List all PowerPoint files in the folder
    console.log('Listing files in Drive folder...');
    const filesResponse = await drive.files.list({
      q: `'${DRIVE_FOLDER_ID}' in parents and (mimeType='application/vnd.ms-powerpoint' or mimeType='application/vnd.openxmlformats-officedocument.presentationml.presentation')`,
      fields: 'files(id, name, createdTime, modifiedTime)',
      orderBy: 'createdTime desc'
    });

    const files = filesResponse.data.files || [];
    console.log(`Found ${files.length} PowerPoint files in Drive folder`);

    const customerData = {};

    // Process each PowerPoint file
    for (const file of files) {
      try {
        console.log(`Processing file: ${file.name}`);

        // Extract date/week info from filename - improved detection
        let week = 'Unknown';

        // Try to match various week patterns
        const weekMatches = [
          file.name.match(/Week\s*(\d+)/i),
          file.name.match(/W(\d+)/i),
          file.name.match(/week(\d+)/i),
          file.name.match(/(\d+).*week/i)
        ].find(match => match);

        if (weekMatches) {
          week = `Week ${weekMatches[1]}`;
        } else {
          // Try date patterns and convert to relative week
          const dateMatch = file.name.match(/(\d{4}[-\/]\d{1,2}[-\/]\d{1,2})|(\d{1,2}[-\/]\d{1,2}[-\/]\d{2,4})/);
          if (dateMatch) {
            week = `Date: ${dateMatch[0]}`;
          } else {
            // Use creation order as fallback (newest = current week)
            const fileIndex = files.findIndex(f => f.id === file.id);
            week = `File ${files.length - fileIndex}`;
          }
        }

        // Extract slides from PowerPoint
        console.log(`Extracting slides from ${file.name}...`);
        const slides = await extractSlidesFromPowerPoint(drive, file.id, file.name);

        const customerInfo = {
          fileId: file.id,
          fileName: file.name,
          createdTime: file.createdTime,
          modifiedTime: file.modifiedTime,
          week: week,
          slides: slides,
          totalSlides: slides.length,
          details: await getFileMetadata(drive, file)
        };

        // Try to extract customer names from filename or you could map based on patterns
        const customers = extractCustomerNamesFromFileName(file.name);
        console.log(`File ${file.name} mapped to customers:`, customers);

        customers.forEach(customer => {
          if (!customerData[customer]) {
            customerData[customer] = [];
          }
          customerData[customer].push(customerInfo);
        });

      } catch (error) {
        console.warn(`Error processing file ${file.name}:`, error.message);
      }
    }

    console.log('Customer data processed successfully:', Object.keys(customerData));
    customerDataCache = customerData;
    lastCacheUpdate = now;
    return customerData;

  } catch (error) {
    console.error('Error fetching customer data from Drive:', error.message);
    console.error('Full error:', error);
    throw error;
  }
}

async function getFileMetadata(drive, file) {
  try {
    const response = await drive.files.get({
      fileId: file.id,
      fields: 'description, properties, webViewLink, createdTime, modifiedTime'
    });

    // Generate a more informative description for weekly PPT files
    const baseDescription = response.data.description || '';
    const createdDate = new Date(file.createdTime).toLocaleDateString();
    const modifiedDate = new Date(file.modifiedTime).toLocaleDateString();

    let enhancedDescription = baseDescription;
    if (!baseDescription || baseDescription.trim().length === 0) {
      enhancedDescription = `Weekly customer presentation data from ${createdDate}. ` +
                           `This PowerPoint contains detailed information about customer activities, ` +
                           `progress updates, and key metrics for the week.`;
    }

    return {
      description: enhancedDescription,
      webViewLink: response.data.webViewLink || '#',
      properties: response.data.properties || {},
      fileType: 'PowerPoint Presentation',
      lastModified: modifiedDate,
      created: createdDate
    };
  } catch (error) {
    console.warn(`Could not get metadata for ${file.name}:`, error.message);

    // Provide meaningful fallback for weekly PPT files
    const createdDate = new Date(file.createdTime).toLocaleDateString();
    return {
      description: `Weekly customer data presentation (${createdDate}). Contains customer activity summaries, progress updates, and key performance indicators.`,
      webViewLink: '#',
      properties: {},
      fileType: 'PowerPoint Presentation',
      lastModified: new Date(file.modifiedTime).toLocaleDateString(),
      created: createdDate,
      note: 'Metadata retrieved from file properties'
    };
  }
}

// PowerPoint slide extraction functions
async function extractSlidesFromPowerPoint(drive, fileId, fileName) {
  try {
    console.log(`Extracting slides from PowerPoint: ${fileName}`);

    // Method 1: Try to get slide thumbnails directly from Google Drive
    const slideImages = await getSlideImagesFromDrive(drive, fileId, fileName);
    if (slideImages.length > 0) {
      console.log(`Extracted ${slideImages.length} slide images from ${fileName} via Drive API`);
      return slideImages;
    }

    // Method 2: Fallback to text extraction for slide identification
    console.log(`Falling back to text extraction for ${fileName}`);
    const fileBuffer = await downloadFileFromDrive(drive, fileId);
    const slides = await parsePowerPointSlides(fileBuffer);

    console.log(`Extracted ${slides.length} slides from ${fileName}`);
    return slides;

  } catch (error) {
    console.error(`Error extracting slides from ${fileName}:`, error.message);
    return [];
  }
}

async function getSlideImagesFromDrive(drive, fileId, fileName) {
  try {
    console.log(`Getting slide images from Drive for: ${fileName}`);

    // First, convert the PowerPoint to Google Slides format to get slide thumbnails
    // This is a workaround since Drive API doesn't directly export PPT slide thumbnails

    // Try to export as PDF first, then we can convert PDF pages to images
    const pdfBuffer = await exportPowerPointAsPDF(drive, fileId);

    if (pdfBuffer) {
      // For now, we'll return a single image representing the presentation
      // In a full implementation, you'd use a PDF-to-image library to extract individual pages
      return [{
        slideNumber: 1,
        fileName: `${fileName}_preview`,
        imageData: pdfBuffer,
        format: 'pdf',
        textContent: ['PowerPoint presentation'],
        isPreview: true
      }];
    }

    return [];
  } catch (error) {
    console.warn(`Could not get slide images for ${fileName}:`, error.message);
    return [];
  }
}

async function exportPowerPointAsPDF(drive, fileId) {
  try {
    // Try to export the PowerPoint file as PDF
    const response = await drive.files.export({
      fileId: fileId,
      mimeType: 'application/pdf'
    }, { responseType: 'stream' });

    return new Promise((resolve, reject) => {
      const chunks = [];

      response.data.on('data', chunk => chunks.push(chunk));
      response.data.on('end', () => {
        const buffer = Buffer.concat(chunks);
        resolve(buffer);
      });
      response.data.on('error', reject);
    });

  } catch (error) {
    console.warn(`Could not export PowerPoint as PDF:`, error.message);
    return null;
  }
}

async function downloadFileFromDrive(drive, fileId) {
  return new Promise((resolve, reject) => {
    const chunks = [];

    drive.files.get({
      fileId: fileId,
      alt: 'media'
    }, { responseType: 'stream' }, (err, response) => {
      if (err) {
        reject(err);
        return;
      }

      response.data.on('data', chunk => chunks.push(chunk));
      response.data.on('end', () => {
        const buffer = Buffer.concat(chunks);
        resolve(buffer);
      });
      response.data.on('error', reject);
    });
  });
}

async function parsePowerPointSlides(buffer) {
  return new Promise((resolve, reject) => {
    const slides = [];

    yauzl.fromBuffer(buffer, { lazyEntries: true }, (err, zipfile) => {
      if (err) {
        reject(err);
        return;
      }

      const slideFiles = [];
      const slideRelFiles = [];

      zipfile.readEntry();
      zipfile.on('entry', (entry) => {
        // Look for slide files
        if (entry.fileName.match(/^ppt\/slides\/slide\d+\.xml$/)) {
          slideFiles.push(entry);
        }
        zipfile.readEntry();
      });

      zipfile.on('end', async () => {
        try {
          // Process each slide file
          for (const slideEntry of slideFiles) {
            const slideContent = await extractSlideContent(zipfile, slideEntry);
            if (slideContent) {
              slides.push(slideContent);
            }
          }

          resolve(slides);
        } catch (error) {
          reject(error);
        }
      });

      zipfile.on('error', reject);
    });
  });
}

async function extractSlideContent(zipfile, entry) {
  return new Promise((resolve, reject) => {
    zipfile.openReadStream(entry, (err, readStream) => {
      if (err) {
        reject(err);
        return;
      }

      let xmlContent = '';
      readStream.on('data', chunk => {
        xmlContent += chunk.toString();
      });

      readStream.on('end', async () => {
        try {
          // Parse XML to extract text content
          const parser = new xml2js.Parser();
          const result = await parser.parseStringPromise(xmlContent);

          const slideNumber = entry.fileName.match(/slide(\d+)\.xml/)[1];
          const extractedText = extractTextFromSlideXML(result);

          resolve({
            slideNumber: parseInt(slideNumber),
            fileName: entry.fileName,
            textContent: extractedText.allText,
            title: extractedText.title,
            possibleTitles: extractedText.possibleTitles,
            hasTitle: !!extractedText.title,
            rawXml: xmlContent
          });
        } catch (error) {
          console.warn(`Error parsing slide ${entry.fileName}:`, error.message);
          resolve(null);
        }
      });

      readStream.on('error', reject);
    });
  });
}

function extractTextFromSlideXML(xmlObject) {
  const allTextElements = [];
  const structuredContent = {
    title: null,
    sections: [],
    tables: [],
    bulletPoints: []
  };

  function extractText(obj, context = '') {
    if (typeof obj === 'string') {
      const text = obj.trim();
      if (text.length > 0) {
        allTextElements.push({ text, context });
        return text;
      }
    } else if (Array.isArray(obj)) {
      return obj.map(item => extractText(item, context)).filter(Boolean);
    } else if (obj && typeof obj === 'object') {
      const results = [];
      for (const [key, value] of Object.entries(obj)) {
        const newContext = key.includes('tbl') ? 'table' :
                          key.includes('title') ? 'title' :
                          key.includes('body') ? 'body' : context;
        const result = extractText(value, newContext);
        if (result) results.push(result);
      }
      return results.flat();
    }
    return null;
  }

  // Extract all text from the slide
  if (xmlObject['p:sld'] && xmlObject['p:sld']['p:cSld']) {
    extractText(xmlObject['p:sld']['p:cSld']);
  }

  // Clean and organize the extracted text
  const cleanText = allTextElements
    .map(item => item.text)
    .filter(text => {
      // More lenient filtering to keep all meaningful content
      if (text.length < 2) return false;

      // Skip obvious formatting strings
      const formatStrings = ['Arial', 'Calibri', 'none', 'noStrike', 'solid', 'flat', 'ctr', 'en-US', 'dk1', 'sm', 'sng'];
      if (formatStrings.some(format => text.includes(format))) return false;

      // Skip colors and pure numbers
      if (text.match(/^[0-9A-F]{6}$/i) || text.match(/^[0-9]+$/)) return false;

      // Skip URLs and technical identifiers
      if (text.includes('http') || text.includes('schemas.openxml') || text.includes('Google.Shape')) return false;

      // Skip common XML artifacts
      const xmlArtifacts = ['b', 'flat', 'sng', '9525', '45700', '000000', '1000', 'EFEFEF'];
      if (xmlArtifacts.includes(text)) return false;

      return true;
    })
    .filter((text, index, arr) => arr.indexOf(text) === index); // Remove duplicates

  // Organize content
  const organizedContent = organizeSlideContent(cleanText);

  return {
    allText: cleanText,
    structured: organizedContent,
    rawCount: allTextElements.length,
    cleanCount: cleanText.length
  };
}

function organizeSlideContent(textArray) {
  const content = {
    title: null,
    sections: [],
    keyInfo: [],
    metrics: [],
    activities: [],
    other: []
  };

  textArray.forEach((text, index) => {
    // First meaningful text is likely the title
    if (!content.title && text.length > 3 && !text.match(/^[0-9\s\-\.\|]+$/)) {
      content.title = text;
      return;
    }

    // Categorize content based on keywords and patterns
    const lowerText = text.toLowerCase();

    if (lowerText.includes('customer') || lowerText.includes('status') || lowerText.includes('sentiment')) {
      content.keyInfo.push(text);
    } else if (lowerText.match(/\d+/) && (lowerText.includes('ticket') || lowerText.includes('license') || lowerText.includes('sow'))) {
      content.metrics.push(text);
    } else if (lowerText.includes('activity') || lowerText.includes('project') || lowerText.includes('demo') || lowerText.includes('meeting')) {
      content.activities.push(text);
    } else if (text.length > 5) {
      content.other.push(text);
    }
  });

  return content;
}

function findCustomerSlide(slides, customerName) {
  console.log(`Looking for slide with title matching customer: ${customerName}`);

  const customerPatterns = {
    'AbbVie': ['abbvie', 'abb vie', 'abv'],
    'Alcon': ['alcon'],
    'Ascendis': ['ascendis', 'ascend'],
    'BMS': ['bms', 'bristol', 'myers', 'bristol-myers', 'bristol myers squibb'],
    'Otsuka': ['otsuka', 'otsu'],
    'PMI': ['pmi', 'philip morris'],
    'Zealand': ['zealand', 'zeal']
  };

  const patterns = customerPatterns[customerName] || [customerName.toLowerCase()];

  // First priority: Look for slides where the title exactly matches the customer name
  for (const slide of slides) {
    if (slide.title) {
      const titleLower = slide.title.toLowerCase().trim();

      // Check if the title is exactly or closely matches the customer name
      const isExactMatch = patterns.some(pattern => {
        return titleLower === pattern.toLowerCase() ||
               titleLower.includes(pattern.toLowerCase()) && titleLower.length < pattern.length + 10;
      });

      if (isExactMatch) {
        console.log(`Found customer ${customerName} in slide ${slide.slideNumber} with title: "${slide.title}"`);
        return {
          ...slide,
          customerName,
          matchedPattern: slide.title,
          matchType: 'title'
        };
      }
    }
  }

  // Second priority: Look in possible titles
  for (const slide of slides) {
    for (const possibleTitle of slide.possibleTitles || []) {
      const titleLower = possibleTitle.toLowerCase().trim();

      const isMatch = patterns.some(pattern =>
        titleLower === pattern.toLowerCase() ||
        (titleLower.includes(pattern.toLowerCase()) && titleLower.length < pattern.length + 10)
      );

      if (isMatch) {
        console.log(`Found customer ${customerName} in slide ${slide.slideNumber} with possible title: "${possibleTitle}"`);
        return {
          ...slide,
          customerName,
          matchedPattern: possibleTitle,
          matchType: 'possibleTitle'
        };
      }
    }
  }

  // Third priority: Look in all slide content (fallback)
  for (const slide of slides) {
    const slideText = slide.textContent.join(' ').toLowerCase();

    const hasCustomerName = patterns.some(pattern =>
      slideText.includes(pattern.toLowerCase())
    );

    if (hasCustomerName) {
      console.log(`Found customer ${customerName} in slide ${slide.slideNumber} content`);
      return {
        ...slide,
        customerName,
        matchedPattern: patterns.find(p => slideText.includes(p.toLowerCase())),
        matchType: 'content'
      };
    }
  }

  console.log(`No slide found for customer ${customerName}`);
  return null;
}

function extractCustomerNamesFromFileName(fileName) {
  // List of known customers - you can expand this based on your needs
  const knownCustomers = ['AbbVie', 'Alcon', 'Ascendis', 'BMS', 'Otsuka', 'PMI', 'Zealand'];

  const foundCustomers = [];
  const lowerFileName = fileName.toLowerCase();

  // More comprehensive customer name matching
  const customerPatterns = {
    'AbbVie': ['abbvie', 'abb vie', 'abv'],
    'Alcon': ['alcon'],
    'Ascendis': ['ascendis', 'ascend'],
    'BMS': ['bms', 'bristol', 'myers', 'bristol-myers', 'bristol myers squibb'],
    'Otsuka': ['otsuka', 'otsu'],
    'PMI': ['pmi', 'philip morris'],
    'Zealand': ['zealand', 'zeal']
  };

  // Check each customer against their patterns
  Object.entries(customerPatterns).forEach(([customer, patterns]) => {
    const isFound = patterns.some(pattern => lowerFileName.includes(pattern));
    if (isFound) {
      foundCustomers.push(customer);
    }
  });

  // If no specific customers found, assume it's a weekly summary file containing all customers
  // This makes sense for your 4 weekly PPT structure
  if (foundCustomers.length === 0) {
    console.log(`No specific customers found in filename "${fileName}", assuming it contains all customers`);
    return knownCustomers;
  }

  console.log(`Found customers [${foundCustomers.join(', ')}] in filename "${fileName}"`);
  return foundCustomers;
}

// ---------------------------------------------------------------------------
// Cookie helpers
// ---------------------------------------------------------------------------
function parseCookies(req) {
  const raw = req.headers.cookie || '';
  return Object.fromEntries(
    raw.split(';').map(p => {
      const [k, ...v] = p.trim().split('=');
      return [k, decodeURIComponent(v.join('='))];
    }).filter(([k]) => k)
  );
}

function setSessionCookie(res, sessionId) {
  const maxAge = Math.floor(SESSION_TTL_MS / 1000);
  res.setHeader('Set-Cookie', [
    `${SESSION_COOKIE_NAME}=${sessionId}; HttpOnly; SameSite=Lax; Max-Age=${maxAge}; Path=/`
  ]);
}

function clearSessionCookie(res) {
  res.setHeader('Set-Cookie', [
    `${SESSION_COOKIE_NAME}=; HttpOnly; SameSite=Lax; Max-Age=0; Path=/`
  ]);
}

// ---------------------------------------------------------------------------
// Resolve the session from an incoming request
// ---------------------------------------------------------------------------
function resolveUser(req) {
  const cookies = parseCookies(req);
  const sessionId = cookies[SESSION_COOKIE_NAME];
  if (!sessionId) return null;
  const sess = getSession(sessionId);
  return sess ? { sessionId, user: sess.user } : null;
}

// ---------------------------------------------------------------------------
// HTTPS helper — make a JSON request using native https
// ---------------------------------------------------------------------------
function httpsRequest(options, body) {
  return new Promise((resolve, reject) => {
    const req = https.request(options, (res) => {
      let data = '';
      res.on('data', chunk => { data += chunk; });
      res.on('end', () => {
        try {
          resolve({ status: res.statusCode, body: JSON.parse(data) });
        } catch {
          resolve({ status: res.statusCode, body: data });
        }
      });
    });
    req.on('error', reject);
    if (body) req.write(body);
    req.end();
  });
}

// ---------------------------------------------------------------------------
// Static file MIME types
// ---------------------------------------------------------------------------
const MIME_TYPES = {
  '.html': 'text/html; charset=utf-8',
  '.js':   'application/javascript; charset=utf-8',
  '.css':  'text/css; charset=utf-8',
  '.json': 'application/json; charset=utf-8',
  '.png':  'image/png',
  '.jpg':  'image/jpeg',
  '.jpeg': 'image/jpeg',
  '.svg':  'image/svg+xml',
  '.ico':  'image/x-icon',
  '.txt':  'text/plain; charset=utf-8',
  '.md':   'text/plain; charset=utf-8',
  '.woff': 'font/woff',
  '.woff2': 'font/woff2',
};

function getMime(filePath) {
  return MIME_TYPES[path.extname(filePath).toLowerCase()] || 'application/octet-stream';
}

// ---------------------------------------------------------------------------
// Response helpers
// ---------------------------------------------------------------------------
function sendJSON(res, status, data) {
  const body = JSON.stringify(data);
  res.writeHead(status, {
    'Content-Type': 'application/json; charset=utf-8',
    'Content-Length': Buffer.byteLength(body),
  });
  res.end(body);
}

function sendText(res, status, text, contentType = 'text/plain; charset=utf-8') {
  res.writeHead(status, {
    'Content-Type': contentType,
    'Content-Length': Buffer.byteLength(text),
  });
  res.end(text);
}

function sendRedirect(res, location) {
  res.writeHead(302, { Location: location });
  res.end();
}

function sendFile(res, filePath) {
  try {
    const stat = fs.statSync(filePath);
    const mime = getMime(filePath);
    res.writeHead(200, {
      'Content-Type': mime,
      'Content-Length': stat.size,
    });
    fs.createReadStream(filePath).pipe(res);
  } catch {
    sendJSON(res, 404, { error: 'Not found' });
  }
}

// ---------------------------------------------------------------------------
// Load config
// ---------------------------------------------------------------------------
let config = { staff: [], allowedDomain: ALLOWED_DOMAIN };
try {
  const raw = fs.readFileSync(path.join(__dirname, 'data', 'services.json'), 'utf-8');
  const parsed = JSON.parse(raw);
  config = { ...parsed, allowedDomain: ALLOWED_DOMAIN }; // env var always wins
} catch (e) {
  console.warn('Could not load data/services.json, using defaults:', e.message);
}

// ---------------------------------------------------------------------------
// Mock cases data
// ---------------------------------------------------------------------------
const MOCK_CASES = [
  { id: 'SVC-001', title: 'Network switch offline in Building A', status: 'Open', assignedTo: 'Jordan Lee', priority: 'P1', date: '2026-07-08' },
  { id: 'SVC-002', title: 'Printer queue stuck on Floor 3', status: 'In Progress', assignedTo: 'Sam Patel', priority: 'P3', date: '2026-07-07' },
  { id: 'SVC-003', title: 'VPN access request for new contractor', status: 'Resolved', assignedTo: 'Jordan Lee', priority: 'P4', date: '2026-07-06' },
  { id: 'SVC-004', title: 'Email delivery delays for ops team', status: 'Open', assignedTo: 'Alex Rivera', priority: 'P2', date: '2026-07-08' },
  { id: 'SVC-005', title: 'Conference room AV system broken', status: 'In Progress', assignedTo: 'Sam Patel', priority: 'P3', date: '2026-07-05' },
  { id: 'SVC-006', title: 'Laptop battery replacement request', status: 'Resolved', assignedTo: 'Jordan Lee', priority: 'P4', date: '2026-07-04' },
  { id: 'SVC-007', title: 'SSO login loop for marketing tools', status: 'Open', assignedTo: 'Alex Rivera', priority: 'P2', date: '2026-07-09' },
  { id: 'SVC-008', title: 'Onboarding access for Morgan Chen', status: 'Resolved', assignedTo: 'Alex Rivera', priority: 'P4', date: '2026-07-03' },
];

// ---------------------------------------------------------------------------
// Route handlers
// ---------------------------------------------------------------------------

// GET /login — redirect to Google OAuth
function handleLogin(req, res) {
  const state = createOAuthState();
  const params = new URLSearchParams({
    client_id: GOOGLE_CLIENT_ID,
    redirect_uri: OAUTH_REDIRECT_URI,
    response_type: 'code',
    scope: OAUTH_SCOPES,
    state,
    access_type: 'online',
    prompt: 'select_account',
  });

  const loginHtml = `<!DOCTYPE html>
<html lang="en">
<head>
  <meta charset="UTF-8">
  <meta name="viewport" content="width=device-width, initial-scale=1.0">
  <title>Sign In — Service Portal</title>
  <link rel="preconnect" href="https://fonts.googleapis.com">
  <link href="https://fonts.googleapis.com/css2?family=Inter:wght@400;500;600&display=swap" rel="stylesheet">
  <style>
    *, *::before, *::after { box-sizing: border-box; margin: 0; padding: 0; }
    body {
      font-family: Inter, -apple-system, BlinkMacSystemFont, 'Segoe UI', Arial, sans-serif;
      background: #0d1117;
      color: #f0f6fc;
      min-height: 100vh;
      display: flex;
      flex-direction: column;
    }
    .login-container {
      flex: 1;
      display: flex;
      align-items: center;
      justify-content: center;
      padding: 20px;
    }
    main {
      width: min(420px, calc(100vw - 32px));
      padding: 40px;
      border: 1px solid rgba(240,246,252,.12);
      border-radius: 12px;
      background: #161b22;
      text-align: center;
    }
    .logo {
      margin-bottom: 28px;
      display: flex;
      align-items: center;
      justify-content: center;
      gap: 12px;
    }
    .logo-icon {
      height: 48px;
      width: auto;
      display: block;
      flex-shrink: 0;
      filter: brightness(0) invert(1);
    }
    .logo-text {
      text-align: left;
    }
    .logo-name {
      font-size: 15px;
      font-weight: 600;
      color: #f0f6fc;
      line-height: 1.2;
    }
    .logo-sub {
      font-size: 11px;
      color: #8b949e;
      margin-top: 2px;
    }
    h1 { font-size: 22px; font-weight: 600; margin-bottom: 8px; color: #f0f6fc; }
    .subtitle { margin: 0 0 32px; color: #8b949e; font-size: 14px; line-height: 1.5; }
    .btn-google {
      display: inline-flex; align-items: center; justify-content: center; gap: 10px;
      min-height: 48px; padding: 0 24px;
      border-radius: 6px;
      background: #238636; color: #fff;
      text-decoration: none;
      font-family: Inter, sans-serif;
      font-weight: 600; font-size: 15px;
      width: 100%;
      transition: background 0.2s;
    }
    .btn-google:hover { background: #2ea043; }
    .btn-google svg { flex-shrink: 0; }
    .note { margin-top: 20px; font-size: 12px; color: #8b949e; }
    footer {
      padding: 20px;
      text-align: center;
      color: #8b949e;
      font-size: 12px;
      border-top: 1px solid rgba(240,246,252,.08);
      font-family: Inter, sans-serif;
    }
    .footer-inner {
      display: flex; align-items: center; justify-content: center; gap: 8px;
    }
    .footer-logo-icon {
      height: 16px;
      width: auto;
      opacity: 0.7;
    }
  </style>
</head>
<body>
  <div class="login-container">
    <main>
      <div class="logo">
        <img class="logo-icon" src="/sycamore-logo.png" alt="Sycamore Informatics">
        <div class="logo-text">
          <div class="logo-name">Sycamore Informatics</div>
          <div class="logo-sub">Service Operations Portal</div>
        </div>
      </div>
      <h1>Service Portal</h1>
      <p class="subtitle">Sign in with your ${ALLOWED_DOMAIN} Google account to continue.</p>
      <a href="${OAUTH_AUTH_URL}?${params.toString()}" class="btn-google">
        <svg width="20" height="20" viewBox="0 0 24 24" fill="currentColor"><path d="M12.545,10.239v3.821h5.445c-0.712,2.315-2.647,3.972-5.445,3.972c-3.332,0-6.033-2.701-6.033-6.032s2.701-6.032,6.033-6.032c1.498,0,2.866,0.549,3.921,1.453l2.814-2.814C17.503,2.988,15.139,2,12.545,2C7.021,2,2.543,6.477,2.543,12s4.478,10,10.002,10c8.396,0,10.249-7.85,9.426-11.748L12.545,10.239z"/></svg>
        Sign in with Google
      </a>
      <p class="note">Access restricted to @${ALLOWED_DOMAIN} accounts.</p>
    </main>
  </div>
  <footer>
    <div class="footer-inner">
      <span>Powered by</span>
      <img class="footer-logo-icon" src="/sycamore-logo.png" alt="Sycamore Informatics">
      <span>Sycamore Informatics</span>
    </div>
  </footer>
</body>
</html>`;

  sendText(res, 200, loginHtml, 'text/html; charset=utf-8');
}

// GET /oauth2/callback — exchange code for token, create session
async function handleOAuthCallback(req, res, searchParams) {
  const code = searchParams.get('code');
  const state = searchParams.get('state');
  const error = searchParams.get('error');

  if (error) {
    return sendText(res, 400, `OAuth error: ${error}`);
  }

  if (!code || !state || !validateOAuthState(state)) {
    return sendRedirect(res, '/login');
  }

  // Exchange code for tokens
  const tokenBody = new URLSearchParams({
    code,
    client_id: GOOGLE_CLIENT_ID,
    client_secret: GOOGLE_CLIENT_SECRET,
    redirect_uri: OAUTH_REDIRECT_URI,
    grant_type: 'authorization_code',
  }).toString();

  let tokenResp;
  try {
    tokenResp = await httpsRequest(
      {
        hostname: 'oauth2.googleapis.com',
        path: '/token',
        method: 'POST',
        headers: {
          'Content-Type': 'application/x-www-form-urlencoded',
          'Content-Length': Buffer.byteLength(tokenBody),
        },
      },
      tokenBody
    );
  } catch (err) {
    console.error('Token exchange error:', err);
    return sendRedirect(res, '/login?error=token_exchange');
  }

  if (tokenResp.status !== 200 || !tokenResp.body.access_token) {
    console.error('Token exchange failed:', tokenResp.body);
    return sendRedirect(res, '/login?error=token_failed');
  }

  const accessToken = tokenResp.body.access_token;

  // Fetch user info
  let userResp;
  try {
    userResp = await httpsRequest({
      hostname: 'www.googleapis.com',
      path: '/oauth2/v3/userinfo',
      method: 'GET',
      headers: { Authorization: `Bearer ${accessToken}` },
    });
  } catch (err) {
    console.error('Userinfo error:', err);
    return sendRedirect(res, '/login?error=userinfo');
  }

  if (userResp.status !== 200 || !userResp.body.email) {
    return sendRedirect(res, '/login?error=userinfo_failed');
  }

  const user = userResp.body;
  const emailDomain = (user.email || '').split('@')[1] || '';
  const allowed = ALLOWED_DOMAIN;

  if (emailDomain !== allowed) {
    return sendText(
      res, 403,
      `Access denied. Only @${allowed} accounts are permitted.`
    );
  }

  const sessionId = createSession({
    name: user.name || user.email,
    email: user.email,
    picture: user.picture || '',
    sub: user.sub,
  });

  setSessionCookie(res, sessionId);
  sendRedirect(res, '/');
}

// GET /logout
function handleLogout(req, res) {
  const cookies = parseCookies(req);
  const sessionId = cookies[SESSION_COOKIE_NAME];
  if (sessionId) deleteSession(sessionId);
  clearSessionCookie(res);
  sendRedirect(res, '/login');
}

// GET /api/me
function handleApiMe(req, res) {
  const auth = resolveUser(req);
  if (!auth) return sendJSON(res, 401, { error: 'Unauthorized' });
  const { name, email, picture } = auth.user;
  sendJSON(res, 200, { name, email, picture });
}

// GET /api/cases
function handleApiCases(req, res) {
  const auth = resolveUser(req);
  if (!auth) return sendJSON(res, 401, { error: 'Unauthorized' });
  sendJSON(res, 200, MOCK_CASES);
}

// GET /api/stats
function handleApiStats(req, res) {
  const auth = resolveUser(req);
  if (!auth) return sendJSON(res, 401, { error: 'Unauthorized' });

  const open = MOCK_CASES.filter(c => c.status === 'Open').length;
  const inProgress = MOCK_CASES.filter(c => c.status === 'In Progress').length;
  const resolved = MOCK_CASES.filter(c => c.status === 'Resolved').length;
  const totalStaff = config.staff ? config.staff.length : 0;

  sendJSON(res, 200, { open, inProgress, resolved, totalStaff });
}

// GET /api/wiki/* — serve raw markdown
function handleApiWiki(req, res, wikiPath) {
  const auth = resolveUser(req);
  if (!auth) return sendJSON(res, 401, { error: 'Unauthorized' });

  // Sanitize path — no traversal
  const safe = path.normalize(wikiPath).replace(/^(\.\.(\/|\\|$))+/, '');
  const filePath = path.join(__dirname, 'wiki', safe);

  // Must stay inside wiki/
  if (!filePath.startsWith(path.join(__dirname, 'wiki'))) {
    return sendJSON(res, 403, { error: 'Forbidden' });
  }

  if (!fs.existsSync(filePath)) {
    return sendJSON(res, 404, { error: 'Article not found' });
  }

  try {
    const content = fs.readFileSync(filePath, 'utf-8');
    sendText(res, 200, content, 'text/plain; charset=utf-8');
  } catch {
    sendJSON(res, 500, { error: 'Could not read article' });
  }
}

// GET /api/customers — get all customer data
async function handleApiCustomers(req, res) {
  const auth = resolveUser(req);
  if (!auth) return sendJSON(res, 401, { error: 'Unauthorized' });

  try {
    const customerData = await getCustomerDataFromDrive();
    const customers = Object.keys(customerData).map(name => ({
      name,
      dataCount: customerData[name].length,
      lastUpdated: Math.max(...customerData[name].map(d => new Date(d.modifiedTime).getTime()))
    }));

    sendJSON(res, 200, { customers });
  } catch (error) {
    console.error('Error fetching customers:', error);

    // Return fallback data structure to prevent frontend errors
    const fallbackCustomers = ['AbbVie', 'Alcon', 'Ascendis', 'BMS', 'Otsuka', 'PMI', 'Zealand'];
    const customers = fallbackCustomers.map(name => ({
      name,
      dataCount: 0,
      lastUpdated: Date.now(),
      error: true
    }));

    sendJSON(res, 200, { customers, warning: 'Drive API unavailable, showing fallback data' });
  }
}

// GET /api/customers/:name — get specific customer data
async function handleApiCustomerDetails(req, res, customerName) {
  const auth = resolveUser(req);
  if (!auth) return sendJSON(res, 401, { error: 'Unauthorized' });

  try {
    const customerData = await getCustomerDataFromDrive();
    const decodedCustomerName = decodeURIComponent(customerName);

    if (!customerData[decodedCustomerName]) {
      return sendJSON(res, 200, {
        customerName: decodedCustomerName,
        files: [],
        totalFiles: 0,
        message: 'No files found for this customer'
      });
    }

    const data = customerData[decodedCustomerName];

    // Sort by creation time, newest first
    data.sort((a, b) => new Date(b.createdTime) - new Date(a.createdTime));

    // Extract customer-specific slides from each file
    const filesWithCustomerSlides = data.map(file => {
      const customerSlide = file.slides ? findCustomerSlide(file.slides, decodedCustomerName) : null;

      return {
        ...file,
        customerSlide: customerSlide,
        hasCustomerSlide: !!customerSlide,
        slideText: customerSlide ? customerSlide.textContent : null,
        weekName: file.fileName.replace('.pptx', '').replace('.ppt', ''), // Use filename as week name
        slideImageUrl: customerSlide ? `/api/slide-image/${file.fileId}/${customerSlide.slideNumber}` : null
      };
    }).filter(file => file.hasCustomerSlide || !file.slides); // Include files that have customer slides or no slides extracted

    console.log(`Found ${filesWithCustomerSlides.length} files with customer slides for ${decodedCustomerName}`);

    // Organize by weeks for dropdown
    const weeks = filesWithCustomerSlides.map(file => ({
      id: file.fileId,
      name: file.weekName,
      fileName: file.fileName,
      createdTime: file.createdTime,
      week: file.week
    }));

    sendJSON(res, 200, {
      customerName: decodedCustomerName,
      files: filesWithCustomerSlides,
      weeks: weeks,
      totalFiles: filesWithCustomerSlides.length,
      mostRecentWeek: weeks.length > 0 ? weeks[0] : null
    });
  } catch (error) {
    console.error(`Error fetching data for customer ${customerName}:`, error);

    // Return empty state instead of 500 error
    sendJSON(res, 200, {
      customerName: decodeURIComponent(customerName),
      files: [],
      totalFiles: 0,
      error: true,
      message: `Drive API unavailable: ${error.message}`
    });
  }
}

// GET /healthz
function handleHealthz(req, res) {
  sendJSON(res, 200, { status: 'ok' });
}

// GET /api/drive-debug — debug Google Drive API setup
async function handleDriveDebug(req, res) {
  const auth = resolveUser(req);
  if (!auth) return sendJSON(res, 401, { error: 'Unauthorized' });

  const debug = {
    timestamp: new Date().toISOString(),
    driveFolder: DRIVE_FOLDER_ID,
    environment: process.env.NODE_ENV || 'development',
    hasGoogleAuth: !!google.auth,
    tests: []
  };

  // Test 1: Check if we can initialize auth
  try {
    const authClient = await getDriveAuth();
    debug.tests.push({
      name: 'Auth Initialization',
      status: 'success',
      message: 'Google auth initialized successfully'
    });

    // Test 2: Get the service account email
    try {
      const client = await authClient.getClient();
      const credentials = await authClient.getCredentials();
      debug.serviceAccountEmail = credentials.client_email || 'Unknown';
      debug.tests.push({
        name: 'Service Account Info',
        status: 'success',
        message: `Using service account: ${debug.serviceAccountEmail}`
      });
    } catch (credError) {
      debug.tests.push({
        name: 'Service Account Info',
        status: 'warning',
        message: `Could not get service account info: ${credError.message}`
      });
    }

    // Test 3: Try to access Drive API
    try {
      const drive = await getDriveService();
      debug.tests.push({
        name: 'Drive API Service',
        status: 'success',
        message: 'Drive API service created successfully'
      });

      // Test 4: Test folder access
      try {
        const folderInfo = await drive.files.get({
          fileId: DRIVE_FOLDER_ID,
          fields: 'id, name, owners, permissions'
        });

        debug.tests.push({
          name: 'Folder Access',
          status: 'success',
          message: `Successfully accessed folder: ${folderInfo.data.name}`
        });

        debug.folderInfo = {
          id: folderInfo.data.id,
          name: folderInfo.data.name,
          owners: folderInfo.data.owners
        };

      } catch (folderError) {
        debug.tests.push({
          name: 'Folder Access',
          status: 'error',
          message: `Cannot access folder: ${folderError.message}`,
          code: folderError.code,
          details: folderError.errors
        });
      }

    } catch (driveError) {
      debug.tests.push({
        name: 'Drive API Service',
        status: 'error',
        message: `Drive API service failed: ${driveError.message}`
      });
    }

  } catch (authError) {
    debug.tests.push({
      name: 'Auth Initialization',
      status: 'error',
      message: `Auth failed: ${authError.message}`
    });
  }

  sendJSON(res, 200, debug);
}

// GET /api/slide-image/:fileId/:slideNumber — serve slide as image
async function handleSlideImage(req, res, slideParams) {
  const auth = resolveUser(req);
  if (!auth) return sendJSON(res, 401, { error: 'Unauthorized' });

  try {
    const [fileId, slideNumber] = slideParams.split('/');

    if (!fileId || !slideNumber) {
      return sendJSON(res, 400, { error: 'Invalid parameters' });
    }

    console.log(`Generating slide image for file ${fileId}, slide ${slideNumber}`);

    const drive = await getDriveService();
    const slideImageData = await generateSlideImage(drive, fileId, parseInt(slideNumber));

    if (slideImageData) {
      // Serve the image with proper headers
      res.writeHead(200, {
        'Content-Type': slideImageData.mimeType || 'image/svg+xml',
        'Content-Length': slideImageData.data.length,
        'Cache-Control': 'public, max-age=3600', // Cache for 1 hour
        'X-Frame-Options': 'SAMEORIGIN', // Allow same-origin framing
        'Access-Control-Allow-Origin': '*' // Allow cross-origin requests
      });
      res.end(slideImageData.data);
    } else {
      // Return a placeholder SVG
      const customerName = req.headers.referer ?
        decodeURIComponent(req.headers.referer.split('/').pop()) : 'Customer';
      const placeholder = await createPlaceholderSlideImage(parseInt(slideNumber), customerName);
      res.writeHead(200, {
        'Content-Type': 'image/svg+xml',
        'Content-Length': placeholder.data.length,
        'Cache-Control': 'no-cache'
      });
      res.end(placeholder.data);
    }

  } catch (error) {
    console.error('Error serving slide image:', error);
    sendJSON(res, 500, { error: 'Failed to serve slide image' });
  }
}

async function generateSlideImage(drive, fileId, slideNumber) {
  try {
    // Method 1: Try to convert PowerPoint to Google Slides and get thumbnail
    console.log(`Attempting to generate image for slide ${slideNumber}`);

    // Copy the PowerPoint file to Google Slides format
    const copiedFile = await drive.files.copy({
      fileId: fileId,
      requestBody: {
        name: `temp_slides_${Date.now()}`,
        mimeType: 'application/vnd.google-apps.presentation'
      }
    });

    if (copiedFile.data.id) {
      try {
        // Try to export as PDF first, then convert individual pages
        const pdfData = await drive.files.export({
          fileId: copiedFile.data.id,
          mimeType: 'application/pdf'
        }, { responseType: 'stream' });

        const pdfBuffer = await streamToBuffer(pdfData.data);

        // Clean up the temporary file
        await drive.files.delete({ fileId: copiedFile.data.id }).catch(() => {});

        return {
          data: pdfBuffer,
          mimeType: 'application/pdf'
        };

      } catch (exportError) {
        console.warn('Could not export slides as PDF:', exportError.message);

        // Clean up the temporary file
        await drive.files.delete({ fileId: copiedFile.data.id }).catch(() => {});
      }
    }

    // Method 2: Fallback to creating a placeholder image with slide info
    console.log(`Using placeholder for slide ${slideNumber}`);
    return await createPlaceholderSlideImage(slideNumber);

  } catch (error) {
    console.error(`Error generating slide image:`, error.message);
    return await createPlaceholderSlideImage(slideNumber);
  }
}

function streamToBuffer(stream) {
  return new Promise((resolve, reject) => {
    const chunks = [];
    stream.on('data', chunk => chunks.push(chunk));
    stream.on('end', () => resolve(Buffer.concat(chunks)));
    stream.on('error', reject);
  });
}

async function createPlaceholderSlideImage(slideNumber, customerName = 'Customer') {
  // Create a PowerPoint-style SVG placeholder
  const svgContent = `
    <svg width="1280" height="720" xmlns="http://www.w3.org/2000/svg">
      <!-- Background -->
      <rect width="1280" height="720" fill="#ffffff"/>

      <!-- Blue header bar -->
      <rect width="1280" height="80" fill="#4A90E2"/>

      <!-- Customer title -->
      <text x="60" y="140" font-family="Calibri, Arial, sans-serif" font-size="48" font-weight="bold" fill="#4A90E2">
        ${customerName}
      </text>

      <!-- Subtitle -->
      <text x="60" y="190" font-family="Calibri, Arial, sans-serif" font-size="18" fill="#2E8B57">
        Customer Sentiment - Good
      </text>

      <!-- Content placeholder -->
      <rect x="60" y="240" width="1160" height="400" fill="#F8F9FA" stroke="#E1E5E9" stroke-width="2" rx="8"/>

      <!-- Content text -->
      <text x="640" y="400" text-anchor="middle" font-family="Calibri, Arial, sans-serif" font-size="24" fill="#666666">
        Slide ${slideNumber} - ${customerName} Details
      </text>
      <text x="640" y="440" text-anchor="middle" font-family="Calibri, Arial, sans-serif" font-size="16" fill="#888888">
        PowerPoint content will appear here once image conversion is complete
      </text>

      <!-- Footer -->
      <text x="60" y="690" font-family="Calibri, Arial, sans-serif" font-size="12" fill="#999999">
        Confidential and Proprietary © Sycamore Informatics, Inc. 2026
      </text>
      <text x="1220" y="690" text-anchor="end" font-family="Calibri, Arial, sans-serif" font-size="12" fill="#999999">
        Slide ${slideNumber}
      </text>
    </svg>
  `;

  return {
    data: Buffer.from(svgContent),
    mimeType: 'image/svg+xml'
  };
}

// GET / — serve index.html (auth-gated)
function handleIndex(req, res) {
  const auth = resolveUser(req);
  if (!auth) return sendRedirect(res, '/login');
  sendFile(res, path.join(__dirname, 'index.html'));
}

// Fallback static file server
function handleStatic(req, res, urlPath) {
  // Never serve .env or sensitive files
  if (/\.(env|secret|key)$/i.test(urlPath)) {
    return sendJSON(res, 403, { error: 'Forbidden' });
  }

  const safe = path.normalize(urlPath).replace(/^(\.\.(\/|\\|$))+/, '');
  const filePath = path.join(__dirname, safe);

  // Must stay within project root
  if (!filePath.startsWith(__dirname)) {
    return sendJSON(res, 403, { error: 'Forbidden' });
  }

  if (!fs.existsSync(filePath) || fs.statSync(filePath).isDirectory()) {
    return sendJSON(res, 404, { error: 'Not found' });
  }

  sendFile(res, filePath);
}

// ---------------------------------------------------------------------------
// Main request handler
// ---------------------------------------------------------------------------
async function requestHandler(req, res) {
  const parsedUrl = new URL(req.url, `http://localhost:${PORT}`);
  const pathname = parsedUrl.pathname;
  const method = req.method.toUpperCase();

  // CORS headers for API calls (same-origin in production, useful in dev)
  res.setHeader('X-Content-Type-Options', 'nosniff');
  res.setHeader('X-Frame-Options', 'DENY');

  if (method !== 'GET' && method !== 'HEAD') {
    return sendJSON(res, 405, { error: 'Method not allowed' });
  }

  try {
    if (pathname === '/login') return handleLogin(req, res);
    if (pathname === '/oauth2/callback') return await handleOAuthCallback(req, res, parsedUrl.searchParams);
    if (pathname === '/logout') return handleLogout(req, res);
    if (pathname === '/healthz') return handleHealthz(req, res);
    if (pathname === '/api/drive-debug') return await handleDriveDebug(req, res);
    if (pathname.startsWith('/api/slide-image/')) {
      const slideParams = pathname.slice('/api/slide-image/'.length);
      return await handleSlideImage(req, res, slideParams);
    }
    if (pathname === '/api/me') return handleApiMe(req, res);
    if (pathname === '/api/cases') return handleApiCases(req, res);
    if (pathname === '/api/stats') return handleApiStats(req, res);
    if (pathname === '/api/customers') return await handleApiCustomers(req, res);
    if (pathname.startsWith('/api/customers/')) {
      const customerName = pathname.slice('/api/customers/'.length);
      return await handleApiCustomerDetails(req, res, customerName);
    }
    if (pathname.startsWith('/api/wiki/')) {
      const wikiFile = pathname.slice('/api/wiki/'.length);
      return handleApiWiki(req, res, wikiFile);
    }
    if (pathname === '/' || pathname === '/index.html') return handleIndex(req, res);

    // Static file fallback
    return handleStatic(req, res, pathname);
  } catch (err) {
    console.error('Unhandled error for', pathname, err);
    sendJSON(res, 500, { error: 'Internal server error' });
  }
}

// ---------------------------------------------------------------------------
// Exports for testing
// ---------------------------------------------------------------------------
export { requestHandler };

export function createTestSession(user) {
  return createSession(user);
}

// ---------------------------------------------------------------------------
// Start server (only when run directly, not imported by tests)
// ---------------------------------------------------------------------------
const isMain = process.argv[1] === fileURLToPath(import.meta.url);
if (isMain) {
  const server = http.createServer(requestHandler);

  server.listen(PORT, () => {
    console.log(`Service Portal running on http://localhost:${PORT}`);
    console.log(`Allowed domain: ${config.allowedDomain || ALLOWED_DOMAIN}`);
    console.log(`OAuth redirect: ${OAUTH_REDIRECT_URI}`);
    if (!GOOGLE_CLIENT_ID) {
      console.warn('Warning: GOOGLE_CLIENT_ID is not set. OAuth will not work.');
    }
  });

  server.on('error', (err) => {
    console.error('Server error:', err);
    process.exit(1);
  });
}
